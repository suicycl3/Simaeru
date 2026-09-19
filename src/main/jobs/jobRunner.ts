import fs from 'node:fs/promises';
import path from 'node:path';
import type { FlacOriginal, JobRow, PostProcessSettings, ToolStatus, ArchiveHandling, ArchiveWorkType, PdfStripType } from '@shared/types';
import { decideStorage, hasExecutable, STORE_EXTS, archiveWorkType, pdfStripType } from '@shared/storagePolicy';
import { planLossyOnly, planPdfStrip } from '@shared/contentRules';
import { ARCHIVE_WORK_TYPES, PDF_STRIP_TYPES } from '@shared/types';
import type { Repo } from '../db/repo';
import {
  extractArchive,
  extractFolderName,
  isAccessDenied,
  isArchiveFile,
  packZip,
  splitInfo,
  testArchive
} from '../archive/sevenZip';
import { listArchiveEntries } from '../archive/archiveAccess';
import { readZipIndex } from '../archive/zipReader';
import { convertTarget, estimateFlac, moveInto } from '../media/flac';
import { moveItem } from '../download/relocate';
import { retryTransient } from '../fsRetry';
import { safeReplace } from '../safeReplace';
import type { RelocationItem } from '@shared/types';
import { clearToolCache, toolStatus } from '../tools/externalTools';
import { t } from '@shared/i18n';

/**
 * ダウンロードのあとの処理（展開・FLAC 変換）のキュー。**1本ずつ**順に進める。
 * どちらもディスクを激しく使うので、並べて走らせても速くならない。
 *
 * 保存の決まり（@shared/storagePolicy）:
 * - ゲーム・ツール … 展開して使う。展開が済んだらアーカイブを消す（設定で残せる）
 * - それ以外 … 圧縮のまま持ち、展開せずに閲覧・再生する。FLAC 化は「中の WAV を差し替えて zip を作り直す」
 *
 * 途中で落ちても壊れた成果物を「完了」に見せないよう、どれも作業用の名前で作ってから名前を変える。
 * ファイル操作はすべて非同期（同期で開くと Defender の検査中にメインプロセスが止まる）。
 */

const KEYS = {
  autoExtract: 'post.autoExtract',
  deleteArchiveAfterExtract: 'post.deleteArchiveAfterExtract',
  autoFlac: 'post.autoFlac',
  lossyOnly: 'post.lossyOnly',
  stripPdfTypes: 'post.stripPdfTypes',
  archiveHandling: 'post.archiveHandling',
  flacMinBytes: 'post.flacMinBytes',
  flacOriginal: 'post.flacOriginal',
  sevenZipPath: 'tools.sevenZip',
  ffmpegPath: 'tools.ffmpeg',
  neeviewPath: 'viewer.neeview'
} as const;

const DEFAULT_FLAC_MIN = 200 * 1024 * 1024;

function readJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
const EXTRACTING = '.extracting';

export interface JobRunnerOptions {
  repo: Repo;
  onProgress: (rows: JobRow[]) => void;
  /** 台帳が変わった（展開でフォルダが増えた等）ことを画面に知らせる */
  onLocalFilesChanged: (productRef: number | null) => void;
  trashItem: (p: string) => Promise<void>;
  freeBytes: (dir: string) => number | null;
  /** 外部ツールに書かせる作業フォルダ（保護フォルダの外） */
  workDir: string;
  /** 同梱ツールの置き場所（設定画面から入れたもの） */
  toolsDir?: string;
}

export interface ExtractOptions {
  /** 展開が済んだらアーカイブを消す */
  deleteArchive?: boolean;
  /** 圧縮したまま持つ作品でも消す（「圧縮したまま持つ作品も展開する」設定で、消すと決めたとき） */
  archivedToo?: boolean;
}

async function exists(p: string): Promise<boolean> {
  return retryTransient(() => fs.access(p))
    .then(() => true)
    .catch(() => false);
}

/** 要らないファイルを消すジョブの決まり（何を消すか・知らせる文言） */
interface PruneRule {
  plan: (files: Array<{ path: string; size: number }>) => { remove: Array<{ path: string; size: number }>; kept: string[] };
  /** 台帳の出どころ（作り直した zip に付ける） */
  source: string;
  none: () => string;
  done: (removed: number, kept: number, zip: boolean, savedMb: string) => string;
}

const LOSSY_RULE: PruneRule = {
  plan: planLossyOnly,
  source: 'lossy',
  none: () => t('消せる WAV / FLAC はありませんでした'),
  done: (removed, kept, zip, savedMb) =>
    t('WAV / FLAC を {removed} 件削除{1}・{2} MB 削減{3}', { removed, 1: zip ? t('・zip を作り直し') : '', 2: savedMb, 3: kept ? t('（MP3 などが見つからない {kept} 件は残しました）', { kept }) : '' })
};

const PDF_RULE: PruneRule = {
  plan: planPdfStrip,
  source: 'pdf',
  none: () => t('消せる PDF はありませんでした'),
  done: (removed, kept, zip, savedMb) =>
    t('PDF を {removed} 件削除{1}・{2} MB 削減{3}', { removed, 1: zip ? t('・zip を作り直し') : '', 2: savedMb, 3: kept ? t('（おまけなど別の内容らしい PDF {kept} 件は残しました）', { kept }) : '' })
};

export class JobRunner {
  private running: { id: number; controller: AbortController } | null = null;
  private pumping = false;
  /** 作り直し・FLAC 化が済んだら展開する作品（圧縮したまま持つ作品も展開する設定のとき） */
  private extractAfter = new Set<number>();
  private lastNotify = 0;

  constructor(private opts: JobRunnerOptions) {}

  // ── 設定 ───────────────────────────────────────────────
  settings(): PostProcessSettings {
    const r = this.opts.repo;
    const flag = (key: string, fallback: boolean): boolean => {
      const v = r.getSetting(key);
      return v === null ? fallback : v === '1';
    };
    const original = r.getSetting(KEYS.flacOriginal) as FlacOriginal | null;
    const minRaw = r.getSetting(KEYS.flacMinBytes);
    const min = Number(minRaw);
    return {
      // ゲームは展開しないと使えないので、既定で展開する
      autoExtract: flag(KEYS.autoExtract, true),
      deleteArchiveAfterExtract: flag(KEYS.deleteArchiveAfterExtract, true),
      // WAV のままだと大きいので、既定で FLAC にする（音は変わらない）
      autoFlac: flag(KEYS.autoFlac, true),
      lossyOnly: flag(KEYS.lossyOnly, false),
      stripPdfTypes: readJson<string[]>(r.getSetting(KEYS.stripPdfTypes), []).filter((x): x is PdfStripType =>
        PDF_STRIP_TYPES.includes(x as PdfStripType)
      ),
      // 既定は圧縮したまま持つ（展開せずに読める。ファイル数が数百〜数千になるものを散らかさない）
      archiveHandling: Object.fromEntries(
        ARCHIVE_WORK_TYPES.map((w) => {
          const v = readJson<Record<string, string>>(r.getSetting(KEYS.archiveHandling), {})[w];
          return [w, v === 'extract' || v === 'extractDelete' ? v : 'archive'];
        })
      ) as Record<ArchiveWorkType, ArchiveHandling>,
      flacMinBytes: minRaw !== null && Number.isFinite(min) && min >= 0 ? min : DEFAULT_FLAC_MIN,
      flacOriginal: original === 'delete' || original === 'keep' ? original : 'trash',
      sevenZipPath: r.getSetting(KEYS.sevenZipPath) ?? '',
      ffmpegPath: r.getSetting(KEYS.ffmpegPath) ?? '',
      neeviewPath: r.getSetting(KEYS.neeviewPath) ?? ''
    };
  }

  saveSettings(next: Partial<PostProcessSettings>): PostProcessSettings {
    const r = this.opts.repo;
    const bool = (key: string, v: boolean | undefined): void => {
      if (v !== undefined) r.setSetting(key, v ? '1' : '0');
    };
    bool(KEYS.autoExtract, next.autoExtract);
    bool(KEYS.deleteArchiveAfterExtract, next.deleteArchiveAfterExtract);
    bool(KEYS.autoFlac, next.autoFlac);
    bool(KEYS.lossyOnly, next.lossyOnly);
    if (next.stripPdfTypes !== undefined) r.setSetting(KEYS.stripPdfTypes, JSON.stringify(next.stripPdfTypes));
    if (next.archiveHandling !== undefined) {
      r.setSetting(KEYS.archiveHandling, JSON.stringify({ ...this.settings().archiveHandling, ...next.archiveHandling }));
    }
    if (next.flacMinBytes !== undefined) r.setSetting(KEYS.flacMinBytes, String(Math.max(0, next.flacMinBytes)));
    if (next.flacOriginal !== undefined) r.setSetting(KEYS.flacOriginal, next.flacOriginal);
    if (next.sevenZipPath !== undefined) r.setSetting(KEYS.sevenZipPath, next.sevenZipPath);
    if (next.ffmpegPath !== undefined) r.setSetting(KEYS.ffmpegPath, next.ffmpegPath);
    if (next.neeviewPath !== undefined) r.setSetting(KEYS.neeviewPath, next.neeviewPath);
    if (next.sevenZipPath !== undefined || next.ffmpegPath !== undefined || next.neeviewPath !== undefined) clearToolCache();
    return this.settings();
  }

  tools(): ToolStatus {
    return toolStatus(this.settings(), this.opts.toolsDir);
  }

  // ── 積む ───────────────────────────────────────────────
  enqueueExtract(productRef: number | null, archive: string, auto = false, options?: ExtractOptions): number {
    const id = this.opts.repo.addJob({ productRef, kind: 'extract', source: archive, auto, options: options ?? {} });
    this.notify(true);
    this.pump();
    return id;
  }

  /** 保存先・フォルダ構成の変更に合わせて、手元のファイルを移す（1つのジョブで順に） */
  enqueueMove(items: RelocationItem[], roots: string[]): number {
    const id = this.opts.repo.addJob({
      productRef: null,
      kind: 'move',
      source: t('移動 {length} 件', { length: items.length }),
      options: { items, roots }
    });
    this.notify(true);
    this.pump();
    return id;
  }

  enqueueFlac(productRef: number | null, target: string, original?: FlacOriginal, auto = false): number {
    const id = this.opts.repo.addJob({
      productRef,
      kind: 'flac',
      source: target,
      auto,
      options: { original: original ?? this.settings().flacOriginal }
    });
    this.notify(true);
    this.pump();
    return id;
  }

  /**
   * MP3 などが同梱されている WAV / FLAC を消して、MP3 などだけ残す。
   * アーカイブなら zip を作り直し、展開したフォルダならファイルを消す（元の扱いは FLAC の設定に従う）。
   * thenFlac: 消したあとに残った WAV を FLAC にする（自動処理のとき）
   */
  /**
   * CG 集などで、画像と同じ内容の PDF（スマホ向けなど）を消す。アーカイブなら zip を作り直す。
   */
  enqueueStripPdf(productRef: number | null, target: string, original?: FlacOriginal, auto = false): number {
    const id = this.opts.repo.addJob({
      productRef,
      kind: 'pdf',
      source: target,
      auto,
      options: { original: original ?? this.settings().flacOriginal }
    });
    this.notify(true);
    this.pump();
    return id;
  }

  enqueueLossyOnly(productRef: number | null, target: string, original?: FlacOriginal, auto = false, thenFlac = false): number {
    const id = this.opts.repo.addJob({
      productRef,
      kind: 'lossy',
      source: target,
      auto,
      options: { original: original ?? this.settings().flacOriginal, thenFlac }
    });
    this.notify(true);
    this.pump();
    return id;
  }

  /**
   * ダウンロードが1本終わるたびに呼ばれる。
   * 分割ファイルの途中で動き出さないよう、**その作品のダウンロードが全部終わってから**判断する。
   * - 展開して使うもの → 展開（済んだらアーカイブを消す。設定しだい）
   * - 圧縮のまま持つもの → WAV が多ければ FLAC 化して zip を作り直す（設定しだい）
   */
  async onDownloadFinished(productRef: number): Promise<void> {
    const s = this.settings();
    const pending = this.opts.repo
      .listDownloads()
      .some((d) => d.productRef === productRef && ['queued', 'running', 'paused'].includes(d.state));
    if (pending) return;
    const product = this.opts.repo.getProduct(productRef);
    if (!product) return;
    for (const f of this.opts.repo.localFiles(productRef)) {
      if (f.missingAt || !isArchiveFile(f.path)) continue;
      if (this.opts.repo.extractedFrom(f.path)) continue;
      let listing;
      try {
        listing = await listArchiveEntries(f.path, this.tools().sevenZip);
      } catch {
        continue;
      }
      const files = listing.entries.filter((e) => !e.isDir);
      const decision = decideStorage(product, { hasExecutable: hasExecutable(files.map((e) => e.path)) });
      if (decision.mode === 'extract') {
        if (s.autoExtract) this.enqueueExtract(productRef, f.path, true, { deleteArchive: s.deleteArchiveAfterExtract });
      } else {
        // 画像と同じ内容の PDF（スマホ向けなど）を消す。同人の CG・マンガで、その種別を選んでいるときだけ
        const pdfType = pdfStripType(product);
        if (
          pdfType &&
          s.stripPdfTypes.includes(pdfType) &&
          this.tools().sevenZip &&
          planPdfStrip(files.map((e) => ({ path: e.path, size: e.size }))).remove.length > 0
        ) {
          this.enqueueStripPdf(productRef, f.path, s.flacOriginal, true);
        }
        // その種別を「展開して使う」にしているなら、作り直し・FLAC 化がすべて済んでから展開する
        if (s.archiveHandling[archiveWorkType(product)] !== 'archive') this.extractAfter.add(productRef);
        // MP3 なども入っているなら、WAV / FLAC を消して軽くする（設定しだい）。残った WAV はそのあと FLAC にする
        const lossy = s.lossyOnly ? planLossyOnly(files.map((e) => ({ path: e.path, size: e.size }))) : null;
        if (lossy && lossy.remove.length > 0 && this.tools().sevenZip) {
          const removed = new Set(lossy.remove.map((r) => r.path));
          const restWav = files.filter((e) => /\.wav$/i.test(e.path) && !removed.has(e.path)).reduce((sum, e) => sum + e.size, 0);
          this.enqueueLossyOnly(productRef, f.path, s.flacOriginal, true, s.autoFlac && restWav > 0 && restWav >= s.flacMinBytes);
        } else if (s.autoFlac && this.tools().ffmpeg) {
          const wavBytes = files.filter((e) => /\.wav$/i.test(e.path)).reduce((sum, e) => sum + e.size, 0);
          if (wavBytes > 0 && wavBytes >= s.flacMinBytes) this.enqueueFlac(productRef, f.path, s.flacOriginal, true);
        }
      }
    }
    this.pump();
  }

  /**
   * 「圧縮したまま持つ作品も展開する」で、その作品の作り直し・FLAC 化が済んだものを展開に回す。
   * zip を作り直すと名前が変わることがあるので、積む時点の台帳から選ぶ。
   * @returns 積んだか
   */
  private flushExtractAfter(): boolean {
    let queued = false;
    for (const productRef of [...this.extractAfter]) {
      const busy = this.opts.repo.jobsForProduct(productRef).some((j) => j.state === 'queued' || j.state === 'running');
      if (busy) continue;
      this.extractAfter.delete(productRef);
      const product = this.opts.repo.getProduct(productRef);
      if (!product) continue;
      const handling = this.settings().archiveHandling[archiveWorkType(product)];
      if (handling === 'archive') continue;
      for (const f of this.opts.repo.localFiles(productRef)) {
        if (f.missingAt || !isArchiveFile(f.path) || this.opts.repo.extractedFrom(f.path)) continue;
        if (/\.part0*([2-9]|\d{2,})\.(exe|rar)$|\.(7z|zip)\.0*([2-9]|\d{2,})$/i.test(f.path)) continue;
        this.opts.repo.addJob({ productRef, kind: 'extract', source: f.path, auto: true, options: { deleteArchive: handling === 'extractDelete', archivedToo: true } });
        queued = true;
      }
    }
    if (queued) this.notify(true);
    return queued;
  }


  cancel(id: number): void {
    if (this.running?.id === id) {
      this.running.controller.abort();
      return;
    }
    const job = this.opts.repo.getJob(id);
    if (job && job.state === 'queued') this.opts.repo.updateJob(id, { state: 'canceled' });
    this.notify(true);
  }

  retry(id: number): void {
    this.opts.repo.updateJob(id, { state: 'queued', error: null, progress: 0, message: null });
    this.notify(true);
    this.pump();
  }

  remove(id: number): void {
    this.opts.repo.deleteJob(id);
    this.notify(true);
  }

  list(): JobRow[] {
    return this.opts.repo.listJobs();
  }

  start(): void {
    // 前回途中で落ちた作業ファイル・作業フォルダを片付ける
    void (async () => {
      const items = await fs.readdir(this.opts.workDir).catch(() => [] as string[]);
      for (const f of items) {
        if (f.endsWith('.part') || f.startsWith('job-')) {
          await fs.rm(path.join(this.opts.workDir, f), { recursive: true, force: true }).catch(() => undefined);
        }
      }
      this.opts.repo.requeueRunningJobs();
      this.pump();
    })();
  }

  stop(): void {
    this.running?.controller.abort();
  }

  private notify(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastNotify < 500) return;
    this.lastNotify = now;
    this.opts.onProgress(this.list());
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    void (async () => {
      try {
        for (;;) {
          const job = this.opts.repo.nextQueuedJob() ?? (this.flushExtractAfter() ? this.opts.repo.nextQueuedJob() : null);
          if (!job) return;
          await this.runJob(job);
        }
      } finally {
        this.pumping = false;
      }
    })();
  }

  private async runJob(job: JobRow & { options: unknown }): Promise<void> {
    const controller = new AbortController();
    this.running = { id: job.id, controller };
    this.opts.repo.updateJob(job.id, { state: 'running', progress: 0, error: null, message: t('準備中') });
    this.notify(true);
    try {
      if (job.kind === 'move') await this.runMove(job, controller.signal);
      else if (job.kind === 'extract') await this.runExtract(job, controller.signal);
      else if (job.kind === 'lossy') await this.runPrune(job, controller.signal, LOSSY_RULE);
      else if (job.kind === 'pdf') await this.runPrune(job, controller.signal, PDF_RULE);
      else if (isArchiveFile(job.source)) await this.runFlacArchive(job, controller.signal);
      else await this.runFlacFolder(job, controller.signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.repo.updateJob(job.id, {
        state: controller.signal.aborted ? 'canceled' : 'error',
        error: controller.signal.aborted ? null : message,
        message: null
      });
    } finally {
      this.running = null;
      this.notify(true);
    }
  }

  private progress(jobId: number, fraction: number, message: string): void {
    this.opts.repo.updateJob(jobId, { progress: Math.max(0, Math.min(1, fraction)), message });
    this.notify();
  }

  // ── 展開 ───────────────────────────────────────────────
  private async runExtract(job: JobRow & { options: unknown }, signal: AbortSignal): Promise<void> {
    const archive = job.source;
    const options = (job.options ?? {}) as ExtractOptions;
    const exe = this.tools().sevenZip;
    if (!exe) throw new Error(t('7-Zip（7z.exe）が見つかりません。設定画面から入れるか、場所を指定してください。'));
    if (!(await exists(archive))) throw new Error(t('アーカイブが見つかりません（移動・削除された可能性があります）。'));

    const already = this.opts.repo.extractedFrom(archive);
    if (already && (await exists(already.path))) {
      this.opts.repo.updateJob(job.id, {
        state: 'done',
        progress: 1,
        message: t('展開済みです'),
        target: already.path,
        result: { folder: already.path }
      });
      return;
    }

    // 空き容量と、あとで照らし合わせるファイル数（一覧から分かる）
    const listing = await listArchiveEntries(archive, exe);
    const expectedFiles = listing.entries.filter((e) => !e.isDir).length;
    const needed = listing.entries.reduce((s, e) => s + e.size, 0);
    const free = this.opts.freeBytes(path.dirname(archive));
    if (free !== null && free < needed + 512 * 1024 * 1024) {
      throw new Error(
        t('空き容量が足りません（必要 {0} GB / 空き {1} GB）。', { 0: (needed / 1024 ** 3).toFixed(1), 1: (free / 1024 ** 3).toFixed(1) })
      );
    }

    const dest = await uniqueDir(path.join(path.dirname(archive), extractFolderName(archive)));
    this.opts.repo.updateJob(job.id, { target: dest, message: t('展開中') });
    const onProgress = (fraction: number, name: string | null): void =>
      this.progress(job.id, fraction * 0.95, name ? t('展開中: {name}', { name }) : t('展開中'));

    let temp = dest + EXTRACTING;
    await fs.rm(temp, { recursive: true, force: true }); // 前回途中で落ちたぶん
    try {
      await extractArchive(exe, archive, temp, { signal, onProgress });
    } catch (err) {
      await fs.rm(temp, { recursive: true, force: true });
      // 置き場所に書けない（フォルダー アクセスの制御など）ときは、作業フォルダに出してから移す
      if (!(err instanceof Error) || !isAccessDenied(err.message) || signal.aborted) throw err;
      temp = path.join(this.opts.workDir, `job-${job.id}`, 'extract');
      await fs.rm(temp, { recursive: true, force: true });
      await extractArchive(exe, archive, temp, { signal, onProgress });
    }

    // 中身が「フォルダ1つだけ」なら1段上げる（作品フォルダ/VJ000/タイトル/… の二重を避ける）
    const top = await fs.readdir(temp, { withFileTypes: true });
    const inner = top.length === 1 && top[0].isDirectory() ? path.join(temp, top[0].name) : temp;
    await moveInto(inner, dest);
    if (inner !== temp) await fs.rm(temp, { recursive: true, force: true });
    await fs.rm(path.join(this.opts.workDir, `job-${job.id}`), { recursive: true, force: true }).catch(() => undefined);

    const { files, bytes } = await folderStats(dest);
    // 展開した数が一覧と合わなければ、アーカイブは消さない（壊れた展開で元を失わないため）
    const complete = files >= expectedFiles;
    this.opts.repo.addLocalFile({
      productRef: job.productRef,
      path: dest,
      sizeBytes: bytes,
      kind: 'folder',
      source: 'extract',
      derivedFrom: archive
    });

    const deleted: string[] = [];
    const notDeleted: string[] = [];
    const product = job.productRef ? this.opts.repo.getProduct(job.productRef) : null;
    const decision = product ? decideStorage(product, { hasExecutable: hasExecutable(listing.entries.map((e) => e.path)) }) : null;
    // 消すのは「展開して使うもの」だけ。ボイスなどを手で展開したときは、元のアーカイブを残す
    if (options.deleteArchive && complete && (decision?.mode === 'extract' || options.archivedToo)) {
      for (const part of await archiveParts(archive)) {
        try {
          // 展開した直後は Defender がまだ検査していて消せない（EPERM / EBUSY）ことがあるので、少し待ってやり直す
          await fs.rm(part, { force: true, maxRetries: 8, retryDelay: 1500 });
          this.opts.repo.removeLocalFile(part);
          deleted.push(part);
        } catch {
          notDeleted.push(part);
        }
      }
    }

    this.opts.repo.updateJob(job.id, {
      state: 'done',
      progress: 1,
      message: t('{files} ファイルを展開しました{1}{2}{3}', { files, 1: complete ? '' : t('（一覧では {expectedFiles} 件。アーカイブは残しました）', { expectedFiles }), 2: deleted.length ? t('・アーカイブを削除（{length} 本）', { length: deleted.length }) : '', 3: notDeleted.length ? t('・使用中のためアーカイブを消せませんでした（詳細の「手元のファイル」から消せます）') : '' }),
      result: { folder: dest, files, deletedArchives: deleted }
    });
    this.opts.onLocalFilesChanged(job.productRef);
  }

  // ── 移動 ───────────────────────────────────────────────
  private async runMove(job: JobRow & { options: unknown }, signal: AbortSignal): Promise<void> {
    const { items, roots } = (job.options ?? {}) as { items?: RelocationItem[]; roots?: string[] };
    if (!items?.length) {
      this.opts.repo.updateJob(job.id, { state: 'done', progress: 1, message: t('移すものはありませんでした') });
      return;
    }
    const total = items.reduce((s, i) => s + Math.max(1, i.bytes), 0);
    let done = 0;
    let moved = 0;
    const failed: Array<{ path: string; reason: string }> = [];
    for (const [n, item] of items.entries()) {
      if (signal.aborted) throw new Error(t('中止しました'));
      this.progress(job.id, done / total, t('移動中（{0}/{length}）: {title}', { 0: n + 1, length: items.length, title: item.title }));
      try {
        const placed = await moveItem(item, roots ?? [], signal);
        this.opts.repo.relocatePath(item.from, placed);
        moved++;
        this.opts.onLocalFilesChanged(item.productRef);
      } catch (err) {
        if (signal.aborted) throw err;
        failed.push({ path: item.from, reason: err instanceof Error ? err.message : String(err) });
      }
      done += Math.max(1, item.bytes);
    }
    this.opts.repo.updateJob(job.id, {
      state: failed.length && !moved ? 'error' : 'done',
      progress: 1,
      error: failed.length && !moved ? failed[0].reason : null,
      result: { moved, skipped: failed },
      message: t('{moved} 件を移動しました{1}', { moved, 1: failed.length ? t('（{length} 件は移せませんでした）', { length: failed.length }) : '' })
    });
  }

  // ── FLAC（展開済みフォルダ） ────────────────────────────
  private async runFlacFolder(job: JobRow & { options: unknown }, signal: AbortSignal): Promise<void> {
    const tools = this.requireFfmpeg();
    if (!(await exists(job.source))) throw new Error(t('対象のフォルダが見つかりません。'));
    const original = this.originalOf(job);

    const result = await convertTarget(job.source, {
      ffmpeg: tools.ffmpeg,
      ffprobe: tools.ffprobe,
      original,
      trashItem: this.opts.trashItem,
      workDir: this.opts.workDir,
      freeBytes: this.opts.freeBytes,
      signal,
      onProgress: (fraction, message) => this.progress(job.id, fraction, message)
    });
    this.opts.repo.updateLocalFileSize(job.source, (await folderStats(job.source)).bytes);
    this.finishFlac(job, result);
  }

  // ── FLAC（アーカイブのまま持つもの: 中の WAV を差し替えて zip を作り直す） ──
  private async runFlacArchive(job: JobRow & { options: unknown }, signal: AbortSignal): Promise<void> {
    const tools = this.requireFfmpeg();
    const exe = this.tools().sevenZip;
    if (!exe) throw new Error(t('7-Zip（7z.exe）が見つかりません。設定画面から入れるか、場所を指定してください。'));
    const archive = job.source;
    if (!(await exists(archive))) throw new Error(t('アーカイブが見つかりません。'));
    const original = this.originalOf(job);

    const listing = await listArchiveEntries(archive, exe);
    const files = listing.entries.filter((e) => !e.isDir);
    const wavBytes = files.filter((e) => /\.wav$/i.test(e.path)).reduce((s, e) => s + e.size, 0);
    if (wavBytes === 0) {
      this.opts.repo.updateJob(job.id, { state: 'done', progress: 1, message: t('WAV は入っていませんでした'), result: { converted: 0 } });
      return;
    }
    const uncompressed = files.reduce((s, e) => s + e.size, 0);
    const archiveSize = (await fs.stat(archive)).size;
    // 作業に要る量: 展開した中身 + FLAC + 作り直す zip
    const needed = uncompressed + wavBytes * 0.7 + archiveSize;
    const free = this.opts.freeBytes(this.opts.workDir);
    if (free !== null && free < needed + 512 * 1024 * 1024) {
      throw new Error(
        t('作業フォルダ（{workDir}）の空きが足りません（必要 {1} GB / 空き {2} GB）。', { workDir: this.opts.workDir, 1: (needed / 1024 ** 3).toFixed(1), 2: (free / 1024 ** 3).toFixed(1) })
      );
    }

    const jobDir = path.join(this.opts.workDir, `job-${job.id}`);
    const src = path.join(jobDir, 'src');
    await fs.rm(jobDir, { recursive: true, force: true });
    await fs.mkdir(src, { recursive: true });
    try {
      // 1. 作業フォルダに展開（0〜15%）
      await extractArchive(exe, archive, src, {
        signal,
        onProgress: (f) => this.progress(job.id, f * 0.15, t('作業フォルダに展開中'))
      });

      // 2. WAV → FLAC（15〜80%）。作業フォルダの中なので、変換できたものは元の WAV を消してよい
      const result = await convertTarget(src, {
        ffmpeg: tools.ffmpeg,
        ffprobe: tools.ffprobe,
        original: 'delete',
        trashItem: this.opts.trashItem,
        workDir: jobDir,
        signal,
        onProgress: (f, message) => this.progress(job.id, 0.15 + f * 0.65, message)
      });
      if (!result.converted) {
        this.finishFlac(job, result);
        return;
      }

      // 3〜5. zip を作り直して検査し、差し替える（80〜100%）
      const { finalPath, newSize, parts } = await this.repack(job, archive, jobDir, src, exe, original, signal, 0.8, 'flac');
      this.finishFlac(job, {
        ...result,
        beforeBytes: parts.length ? archiveSize : result.beforeBytes,
        afterBytes: newSize,
        archive: finalPath
      }, true);
    } finally {
      await fs.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * 作業フォルダ（src）の中身で zip を作り直し、検査してから元のアーカイブと差し替える。
   * もう縮まないもの（FLAC・MP3・画像など）は無圧縮で入れる → 再生時にアーカイブの中をそのまま Range で切り出せる。
   * from: 進捗の開始位置（ここから 100% まで使う）
   */
  private async repack(
    job: JobRow,
    archive: string,
    jobDir: string,
    src: string,
    exe: string,
    original: FlacOriginal,
    signal: AbortSignal,
    from: number,
    source: string
  ): Promise<{ finalPath: string; newSize: number; parts: string[]; archiveSize: number }> {
    const span = 1 - from;
    const out = path.join(jobDir, 'out.zip');
    await fs.rm(out, { force: true });
    const archiveSize = (await fs.stat(archive)).size;
    const all = await listRelative(src);
    if (all.length === 0) throw new Error(t('作り直す中身がありません。元のアーカイブはそのままです。'));
    const stored = all.filter((p) => STORE_EXTS.includes(path.extname(p).toLowerCase()));
    const compressed = all.filter((p) => !STORE_EXTS.includes(path.extname(p).toLowerCase()));
    const lists: Array<{ list: string[]; level: 0 | 5; from: number; span: number }> = [
      { list: stored, level: 0, from, span: span * 0.5 },
      { list: compressed, level: 5, from: from + span * 0.5, span: span * 0.25 }
    ];
    for (const [i, part] of lists.entries()) {
      if (part.list.length === 0) continue;
      const listFile = path.join(jobDir, `list-${i}.txt`);
      await fs.writeFile(listFile, part.list.map((p) => p.split('/').join(path.sep)).join('\r\n'), 'utf8');
      await packZip(exe, src, listFile, out, {
        level: part.level,
        signal,
        onProgress: (f) => this.progress(job.id, part.from + f * part.span, t('圧縮し直しています'))
      });
    }

    // 検査: CRC と、入れたはずのファイルが全部あるか
    this.progress(job.id, from + span * 0.75, t('作り直した zip を検査中'));
    await testArchive(exe, out, signal);
    const packed = new Set((await readZipIndex(out)).entries.filter((e) => !e.isDir).map((e) => e.name.normalize('NFC')));
    const missing = all.filter((p) => !packed.has(p.normalize('NFC')));
    if (missing.length > 0 || packed.size !== all.length) {
      throw new Error(t('作り直した zip の中身が一致しません（不足 {length} 件）。元のアーカイブはそのままです。', { length: missing.length }));
    }

    // 差し替え: 新しい zip を置き場所へ → 元を処理 → 名前を戻す
    this.progress(job.id, from + span * 0.9, t('差し替え中'));
    const finalPath = path.join(path.dirname(archive), `${extractFolderName(archive)}.zip`);
    const incoming = `${finalPath}.new`;
    await moveInto(out, incoming);
    const parts = await archiveParts(archive);
    await safeReplace(incoming, finalPath, parts, async (backup, part) => {
      if (original === 'keep') {
        const ext = path.extname(part);
        const kept = await uniqueFile(path.join(path.dirname(part), `${path.basename(part, ext)} (${source === 'flac' ? 'WAV' : '元'})${ext}`));
        await fs.rename(backup, kept);
      } else if (original === 'trash') {
        await this.opts.trashItem(backup);
      } else {
        await fs.rm(backup, { force: true });
      }
    });
    for (const part of parts) {
      if (part !== finalPath) this.opts.repo.removeLocalFile(part);
    }
    const newSize = (await fs.stat(finalPath)).size;
    this.opts.repo.addLocalFile({
      productRef: job.productRef,
      path: finalPath,
      sizeBytes: newSize,
      kind: 'archive',
      source
    });
    return { finalPath, newSize, parts, archiveSize };
  }

  // ── 要らないファイルを消す（MP3 などだけ残す / 画像と同じ内容の PDF を消す） ──────────
  private async runPrune(job: JobRow & { options: unknown }, signal: AbortSignal, rule: PruneRule): Promise<void> {
    const original = this.originalOf(job);
    const thenFlac = !!(job.options as { thenFlac?: boolean } | null)?.thenFlac;
    const target = job.source;
    if (!(await exists(target))) throw new Error(t('対象が見つかりません（移動・削除された可能性があります）。'));

    if (!isArchiveFile(target)) {
      // 展開したフォルダ: 消す対象のファイルを消す
      const facts = await listRelative(target);
      const sized = await Promise.all(
        facts.map(async (rel) => ({ path: rel, size: (await fs.stat(path.join(target, ...rel.split('/')))).size }))
      );
      const plan = rule.plan(sized);
      if (plan.remove.length === 0) {
        this.opts.repo.updateJob(job.id, { state: 'done', progress: 1, message: rule.none(), result: { removed: 0 } });
        return;
      }
      const before = (await folderStats(target)).bytes;
      for (const [i, f] of plan.remove.entries()) {
        if (signal.aborted) throw new Error(t('中止しました'));
        this.progress(job.id, i / plan.remove.length, t('削除中（{0}/{length}）', { 0: i + 1, length: plan.remove.length }));
        const full = path.join(target, ...f.path.split('/'));
        if (original === 'delete') await fs.rm(full, { force: true });
        else await this.opts.trashItem(full);
      }
      const after = (await folderStats(target)).bytes;
      this.opts.repo.updateLocalFileSize(target, after);
      this.finishPrune(job, rule, plan.remove.length, plan.kept.length, before, after);
      if (thenFlac && this.tools().ffmpeg) this.enqueueFlac(job.productRef, target, original, true);
      return;
    }

    const exe = this.tools().sevenZip;
    if (!exe) throw new Error(t('7-Zip（7z.exe）が見つかりません。設定画面から入れるか、場所を指定してください。'));
    const listing = await listArchiveEntries(target, exe);
    const files = listing.entries.filter((e) => !e.isDir);
    const plan = rule.plan(files.map((e) => ({ path: e.path, size: e.size })));
    if (plan.remove.length === 0) {
      this.opts.repo.updateJob(job.id, { state: 'done', progress: 1, message: rule.none(), result: { removed: 0 } });
      return;
    }
    const removed = new Set(plan.remove.map((r) => r.path));
    const keep = files.filter((e) => !removed.has(e.path));
    const keepBytes = keep.reduce((s, e) => s + e.size, 0);
    const free = this.opts.freeBytes(this.opts.workDir);
    if (free !== null && free < keepBytes * 2 + 512 * 1024 * 1024) {
      throw new Error(
        t('作業フォルダ（{workDir}）の空きが足りません（必要 {1} GB / 空き {2} GB）。', { workDir: this.opts.workDir, 1: ((keepBytes * 2) / 1024 ** 3).toFixed(1), 2: (free / 1024 ** 3).toFixed(1) })
      );
    }

    const jobDir = path.join(this.opts.workDir, `job-${job.id}`);
    const src = path.join(jobDir, 'src');
    await fs.rm(jobDir, { recursive: true, force: true });
    await fs.mkdir(src, { recursive: true });
    try {
      // 1. 残すものだけを作業フォルダに展開（0〜50%）。消すものは展開しないので速い
      const includeListFile = path.join(jobDir, 'keep.txt');
      await fs.writeFile(includeListFile, keep.map((e) => e.path.split('/').join(path.sep)).join('\r\n'), 'utf8');
      await extractArchive(exe, target, src, {
        signal,
        includeListFile,
        onProgress: (f) => this.progress(job.id, f * 0.5, t('残すファイルを取り出しています'))
      });
      const extracted = await listRelative(src);
      if (extracted.length !== keep.length) {
        throw new Error(t('取り出したファイルの数が合いません（{length} 件のはずが {length2} 件）。元のアーカイブはそのままです。', { length: keep.length, length2: extracted.length }));
      }
      // 2. zip を作り直して差し替え（50〜100%）
      const { finalPath, newSize, archiveSize } = await this.repack(job, target, jobDir, src, exe, original, signal, 0.5, rule.source);
      this.finishPrune(job, rule, plan.remove.length, plan.kept.length, archiveSize, newSize, finalPath);
      if (thenFlac && this.tools().ffmpeg) this.enqueueFlac(job.productRef, finalPath, original, true);
    } finally {
      await fs.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private finishPrune(job: JobRow, rule: PruneRule, removed: number, kept: number, beforeBytes: number, afterBytes: number, archive?: string): void {
    this.opts.repo.updateJob(job.id, {
      state: 'done',
      progress: 1,
      result: { removed, beforeBytes, afterBytes, archive },
      message: rule.done(removed, kept, !!archive, ((beforeBytes - afterBytes) / 1024 ** 2).toFixed(0))
    });
    this.opts.onLocalFilesChanged(job.productRef);
  }

  private requireFfmpeg(): { ffmpeg: string; ffprobe: string } {
    const tools = this.tools();
    if (!tools.ffmpeg || !tools.ffprobe) {
      throw new Error(t('ffmpeg / ffprobe が見つかりません。設定画面から入れるか、場所を指定してください。'));
    }
    return { ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe };
  }

  private originalOf(job: JobRow & { options: unknown }): FlacOriginal {
    return ((job.options as { original?: FlacOriginal } | null)?.original ?? this.settings().flacOriginal) as FlacOriginal;
  }

  private finishFlac(job: JobRow, result: import('@shared/types').JobResult, archive = false): void {
    const saved = (result.beforeBytes ?? 0) - (result.afterBytes ?? 0);
    const skipped = result.skipped?.length ? t('（{length} 件は対象外）', { length: result.skipped.length }) : '';
    this.opts.repo.updateJob(job.id, {
      state: 'done',
      progress: 1,
      result,
      message:
        result.converted === 0
          ? t('変換できるWAVがありませんでした{skipped}', { skipped })
          : t('{converted} 件を変換{1}・{2} MB 削減{skipped}', { converted: result.converted, 1: archive ? t('・zip を作り直し') : '', 2: (saved / 1024 ** 2).toFixed(0), skipped })
    });
    this.opts.onLocalFilesChanged(job.productRef);
  }
}

/** 分割アーカイブなら、同じ組の全ファイル（単体ならそれ自身） */
export async function archiveParts(archive: string): Promise<string[]> {
  const split = splitInfo(archive);
  if (!split) return [archive];
  const dir = path.dirname(archive);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names
    .filter((n) => splitInfo(n)?.base === split.base)
    .map((n) => path.join(dir, n));
}

async function uniqueDir(dir: string): Promise<string> {
  if (!(await exists(dir))) return dir;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${dir} (${i})`;
    if (!(await exists(candidate))) return candidate;
  }
  return `${dir} (${Date.now()})`;
}

async function uniqueFile(file: string): Promise<string> {
  if (!(await exists(file))) return file;
  const ext = path.extname(file);
  const base = file.slice(0, -ext.length);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}

/** フォルダ内の全ファイルを、フォルダからの相対パス（'/' 区切り）で */
async function listRelative(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(path.join(dir, item.name), childRel);
      else if (item.isFile()) out.push(childRel);
    }
  };
  await walk(root, '');
  return out;
}

export async function folderStats(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (d: string): Promise<void> => {
    const items = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      const full = path.join(d, item.name);
      if (item.isDirectory()) await walk(full);
      else if (item.isFile()) {
        files++;
        bytes += await fs
          .stat(full)
          .then((s) => s.size)
          .catch(() => 0);
      }
    }
  };
  await walk(dir);
  return { files, bytes };
}

export { estimateFlac };
