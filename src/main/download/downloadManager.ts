import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, session, shell, type DownloadItem } from 'electron';
import type { DownloadRow, EnqueueEstimate, Product, ProductLink } from '@shared/types';
import type { Repo } from '../db/repo';
import { DMM_PARTITION } from '../sites/dmm/client';
import { DLSITE_PARTITION } from '../sites/dlsite/client';
import { DEFAULT_TEMPLATE, LEGACY_DEFAULT_TEMPLATE, productFolder, uniqueFileName } from './paths';
import { BandwidthThrottle } from './throttle';
import { verifyTransfer } from './verifyTransfer';
import { safeReplace, ReplacementCleanupError } from '../safeReplace';
import { APP_NAME, LEGACY_APP_NAME } from '@shared/appInfo';
import { t } from '@shared/i18n';
import { pickVideoQuality, qualityKeyOf, videoQualityOptions, type VideoQualityPref } from '@shared/videoQuality';

/**
 * 購入済みファイルのダウンロード。
 *
 * **fetch では落とさない。** 実ファイルが丸ごとメモリに載って落ちる（DLsiteで実際に踏んだ）。
 * 非表示ウィンドウの `webContents.downloadURL()` → `session.will-download` で `DownloadItem`
 * を受け取り、ディスクへ流す。リダイレクト連鎖（DMM同人の accounts 経由4段）や Cookie は
 * ネットワークスタックが面倒を見てくれる。
 *
 * URLは**キューに保存しない**。期限付き・セッション依存で、古いURLはログイン画面や400に化ける。
 * 実行の直前に詳細を取り直して、そのときのURLを使う。
 */

const SETTING_ROOT = 'download.root';
const SETTING_TEMPLATE = 'download.template';
const SETTING_CONCURRENCY = 'download.concurrency';
const SETTING_MAX_RATE = 'download.maxBytesPerSec';
/** 動画の画質の既定。作品ごとに選んだ画質は `download.videoQuality.<作品>` */
const SETTING_VIDEO_QUALITY = 'download.videoQuality';
/** 保存中の目印。完了時にこの拡張子を外す */
const PART = '.part';
const MAX_ATTEMPTS = 3;
/** 混雑・同時に投げすぎで弾かれたときに、次を始めるまで置く時間 */
const RETRY_DELAY_MS = 10_000;
/** URL を取り直す通信の待ち時間の上限。返ってこないまま待つと、キュー全体が止まる（実際に起きた） */
const DETAIL_TIMEOUT_MS = 60_000;
/** ダウンロードを頼んでから始まるまでの待ち時間の上限 */
const START_TIMEOUT_MS = 90_000;
/** 取りこぼした状態を拾い直す間隔 */
const SWEEP_MS = 20_000;
/** 導線が見つからなかった作品の行のラベル（DB には日本語のまま入れ、表示のときに訳す） */
const NO_LINK_LABEL = 'ダウンロード導線が見つかりません';

/** 時間内に終わらなければ失敗にする（元の処理は止められないので、結果を待たないだけ） */
export function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export interface DownloadManagerOptions {
  repo: Repo;
  /** library:detail と同じ取得処理。URLを取り直すために使う */
  fetchDetail: (id: number, opts?: { force?: boolean }) => Promise<unknown>;
  onProgress: (rows: DownloadRow[]) => void;
  /** 1本落とし終えたとき（展開などの後処理を積むため） */
  onFinished?: (productRef: number, filePath: string) => void;
  /** テスト用: 待ち時間の上限を短くする */
  detailTimeoutMs?: number;
  startTimeoutMs?: number;
}

/**
 * ダウンロードできる導線だけを取り出す。
 * FANZA動画は同じ作品が画質違いで並ぶ。全部落とすと数倍の容量になるので、画質を 1 つだけ選ぶ（既定はいちばん高い画質）。
 * 複数パートの作品は、その画質のパートをすべて落とす。
 */
export function downloadableLinks(product: Pick<Product, 'floorId' | 'links'>, videoPref: VideoQualityPref | null = 'best'): ProductLink[] {
  const links = product.links.filter(
    (l) =>
      l.kind === 'download' ||
      // DMM同人の「ダウンロードページ」は proxy URL で、開くと実体へリダイレクトされる
      (l.kind === 'page' && l.url.includes('/proxy/=/transfer_type=download'))
  );
  if (product.floorId === 'video' && links.length > 1) {
    const chosen = pickVideoQuality(videoQualityOptions(links), videoPref);
    if (chosen) return links.filter((l) => qualityKeyOf(l) === chosen.key).sort((a, b) => (a.quality?.part ?? 0) - (b.quality?.part ?? 0));
  }
  return links;
}

/** ダウンロードできるファイルが無いときの、理由と次にすること */
export function noLinkReason(product: Product, detailError: string | null): string {
  if (product.tags.some((tItem) => tItem.includes('DMM GAMES PLAYER専用'))) {
    return t('DMM GAMES PLAYER 専用の作品です。DMM GAMES PLAYER でインストールし、詳細の「インストール・起動」から紐付けてください。');
  }
  if (product.floorId === 'book' && /book\.dmm\.com/.test(product.detailUrl ?? '') && /ログイン|log ?in/i.test(detailError ?? '')) {
    return t('一般向けの DMM ブックス（dmm.com）へのログインが必要です。設定の「アカウント」からログインしてください。');
  }
  if (detailError) return t('ダウンロード情報を取得できませんでした（{0}）', { 0: detailError.slice(0, 160) });
  return t('この作品にはダウンロードできるファイルが見つかりませんでした。');
}

/**
 * 保存先を指定していないときの置き場所。
 * 表示名を変える前の `ドキュメント\MyLibrary` がすでにあるなら、そのまま使い続ける
 * （設定を持たない人の手元で、名前を変えただけで落としたものが見当たらなくなるのを防ぐ）。
 */
function defaultRoot(): string {
  const documents = app.getPath('documents');
  const current = path.join(documents, APP_NAME);
  const legacy = path.join(documents, LEGACY_APP_NAME);
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}

export class DownloadManager {
  /** 行ごとの非表示ウィンドウ。どのウィンドウから始まったダウンロードかで行を突き合わせる */
  private windows = new Map<number, BrowserWindow>();
  /** いま走っている DownloadItem。行ID → item */
  private active = new Map<number, DownloadItem>();
  /**
   * downloadURL を投げてから will-download が来るまでの待ち合わせ。
   * wcId は投げたウィンドウの webContents。続きからの再開（createInterruptedDownload）は null。
   */
  private pending: Array<{ url: string; rowId: number; partition: string; wcId: number | null }> = [];
  /**
   * 始める準備（URL の取り直しなど）をしている行。同時実行数に数える。
   * 以前はキュー全体を1本の処理で順に進めていて、URL の取り直しが返ってこないと、それ以降は何を積んでも待機のままになった。
   */
  private starting = new Set<number>();
  /** 落とし終えて、名前を戻す・台帳に載せるなどの仕上げ中の行 */
  private finishing = new Set<number>();
  /**
   * いま走っている詳細の取り直し（作品ID → 処理）。
   * 分割ダウンロードは1作品にパートの数だけ行があり、同時に始まると同じ案内ページを何度も取りに行くことになる。
   * 走っているものがあれば相乗りする。
   */
  private detailInFlight = new Map<number, Promise<unknown>>();
  /** 今回のまとまり（キューが空の状態から積んだ行）。件数の進み具合に使う */
  private batch = new Set<number>();
  private sweeper: NodeJS.Timeout | null = null;
  private throttle: BandwidthThrottle;

  constructor(private opts: DownloadManagerOptions) {
    this.throttle = new BandwidthThrottle(() => this.maxBytesPerSec);
  }

  // ── 設定 ───────────────────────────────────────────────
  get root(): string {
    return this.opts.repo.getSetting(SETTING_ROOT) || defaultRoot();
  }

  get template(): string {
    const saved = this.opts.repo.getSetting(SETTING_TEMPLATE);
    // 以前の既定をそのまま保存しているだけなら、新しい既定（種別で分ける）に切り替える
    return !saved || saved === LEGACY_DEFAULT_TEMPLATE ? DEFAULT_TEMPLATE : saved;
  }

  /** 以前使っていた保存先（移動の対象を決めるのに使う）。既定の保存先も含める */
  knownRoots(): string[] {
    let history: string[] = [];
    try {
      history = JSON.parse(this.opts.repo.getSetting('download.rootHistory') ?? '[]') as string[];
    } catch {
      history = [];
    }
    return [
      ...new Set([
        this.root,
        defaultRoot(),
        path.join(app.getPath('documents'), LEGACY_APP_NAME),
        ...history
      ])
    ];
  }


  get concurrency(): number {
    const raw = Number(this.opts.repo.getSetting(SETTING_CONCURRENCY));
    return Number.isFinite(raw) && raw >= 1 ? Math.min(8, Math.round(raw)) : 1;
  }

  /** 帯域制限（バイト/秒）。0 なら制限なし */
  get maxBytesPerSec(): number {
    const raw = Number(this.opts.repo.getSetting(SETTING_MAX_RATE));
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  settings(): { root: string; template: string; concurrency: number; maxBytesPerSec: number; videoQuality: string } {
    return {
      root: this.root,
      template: this.template,
      concurrency: this.concurrency,
      maxBytesPerSec: this.maxBytesPerSec,
      videoQuality: this.opts.repo.getSetting(SETTING_VIDEO_QUALITY) || 'best'
    };
  }

  /** 作品の落とす導線（動画は、作品ごとに選んだ画質、無ければ既定の画質） */
  linksFor(product: Product): ProductLink[] {
    const pref = product.floorId === 'video'
      ? this.opts.repo.getSetting(`${SETTING_VIDEO_QUALITY}.${product.id}`) || this.opts.repo.getSetting(SETTING_VIDEO_QUALITY) || 'best'
      : null;
    return downloadableLinks(product, pref);
  }

  /** 動画を、選んだ画質で積む。まだ始まっていない行（別の画質で積んだもの・失敗したもの）は作り直す */
  async enqueueVideo(productId: number, qualityKey: string): Promise<number> {
    this.opts.repo.setSetting(`${SETTING_VIDEO_QUALITY}.${productId}`, `q:${qualityKey}`);
    for (const d of this.opts.repo.listDownloads(100000).filter((x) => x.productRef === productId)) {
      if (d.state === 'queued' || d.state === 'error' || d.state === 'canceled') this.opts.repo.deleteDownload(d.id);
    }
    return this.enqueue([productId]);
  }

  saveSettings(next: { root?: string; template?: string; concurrency?: number; maxBytesPerSec?: number; videoQuality?: string }): void {
    if (next.videoQuality !== undefined) this.opts.repo.setSetting(SETTING_VIDEO_QUALITY, next.videoQuality);
    if (next.maxBytesPerSec !== undefined) {
      this.opts.repo.setSetting(SETTING_MAX_RATE, String(Math.max(0, Math.round(next.maxBytesPerSec))));
    }
    if (next.root !== undefined && next.root !== this.root) {
      const history = this.knownRoots().filter((r) => r !== next.root);
      this.opts.repo.setSetting('download.rootHistory', JSON.stringify(history.slice(0, 10)));
      this.opts.repo.setSetting(SETTING_ROOT, next.root);
    }
    if (next.template !== undefined) this.opts.repo.setSetting(SETTING_TEMPLATE, next.template);
    if (next.concurrency !== undefined) {
      this.opts.repo.setSetting(SETTING_CONCURRENCY, String(next.concurrency));
    }
    this.pump();
  }

  // ── キュー操作 ─────────────────────────────────────────
  /**
   * 作品をキューに積む。導線が分からない作品は詳細を取りに行ってから積む。
   * @returns 積んだ件数
   */
  async enqueue(productIds: number[], opts: { force?: boolean } = {}): Promise<number> {
    let added = 0;
    const queuedIds: number[] = [];
    for (const id of this.expandSets(productIds)) {
      let product = this.opts.repo.getProduct(id);
      if (!product) continue;
      const existing = this.opts.repo.listDownloads(100000).filter((d) => d.productRef === id);
      if (product.hasLocalFile) {
        // 手元にある作品は積まない（取り込みで見つけた作品には行が無く、以前は「表示中をダウンロード」で落とし直していた）。
        // 分割の一部だけ失敗しているなど、終わっていない行があるときはそれを積み直す
        if (!opts.force && existing.every((d) => d.state === 'done')) continue;
      } else {
        // 手元のファイルを消した・外で消えた作品は、「完了」の行が残っていても最初から落とし直す
        for (const d of existing.filter((x) => x.state === 'done')) this.opts.repo.deleteDownload(d.id);
      }
      let reason: string | null = null;
      if (this.linksFor(product).length === 0) {
        // まだ導線を持っていない作品は、ここで詳細を取り直す。
        // 取得済みの印があっても取り直す（以前はログイン切れで空のまま「取得済み」になり、二度と取りに行かなかった）
        try {
          const res = (await withTimeout(
            this.refreshDetail(id),
            this.opts.detailTimeoutMs ?? DETAIL_TIMEOUT_MS,
            t('作品の情報を取得できませんでした（応答がありません）')
          )) as { detailError?: string | null } | null;
          reason = res?.detailError ?? null;
          product = this.opts.repo.getProduct(id) ?? product;
        } catch (err) {
          reason = err instanceof Error ? err.message : String(err);
        }
      }
      const links = this.linksFor(product);
      if (links.length === 0) {
        this.opts.repo.upsertDownload({
          productRef: id,
          label: NO_LINK_LABEL,
          linkKind: 'main',
          linkIndex: 0,
          state: 'error',
          error: noLinkReason(product, reason)
        });
        continue;
      }
      // 導線未取得時のエラー行は、実ファイルの行に置き換える。
      for (const row of this.opts.repo.listDownloads().filter((d) => d.productRef === id && d.label === NO_LINK_LABEL)) {
        this.opts.repo.deleteDownload(row.id);
      }
      const before = new Map(
        this.opts.repo
          .listDownloads()
          .filter((d) => d.productRef === id)
          .map((d) => [`${d.linkKind}:${d.linkIndex}`, d.state])
      );
      for (const [index, link] of links.entries()) {
        const linkKind = links.length > 1 ? 'split' : 'main';
        this.opts.repo.upsertDownload({
          productRef: id,
          label: links.length > 1 ? `${link.label}（${index + 1}/${links.length}）` : link.label,
          linkKind,
          linkIndex: index,
          state: 'queued'
        });
        // 取得済みの行は「完了」のまま残る（二重に落とさない）。取り直すときは redownload を使う
        if (before.get(`${linkKind}:${index}`) !== 'done') added++;
      }
      queuedIds.push(id);
    }
    this.joinBatch(
      this.opts.repo
        .listDownloads(100000)
        .filter((d) => queuedIds.includes(d.productRef) && d.state === 'queued')
        .map((d) => d.id)
    );
    this.notify();
    this.pump();
    return added;
  }

  /**
   * セット商品を中身に置き換える。セット本体はファイルを持たない入れ物で、ファイルは中身の作品ごとにある。
   * 中身がまだ購入履歴に並んでいないセットは、そのまま残す（導線が無い理由を出す）
   */
  private expandSets(productIds: number[]): number[] {
    const out: number[] = [];
    for (const id of productIds) {
      const children = this.opts.repo.setChildIds(id);
      for (const c of children.length > 0 ? children : [id]) if (!out.includes(c)) out.push(c);
    }
    return out;
  }

  /**
   * ダウンロード済みの作品を、もう一度落とす。落とし終えたら手元のファイルと置き換える（元はごみ箱へ）。
   * 「MP3だけ残す」や FLAC 化で中身を変えたアーカイブを、配布されたままの形に戻すのに使う。
   * @returns 積んだ件数
   */
  async redownload(productId: number): Promise<number> {
    // セット商品は中身ごとに落とし直す
    const children = this.opts.repo.setChildIds(productId);
    if (children.length > 0) {
      let total = 0;
      for (const child of children) total += await this.redownload(child);
      return total;
    }
    const rows = this.opts.repo.listDownloads().filter((d) => d.productRef === productId);
    if (rows.some((r) => r.state === 'running' || r.state === 'queued')) return 0;
    for (const r of rows) {
      if (r.state === 'paused') continue; // 途中のものは続きから
      this.opts.repo.updateDownload(r.id, {
        state: 'queued',
        savePath: null,
        totalBytes: null,
        receivedBytes: 0,
        etag: null,
        lastModified: null,
        urlChain: null,
        attempts: 0,
        error: null
      });
    }
    this.joinBatch(rows.filter((r) => r.state !== 'paused').map((r) => r.id));
    const added = rows.length > 0 ? rows.length : await this.enqueue([productId], { force: true });
    this.notify();
    this.pump();
    return added;
  }

  /**
   * まとめて積む前の見積もり。必要な容量と空き容量を突き合わせる。
   * 取得済み（local_files にある）作品は最初から外す。
   */
  estimate(productIds: number[]): EnqueueEstimate {
    let files = 0;
    let bytes = 0;
    let unknown = 0;
    let products = 0;
    for (const id of this.expandSets(productIds)) {
      const product = this.opts.repo.getProduct(id);
      if (!product || product.hasLocalFile) continue;
      products++;
      const links = this.linksFor(product);
      files += Math.max(1, links.length);
      // 動画は選んだ画質の容量（API の目安、MB）
      const videoMb = links.reduce((sum, l) => sum + (l.quality?.sizeMb ?? 0), 0);
      if (videoMb > 0) bytes += videoMb * 1024 * 1024;
      else if (product.fileSizeBytes && product.fileSizeBytes > 0) bytes += product.fileSizeBytes;
      else unknown++;
    }
    const freeBytes = this.freeSpace();
    return {
      products,
      files,
      bytes,
      unknown,
      freeBytes,
      // 余裕を1GB見ておく。サイズ不明が混ざっていたら足りない判定にはしない
      short: freeBytes !== null && bytes > 0 && freeBytes < bytes + 1024 * 1024 * 1024
    };
  }

  /** 保存先ドライブの空き容量。取れなければ null */
  private freeSpace(): number | null {
    try {
      fs.mkdirSync(this.root, { recursive: true });
      const stat = fs.statfsSync(this.root);
      return stat.bavail * stat.bsize;
    } catch {
      return null;
    }
  }

  pause(rowId: number): void {
    this.pauseRow(rowId);
    this.notify();
    this.pump();
  }

  /** 走っているものは止め、待機しているものは順番が来ても始めないようにする */
  private pauseRow(rowId: number): void {
    // 帯域制限が止めていたものでも、ここからはユーザーの一時停止として扱う
    this.throttle.release(rowId);
    this.active.get(rowId)?.pause();
    this.opts.repo.updateDownload(rowId, { state: 'paused' });
  }

  resume(rowId: number): void {
    const retryProducts = this.resumeRow(rowId);
    this.notify();
    this.pump();
    if (retryProducts !== null) void this.enqueue([retryProducts]);
  }

  /** @returns 行ではなく作品ごと積み直すべきとき、その作品 */
  private resumeRow(rowId: number): number | null {
    const row = this.opts.repo.getDownload(rowId);
    // 導線が見つからなかった行は、行を積み直しても同じ理由で失敗するだけ。詳細を取り直すところからやり直す
    if (row && row.label === NO_LINK_LABEL) {
      this.opts.repo.deleteDownload(rowId);
      return row.productRef;
    }
    const item = this.active.get(rowId);
    if (item?.canResume()) {
      item.resume();
      this.opts.repo.updateDownload(rowId, { state: 'running' });
      return null;
    }
    // プロセスをまたいだ中断。URLを取り直してから続きを取りに行く。
    // 失敗の回数も戻す（戻さないと、上限に達した行は1回失敗しただけでまた「失敗」になる）
    this.opts.repo.updateDownload(rowId, { state: 'queued', error: null, attempts: 0 });
    this.joinBatch([rowId]);
    return null;
  }

  /** 一時停止・失敗・中止をまとめて再開する。@returns 再開した件数 */
  resumeAll(): number {
    const rows = this.opts.repo
      .listDownloads(100000)
      .filter((r) => r.state === 'paused' || r.state === 'error' || r.state === 'canceled');
    const products: number[] = [];
    for (const r of rows) {
      const p = this.resumeRow(r.id);
      if (p !== null) products.push(p);
    }
    this.notify();
    this.pump();
    if (products.length > 0) void this.enqueue(products);
    return rows.length;
  }

  /** 取得中・待機をまとめて一時停止する。@returns 止めた件数 */
  pauseAll(): number {
    const rows = this.opts.repo.listDownloads(100000).filter((r) => r.state === 'running' || r.state === 'queued');
    for (const r of rows) this.pauseRow(r.id);
    this.notify();
    return rows.length;
  }

  /** 「完了」「中止」の行を一覧から消す（ファイルは消さない）。@returns 消した件数 */
  clearFinished(): number {
    const n = this.opts.repo.deleteFinishedDownloads();
    this.notify();
    return n;
  }

  /** 手元のファイルを消した作品の「完了」の行を消す。もう一度ダウンロードできるようにする */
  forgetDone(productRef: number): void {
    this.opts.repo.deleteDoneDownloads(productRef);
    this.notify();
  }

  cancel(rowId: number): void {
    this.active.get(rowId)?.cancel();
    this.active.delete(rowId);
    this.opts.repo.updateDownload(rowId, { state: 'canceled' });
    this.notify();
    this.pump();
  }

  retry(rowId: number): void {
    this.opts.repo.updateDownload(rowId, { state: 'queued', error: null, attempts: 0 });
    this.joinBatch([rowId]);
    this.notify();
    this.pump();
  }

  remove(rowId: number): void {
    this.active.get(rowId)?.cancel();
    this.active.delete(rowId);
    this.opts.repo.deleteDownload(rowId);
    this.notify();
  }

  list(): DownloadRow[] {
    const rows = this.opts.repo.listDownloads();
    return rows.map((r) => {
      const item = this.active.get(r.id);
      return {
        ...r,
        bytesPerSec: item && r.state === 'running' && !item.isPaused() ? item.getCurrentBytesPerSecond() : 0,
        preparing: r.state === 'queued' && (this.starting.has(r.id) || this.pending.some((p) => p.rowId === r.id)),
        inBatch: this.batch.has(r.id)
      };
    });
  }

  /**
   * 今回のまとまりに足す。何も待っていない・走っていない状態から積んだときは、新しいまとまりにする
   * （前のまとまりの「10 / 10 件完了」を引きずらない）。
   */
  private joinBatch(rowIds: number[]): void {
    if (rowIds.length === 0) return;
    const busy = this.opts.repo
      .listDownloads(100000)
      .some((r) => this.batch.has(r.id) && (r.state === 'running' || r.state === 'queued' || r.state === 'paused'));
    if (!busy) this.batch.clear();
    for (const id of rowIds) this.batch.add(id);
  }

  private isBusy(rowId: number): boolean {
    return (
      this.active.has(rowId) ||
      this.starting.has(rowId) ||
      this.finishing.has(rowId) ||
      this.pending.some((w) => w.rowId === rowId)
    );
  }

  private notify(): void {
    this.opts.onProgress(this.list());
  }

  // ── 実行 ───────────────────────────────────────────────
  /** 起動時に呼ぶ。前回の実行中だったものを待機に戻す */
  start(): void {
    this.opts.repo.requeueRunningDownloads();
    for (const r of this.opts.repo.listDownloads(100000)) {
      if (r.state === 'queued' || r.state === 'paused') this.batch.add(r.id);
    }
    void this.repairFinished();
    this.throttle.start();
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.pump();
  }

  /**
   * 取りこぼしを拾い直す。「取得中」なのに何も走っていない行は待機に戻し、空きがあればキューを進める。
   * 何かの拍子に知らせを取りこぼしても、待機のまま止まり続けないようにする。
   */
  private sweep(): void {
    let changed = false;
    for (const r of this.opts.repo.listDownloads(100000)) {
      if (r.state === 'running' && !this.isBusy(r.id)) {
        console.warn(`[download] 取得中なのに何も走っていない行を待機に戻します: row=${r.id}`);
        this.opts.repo.updateDownload(r.id, { state: 'queued' });
        changed = true;
      }
    }
    if (changed) this.notify();
    else if (this.active.size > 0) this.notify(); // 速さの表示を更新する
    this.pump();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    this.throttle.stop();
    for (const item of this.active.values()) item.pause();
    this.active.clear();
    for (const rowId of [...this.windows.keys()]) this.closeWindow(rowId);
  }

  /**
   * 空きがある限りキューを進める。行ごとに別々に始めるので、1本の準備が返ってこなくても他は進む。
   */
  private pump(): void {
    for (;;) {
      // 準備中・downloadURL を投げてから will-download が来るまでの間も1本ぶんと数える。
      // 数えないと、待っている間に次々と走り出して同時実行数を守れない。
      if (this.active.size + this.pending.length + this.starting.size >= this.concurrency) return;
      const next = this.opts.repo.queuedDownloads().find((r) => !this.isBusy(r.id));
      if (!next) return;
      this.starting.add(next.id);
      void this.startRow(next)
        .catch((err: unknown) => {
          this.fail(next.id, err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          this.starting.delete(next.id);
          this.notify();
          // 失敗してすぐ同じ行をやり直すと、同じ理由で立て続けに失敗するので少し置く
          setTimeout(() => this.pump(), 1000);
        });
    }
  }

  /**
   * その行専用の非表示ウィンドウ。
   * 1つを使い回していたときは、will-download を「URL の一致」と「待ちが1件ならそれ」で突き合わせていたため、
   * 再開で二重に来た項目を別作品の行に結び付けてしまうことがあった（完了なのに0バイトになった）。
   * 行ごとにウィンドウを分け、**どのウィンドウから始まったか**で突き合わせる。
   */
  private openWindow(rowId: number, partition: string): BrowserWindow {
    this.closeWindow(rowId);
    const win = new BrowserWindow({
      show: false,
      webPreferences: { session: session.fromPartition(partition), sandbox: true }
    });
    this.attachHandler(session.fromPartition(partition));
    this.windows.set(rowId, win);
    return win;
  }

  private closeWindow(rowId: number): void {
    const win = this.windows.get(rowId);
    this.windows.delete(rowId);
    if (win && !win.isDestroyed()) win.destroy();
  }

  private attachedSessions = new Set<string>();

  private attachHandler(s: Electron.Session): void {
    const key = (s as unknown as { storagePath?: string }).storagePath ?? String(this.attachedSessions.size);
    if (this.attachedSessions.has(key)) return;
    this.attachedSessions.add(key);
    s.on('will-download', (_event, item, webContents) => {
      // すでに走っている項目が、再開などで二重に届くことがある。別の行に結び付けないよう無視する
      for (const running of this.active.values()) {
        if (running === item) return;
        if (running.getStartTime() === item.getStartTime() && running.getURL() === item.getURL()) return;
      }
      const chain = item.getURLChain();
      const urls = new Set([...chain, item.getURL()]);
      // 1. 始めたウィンドウで突き合わせる（確実）
      let index = webContents ? this.pending.findIndex((w) => w.wcId === webContents.id) : -1;
      // 2. 続きからの再開（ウィンドウを持たない）は URL で
      if (index < 0) index = this.pending.findIndex((w) => w.wcId === null && urls.has(w.url));
      // 3. 再開で URL が鎖に残らない配信元のために、ウィンドウを持たない待ちが1件だけならそれ
      if (index < 0 && !webContents) {
        const orphans = this.pending.filter((w) => w.wcId === null);
        if (orphans.length === 1) index = this.pending.indexOf(orphans[0]);
      }
      if (index < 0) {
        // 取り違えると別の作品のファイルを上書きしかねない。拾えないものは捨てる
        item.cancel();
        return;
      }
      const waiting = this.pending.splice(index, 1)[0];
      this.bind(waiting.rowId, item);
    });

    // ダウンロードの代わりに何が返ったかを見る（ページが返った・アプリを起動するリンクへ移ったなど）。
    // 見るのはダウンロード用ウィンドウが出した通信だけ。同期などの通信（ウィンドウを持たない）は対象外
    const filter = { urls: ['*://*/*'] };
    s.webRequest.onBeforeRedirect(filter, (details) => {
      const waiting = this.waitingFor(details.webContentsId);
      if (!waiting || /^https?:/i.test(details.redirectURL)) return;
      const scheme = details.redirectURL.split(':')[0];
      this.failBeforeStart(
        waiting.rowId,
        t('ダウンロードの代わりに、アプリを起動するリンク（{scheme}:）へ移りました。ファイルを直接ダウンロードできる導線が返りませんでした。', { scheme })
      );
    });
    s.webRequest.onCompleted(filter, (details) => {
      const waiting = this.waitingFor(details.webContentsId);
      if (!waiting) return;
      const type = Object.entries(details.responseHeaders ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1]?.join(';') ?? '';
      const status = details.statusCode;
      // ファイルが続いて届くこともあるので、少し待ってもダウンロードが始まらなければ失敗にする
      const where = describeUrl(details.url);
      if (status >= 400) {
        // 混んでいる・同時に投げすぎ（403・429）や、サイト側の不調（5xx）は、時間を置けば通ることがある。
        // 待ち時間いっぱい（90秒）待ってから「ログイン切れ」と言っていたのを、理由と状態のまま早く返す
        const retryable = status === 403 || status === 408 || status === 429 || status >= 500;
        setTimeout(() => {
          if (!this.waitingFor(details.webContentsId)) return;
          this.failBeforeStart(
            waiting.rowId,
            retryable
              ? t('サーバが受け付けませんでした（HTTP {status}・{where}）。時間を置いてやり直します。', { status, where })
              : t('サーバがエラーを返しました（HTTP {status}・{where}）。ログインが切れているか、このアプリではダウンロードできない作品です。', { status, where }),
            { retryable }
          );
        }, 3000);
        return;
      }
      if (!/text\/html/i.test(type)) return;
      setTimeout(() => {
        if (!this.waitingFor(details.webContentsId)) return;
        this.failBeforeStart(
          waiting.rowId,
          t('ダウンロードの代わりにページが返りました（HTTP {status}・{where}）。ログインが切れているか、このアプリではダウンロードできない作品です。', { status, where })
        );
      }, 3000);
    });
    s.webRequest.onErrorOccurred(filter, (details) => {
      const waiting = this.waitingFor(details.webContentsId);
      // ダウンロードに切り替わるときの ERR_ABORTED は正常
      if (!waiting || /ERR_ABORTED/.test(details.error)) return;
      const where = describeUrl(details.url);
      setTimeout(() => {
        if (!this.waitingFor(details.webContentsId)) return;
        this.failBeforeStart(waiting.rowId, t('ダウンロードを始められませんでした（{error}・{where}）。', { error: details.error, where }));
      }, 3000);
    });
  }

  /** ダウンロード用ウィンドウの webContents から、始まるのを待っている行を引く */
  private waitingFor(webContentsId: number | undefined): { rowId: number; wcId: number | null } | null {
    if (webContentsId === undefined || webContentsId < 0) return null;
    return this.pending.find((w) => w.wcId === webContentsId) ?? null;
  }

  /**
   * 始まる前に、理由が分かって失敗にする（90 秒待たない）。
   * `retryable` は「時間を置けば通るかもしれない」もの（混雑・同時に投げすぎ・サイトの不調）。
   * それ以外は同じ理由でやり直しても変わらないので、失敗の回数を上限にして打ち切る。
   */
  private failBeforeStart(rowId: number, message: string, opts?: { retryable?: boolean }): void {
    const i = this.pending.findIndex((w) => w.rowId === rowId);
    if (i < 0) return;
    this.pending.splice(i, 1);
    this.closeWindow(rowId);
    console.warn(`[download] 始まりませんでした: row=${rowId} ${message}`);
    if (!opts?.retryable) this.opts.repo.updateDownload(rowId, { attempts: MAX_ATTEMPTS - 1 });
    this.fail(rowId, message);
    this.notify();
    // すぐ投げ直すと同じ理由で弾かれる。少し置いてから次を始める
    if (opts?.retryable) setTimeout(() => this.pump(), RETRY_DELAY_MS);
    else this.pump();
  }

  /**
   * DLsite の分割ダウンロードの保存名。
   *
   * サーバは Content-Disposition を付けず、URL の最後も `20171012191811` のような日時だけ
   * （実測: 2026-09-19）。そのまま保存すると、どの作品の何本目か分からないうえ、
   * 多巻書庫として `名前.partN.exe|rar` の並びが要る 7-Zip が巻をつなげられない。
   * 作品IDと、案内ページが示す巻の番号で付け直す。
   */
  private splitPartName(product: Product, row: DownloadRow, item: DownloadItem): string | null {
    if (product.siteId !== 'dlsite') return null;
    const link = this.linksFor(product)[row.linkIndex];
    const number = link ? /\/home\/download\/=\/number\/(\d+)\//.exec(link.url) : null;
    if (!number) return null;
    // 種類が分かるならそれに従う。分からなければ、Chromium が付けた拡張子をそのまま使う
    const mime = item.getMimeType();
    const ext = /rar/i.test(mime)
      ? '.rar'
      : /msdownload|x-exe/i.test(mime)
        ? '.exe'
        : /zip/i.test(mime)
          ? '.zip'
          : path.extname(item.getFilename()) || '.bin';
    return `${product.productId}.part${Number(number[1])}${ext}`;
  }

  /** 詳細（＝ダウンロードURL）の取り直し。同じ作品の行が同時に始まるときは1回にまとめる */
  private refreshDetail(productId: number): Promise<unknown> {
    const running = this.detailInFlight.get(productId);
    if (running) return running;
    const work = this.opts.fetchDetail(productId, { force: true }).finally(() => {
      this.detailInFlight.delete(productId);
    });
    this.detailInFlight.set(productId, work);
    return work;
  }

  private async startRow(row: DownloadRow): Promise<void> {
    // 同じ行を二重に走らせない（走らせると同じ .part を2本が奪い合う）
    if (this.active.has(row.id) || this.pending.some((w) => w.rowId === row.id)) return;
    this.notify(); // 「準備中」を見せる
    const product = this.opts.repo.getProduct(row.productRef);
    if (!product) throw new Error(t('作品が見つかりません'));

    // すでに実体があるなら取り直さない（中断のあと手動で置いた場合も含む）
    if (row.savePath) {
      const part = row.savePath + PART;
      if (fs.existsSync(row.savePath) && !fs.existsSync(part)) {
        await this.finish(row.id, row.productRef, row.savePath, part);
        return;
      }
      if (fs.existsSync(part)) {
        // 大きさを知るのに同期の stat は使わない（開いた瞬間に Defender の検査が走り、メインプロセスが止まる）
        const offset = (await fs.promises.stat(part)).size;
        const total = row.totalBytes ?? 0;
        if (total > 0 && offset === total) {
          await this.finish(row.id, row.productRef, row.savePath, part);
          return;
        }
      }
    }

    // URLは期限付き。実行の直前に取り直す（§3-2）。返ってこなければ、手元にある URL で試す
    await withTimeout(this.refreshDetail(product.id), this.opts.detailTimeoutMs ?? DETAIL_TIMEOUT_MS, 'timeout').catch((err: unknown) => {
      console.warn(`[download] URL の取り直しに失敗: row=${row.id}`, err instanceof Error ? err.message : err);
    });
    // 準備している間に一時停止・中止・削除されたなら始めない
    const now = this.opts.repo.getDownload(row.id);
    if (!now || now.state !== 'queued') return;
    const fresh = this.opts.repo.getProduct(product.id) ?? product;
    const links = this.linksFor(fresh);
    const link = links[row.linkIndex];
    if (!link) throw new Error(t('ダウンロード導線が見つかりませんでした。再同期してください。'));

    this.opts.repo.updateDownload(row.id, { state: 'running', error: null });
    const partition = fresh.siteId === 'dlsite' ? DLSITE_PARTITION : DMM_PARTITION;

    // 途中まで落ちている .part があれば続きから。
    // サーバがRangeに対応していることは実測済み（DESIGN-download.md §3-1）。
    const partial = row.savePath ? row.savePath + PART : null;
    if (partial && fs.existsSync(partial)) {
      const offset = (await fs.promises.stat(partial)).size;
      const total = row.totalBytes ?? 0;
      // 落とし切った直後に落ちた場合。取り直さずに仕上げるだけでよい
      if (total > 0 && offset === total && row.savePath) {
        await this.finish(row.id, row.productRef, row.savePath, partial);
        return;
      }
      if (offset > 0 && (total === 0 || offset < total)) {
        const resumed = this.resumeInterrupted(row, partition, link.url, partial, offset, total);
        if (resumed) return;
      }
    }

    const win = this.openWindow(row.id, partition);
    // ウィンドウを閉じたあとに webContents を触ると例外になるので、ID は先に控える
    const wcId = win.webContents.id;
    this.pending.push({ url: link.url, rowId: row.id, partition, wcId });
    win.webContents.downloadURL(link.url);
    // 何も始まらないまま待ち続けないよう、一定時間で見切る（ログイン切れで HTML が返ったなど）
    setTimeout(() => {
      const i = this.pending.findIndex((w) => w.rowId === row.id && w.wcId === wcId);
      if (i < 0) return;
      this.pending.splice(i, 1);
      this.closeWindow(row.id);
      this.fail(row.id, t('ダウンロードが始まりませんでした（ログインが切れている可能性があります）。'));
      this.pump();
    }, this.opts.startTimeoutMs ?? START_TIMEOUT_MS);
    this.notify();
  }

  /**
   * 中断したダウンロードを続きから。`createInterruptedDownload` は
   * 既にディスクにあるぶんを offset として渡すと、Range付きで取りに行ってくれる。
   * URLは期限付きなので、呼び出し元が取り直した新しいURLで urlChain を組み立てる。
   */
  private resumeInterrupted(
    row: DownloadRow,
    partition: string,
    url: string,
    partialPath: string,
    offset: number,
    total: number
  ): boolean {
    try {
      const s = session.fromPartition(partition);
      this.attachHandler(s);
      this.pending.push({ url, rowId: row.id, partition, wcId: null });
      console.log(
        `[download] 続きから: row=${row.id} offset=${offset} total=${total} etag=${row.etag ?? 'なし'} lm=${row.lastModified ?? 'なし'}`
      );
      s.createInterruptedDownload({
        path: partialPath,
        urlChain: [url],
        offset,
        length: total || offset,
        lastModified: row.lastModified ?? undefined,
        eTag: row.etag ?? undefined
      });
      // 続きからの再開が始まらないまま枠を埋め続けないよう、一定時間で見切る。
      // 次は最初から取り直す（途中までのファイルは捨てる）
      setTimeout(() => {
        const i = this.pending.findIndex((w) => w.rowId === row.id && w.wcId === null);
        if (i < 0) return;
        this.pending.splice(i, 1);
        this.opts.repo.updateDownload(row.id, { savePath: null, receivedBytes: 0, totalBytes: null, etag: null, lastModified: null });
        void fs.promises.rm(partialPath, { force: true }).catch(() => undefined);
        this.fail(row.id, t('続きからの再開が始まりませんでした。最初から取り直します。'));
        this.pump();
      }, this.opts.startTimeoutMs ?? START_TIMEOUT_MS);
      this.notify();
      return true;
    } catch {
      // 続きから取れないときは、呼び出し元がそのまま最初から取りに行く
      this.pending = this.pending.filter((x) => x.rowId !== row.id);
      return false;
    }
  }

  /** DownloadItem を行に結びつけて、保存先と進捗を面倒みる */
  private bind(rowId: number, item: DownloadItem): void {
    const row = this.opts.repo.getDownload(rowId);
    const product = row ? this.opts.repo.getProduct(row.productRef) : null;
    // 終わった行に後から紐づくと、完成したファイルを .part で上書きしてしまう。
    // すでに走っている行に足すのも同じ結果になるので断る
    // （resume() が新しい DownloadItem を作って will-download が二度来ることがある）。
    // 始める準備の間に一時停止・中止されたものも始めない
    if (!row || !product || row.state === 'done' || row.state === 'paused' || row.state === 'canceled' || this.active.has(rowId)) {
      item.cancel();
      if (!this.active.has(rowId)) this.closeWindow(rowId);
      return;
    }

    // ファイルの代わりにページ（ログイン画面・エラー画面）が返ると、Chromium はそれを .htm として保存してしまい、
    // 「完了」に見えていた。HTML はダウンロードとして扱わない
    // （種類が text/html でも、ファイル名に .htm 以外の拡張子が付いていれば実体として受け取る）
    if (/^text\/html/i.test(item.getMimeType()) && !/\.(?!html?$)[a-z0-9]{2,5}$/i.test(item.getFilename())) {
      const where = describeUrl(item.getURL());
      item.cancel();
      this.closeWindow(rowId);
      console.warn(`[download] ファイルではなくページが返りました: row=${rowId} ${where}`);
      this.opts.repo.updateDownload(rowId, { attempts: MAX_ATTEMPTS - 1, savePath: null });
      this.fail(rowId, t('ダウンロードの代わりにページが返りました（{where}）。ログインが切れているか、このアプリではダウンロードできない作品です。', { where }));
      this.pump();
      return;
    }

    // 続きから再開したときは、前回と同じ保存先を使う（別名にすると .part が孤児になる）
    let finalPath = row.savePath ?? '';
    if (!finalPath) {
      const suggested = this.splitPartName(product, row, item) ?? item.getFilename();
      const folder = productFolder(this.root, this.template, product, suggested);
      fs.mkdirSync(folder, { recursive: true });
      // 分割ダウンロードのように、同じ作品の別の行が同じファイル名で同時に始まることがある。
      // 手元にある実体だけを見て名前を決めると、まだ何も落ちていない時点では全員が同じ名前を選び、
      // 同じ .part を奪い合って最後の1本だけが残る。すでにどこかの行が使うと決めた名前も避ける
      const claimed = new Set(
        this.opts.repo
          .listDownloads(100000)
          .filter((d) => d.id !== rowId && d.savePath)
          .map((d) => (d.savePath as string).toLowerCase())
      );
      finalPath = uniqueFileName(
        (p) => fs.existsSync(p) || fs.existsSync(p + PART) || claimed.has(p.toLowerCase()),
        folder,
        suggested
      );
    } else {
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    }
    item.setSavePath(finalPath + PART);
    console.log(
      `[download] 開始: row=${rowId} received=${item.getReceivedBytes()} total=${item.getTotalBytes()} state=${item.getState()}`
    );
    this.active.set(rowId, item);
    this.throttle.add(rowId, item);

    // createInterruptedDownload で作った項目は「中断中」で出てくる。
    // ここで resume() を呼ばないと、続きから取りに行かず止まったままになる。
    if (item.getState() === 'interrupted' && item.canResume()) item.resume();

    this.opts.repo.updateDownload(rowId, {
      state: 'running',
      savePath: finalPath,
      totalBytes: item.getTotalBytes() || null,
      etag: item.getETag() || null,
      lastModified: item.getLastModifiedTime() || null,
      urlChain: JSON.stringify(item.getURLChain())
    });

    let lastNotify = 0;
    item.on('updated', (_e, state) => {
      this.opts.repo.updateDownload(rowId, {
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes() || null,
        // 帯域制限で止めている間は「取得中」のまま見せる
        state:
          state === 'interrupted'
            ? 'paused'
            : item.isPaused() && !this.throttle.isHeld(rowId)
              ? 'paused'
              : 'running'
      });
      const now = Date.now();
      if (now - lastNotify > 700) {
        lastNotify = now;
        this.notify();
      }
    });

    item.once('done', (_e, state) => {
      this.active.delete(rowId);
      this.throttle.remove(rowId);
      this.closeWindow(rowId);
      if (state === 'completed') {
        this.finishing.add(rowId);
        void this.finish(rowId, row.productRef, finalPath, finalPath + PART).finally(() => this.finishing.delete(rowId));
        return;
      }
      if (state === 'cancelled') {
        this.opts.repo.updateDownload(rowId, { state: 'canceled' });
      } else {
        this.fail(rowId, t('通信が中断されました。「続きから」で再開できます。'));
      }
      this.notify();
      this.pump();
    });
  }

  /**
   * 「完了」なのに実体が無く `.part` だけ残っている行を直す（以前の取り違えで起きた）。
   * `.part` が作品のサイズに届いていれば仕上げ、届いていなければ続きから取り直す。
   */
  private async repairFinished(): Promise<void> {
    for (const row of this.opts.repo.listDownloads()) {
      if (row.state !== 'done' || !row.savePath) continue;
      // 実体の有無は「開かずに」確かめる（stat は開くので、大きな新しいファイルだと Defender の検査を待たされる）
      if (fs.existsSync(row.savePath)) continue;
      const part = await fs.promises.stat(row.savePath + PART).catch(() => null);
      if (!part || part.size === 0) continue;
      const expected = row.totalBytes ?? 0;
      console.log(`[download] 完了扱いなのに .part だけ残っている行を直します: row=${row.id} part=${part.size} expected=${expected}`);
      if (expected > 0 && part.size === expected) {
        await this.finish(row.id, row.productRef, row.savePath, row.savePath + PART);
      } else {
        this.opts.repo.updateDownload(row.id, { state: 'queued', receivedBytes: part.size, error: null });
      }
    }
    this.notify();
    this.pump();
  }

  /** `.part` を本来の名前にして、台帳に載せる */
  private async finish(rowId: number, productRef: number, savedPath: string, partPath: string): Promise<void> {
    let finalPath = savedPath;
    try {
      const row = this.opts.repo.getDownload(rowId);
      const candidate = fs.existsSync(partPath) ? partPath : finalPath;
      await verifyTransfer(candidate, row?.totalBytes ?? null, finalPath);
      if (fs.existsSync(partPath)) {
        // 同名の完成品が残っていると rename が失敗する環境があるので、先にどける
        await safeReplace(partPath, finalPath, fs.existsSync(finalPath) ? [finalPath] : [], (backup) => shell.trashItem(backup));
      }
    } catch (err) {
      // 黙って完了にすると、中身が .part のままなのに「取得済み」に見えてしまう
      this.opts.repo.updateDownload(rowId, {
        state: 'paused',
        error: t('保存したファイルの名前を戻せませんでした（{0}）。「続きから」で仕上げ直せます。', { 0: err instanceof Error ? err.message : String(err) })
      });
      this.notify();
      return;
    }
    // 落とし終えた直後のファイルは Defender が検査するので、非同期で大きさを取る
    const size = await fs.promises
      .stat(finalPath)
      .then((st) => st.size)
      .catch(() => -1);
    // 実体が無い・空のまま「完了」にしない（取り違えや、HTML が返ってきた場合に気づけるように）
    if (size <= 0) {
      this.fail(rowId, size < 0 ? t('保存したはずのファイルが見つかりません。もう一度取得します。') : t('空のファイルが保存されました。もう一度取得します。'));
      if (size === 0) await fs.promises.rm(finalPath, { force: true }).catch(() => undefined);
      this.pump();
      return;
    }
    // 取り直したとき: 同じ作品の同名ファイルが手元にあると「名前 (2).zip」で保存される。元をごみ箱へ入れて置き換える
    try {
      finalPath = await this.replaceExisting(rowId, productRef, finalPath);
    } catch (error) {
      this.opts.repo.updateDownload(rowId, { state: 'paused', ...(error instanceof ReplacementCleanupError ? { savePath: error.destination } : {}), error: String(error) });
      this.notify();
      return;
    }
    this.opts.repo.updateDownload(rowId, {
      state: 'done',
      receivedBytes: size,
      savePath: finalPath,
      error: null
    });
    this.opts.repo.addLocalFile({
      productRef,
      path: finalPath,
      sizeBytes: size,
      kind: kindOfFile(finalPath),
      source: 'download'
    });
    this.notify();
    this.pump();
    try {
      this.opts.onFinished?.(productRef, finalPath);
    } catch (err) {
      console.warn('[download] 後処理の登録に失敗:', err);
    }
  }

  /**
   * `名前 (2).zip` が、同じ作品の台帳にある `名前.zip` の取り直しなら、元をごみ箱へ入れて元の名前にする。
   * 置き換えられなければ（使用中など）、新しい名前のまま置いておく。
   * @returns 最終的な置き場所
   */
  private async replaceExisting(rowId: number, productRef: number, saved: string): Promise<string> {
    const ext = path.extname(saved);
    const m = path.basename(saved, ext).match(/^(.*) \((\d+)\)$/);
    if (!m) return saved;
    const original = path.join(path.dirname(saved), `${m[1]}${ext}`);
    const registered = this.opts.repo
      .localFiles(productRef)
      .some((f) => f.path.toLowerCase() === original.toLowerCase());
    if (!registered) return saved;
    // 同じ作品の別の行が落としたファイルは「前回の自分」ではない（分割ダウンロードの別パートなど）。
    // 置き換えると、先に落とし終えたパートをごみ箱へ入れてしまう
    const claimedByOther = this.opts.repo
      .listDownloads(100000)
      .some((d) => d.id !== rowId && d.savePath && d.savePath.toLowerCase() === original.toLowerCase());
    if (claimedByOther) return saved;
    await safeReplace(saved, original, fs.existsSync(original) ? [original] : [], (backup) => shell.trashItem(backup));
    return original;
  }

  private fail(rowId: number, message: string): void {
    const row = this.opts.repo.getDownload(rowId);
    const attempts = (row?.attempts ?? 0) + 1;
    this.opts.repo.updateDownload(rowId, {
      state: attempts >= MAX_ATTEMPTS ? 'error' : 'queued',
      attempts,
      error: message
    });
    this.notify();
  }
}

/** 失敗の理由に出す URL。クエリ（署名などを含む）は出さず、ホストとパスの先頭だけ */
function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname.length > 60 ? `${u.pathname.slice(0, 60)}…` : u.pathname;
    return `${u.host}${p}`;
  } catch {
    return url.slice(0, 80);
  }
}

function kindOfFile(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (['.zip', '.7z', '.rar', '.lzh', '.tar'].includes(ext)) return 'archive';
  if (['.exe', '.msi'].includes(ext)) return 'installer';
  if (['.pdf', '.epub'].includes(ext)) return 'book';
  if (['.mp4', '.mkv', '.wmv', '.avi'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.flac', '.m4a', '.ogg'].includes(ext)) return 'audio';
  return 'other';
}
