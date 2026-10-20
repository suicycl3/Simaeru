import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { retryTransient } from '../fsRetry';
import { EntryTooLargeError, listArchive, openEntryStream, readEntry } from './sevenZip';
import { isReadable, isZipPath, openEntry, readZipIndex } from './zipReader';
import { t } from '@shared/i18n';

/**
 * アーカイブの中身を「展開せずに」扱う入口。
 *
 * - zip は自前で読む（zipReader）。7-Zip のプロセスを起こさないので、一覧も1ファイルも速い。
 * - それ以外（rar / 7z / 暗号化 zip など）は 7-Zip に回す。
 * - シークが要るもの（音声・動画）で、そのまま切り出せないもの（圧縮された zip エントリ・rar など）は
 *   **一時フォルダに1ファイルだけ書き出して**から Range で返す。大きくなりすぎないよう古いものから消す。
 */

export interface ListedEntry {
  path: string;
  size: number;
  isDir: boolean;
  /** 無圧縮で入っている（Range でそのまま読める） */
  stored?: boolean;
}

export interface ArchiveListing {
  entries: ListedEntry[];
  /** 自前の zip 読み取りで読めた */
  native: boolean;
}

let cacheDir = '';
let cacheLimitBytes = 3 * 1024 * 1024 * 1024;

export function configureArchiveCache(dir: string, limitBytes?: number): void {
  cacheDir = dir;
  if (limitBytes) cacheLimitBytes = limitBytes;
}

export async function listArchiveEntries(file: string, sevenZip: string | null): Promise<ArchiveListing> {
  if (isZipPath(file)) {
    try {
      const index = await readZipIndex(file);
      // 暗号化などで読めないものが混ざっていたら、一覧だけは使えるが読み出しは 7-Zip に回る
      return {
        native: true,
        entries: index.entries.map((e) => ({
          path: e.name.replace(/\/$/, ''),
          size: e.size,
          isDir: e.isDir,
          stored: e.method === 0 && isReadable(e)
        }))
      };
    } catch {
      /* 壊れている・分割 zip など。7-Zip に任せる */
    }
  }
  if (!sevenZip) throw new Error(t('7-Zip が見つからないため、この形式のアーカイブは読めません'));
  const entries = await listArchive(sevenZip, file);
  return { native: false, entries: entries.map((e) => ({ path: e.path, size: e.size, isDir: e.isDir })) };
}

// ── 読み出し ─────────────────────────────────────────────

export interface EntryRequest {
  archive: string;
  entry: string;
  rangeHeader: string | null;
  mime: string;
  sevenZip: string | null;
}

const MEDIA = /^(audio|video)\//;
/** これより小さい圧縮エントリは、キャッシュせずその場で展開して返す */
const STREAM_LIMIT = 64 * 1024 * 1024;

export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (!suffix) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

function rangeResponse(
  open: (range: { start: number; end: number } | null) => Promise<Readable> | Readable,
  size: number,
  rangeHeader: string | null,
  mime: string
): Promise<Response> {
  const headers = new Headers({ 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
  const range = parseRange(rangeHeader, size);
  if (rangeHeader && !range && size > 0) {
    headers.set('Content-Range', `bytes */${size}`);
    return Promise.resolve(new Response(null, { status: 416, headers }));
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  headers.set('Content-Length', String(size === 0 ? 0 : end - start + 1));
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  if (size === 0) return Promise.resolve(new Response(null, { status: 200, headers }));
  return Promise.resolve(open(range ? { start, end } : null)).then(
    (stream) =>
      new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: range ? 206 : 200, headers })
  );
}

/** 実ファイルを Range 付きで返す */
export async function fileResponse(file: string, rangeHeader: string | null, mime: string): Promise<Response> {
  const stat = await retryTransient(() => fs.stat(file));
  return rangeResponse(
    async (r) => (await retryTransient(() => fs.open(file, 'r'))).createReadStream(r ? { start: r.start, end: r.end } : {}),
    stat.size,
    rangeHeader,
    mime
  );
}

export async function entryResponse(req: EntryRequest): Promise<Response> {
  const { archive, entry, rangeHeader, mime } = req;
  const media = MEDIA.test(mime);

  if (isZipPath(archive)) {
    const index = await readZipIndexPatiently(archive);
    const e = index?.byName.get(entry);
    if (index && !e) {
      console.warn(`[mylib] アーカイブの中に見つかりません: ${entry}（${path.basename(archive)}）`);
      return new Response('not found', { status: 404 });
    }
    if (e && isReadable(e)) {
      // 無圧縮: アーカイブの中をそのまま切り出す（コピーもキャッシュも要らない）
      if (e.method === 0) {
        return rangeResponse((r) => openEntry(archive, e, r ?? undefined), e.size, rangeHeader, mime);
      }
      // 圧縮済み・小さい・シーク不要: その場で展開して流す
      if (!media && !rangeHeader && e.size <= STREAM_LIMIT) {
        const stream = await openEntry(archive, e);
        return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
          status: 200,
          headers: { 'Content-Type': mime, 'Content-Length': String(e.size), 'Cache-Control': 'no-cache' }
        });
      }
      const cached = await ensureCached(archive, entry, () => openEntry(archive, e));
      return fileResponse(cached, rangeHeader, mime);
    }
  }

  // 7-Zip に回す
  if (!req.sevenZip) return new Response('7-Zip not found', { status: 501 });
  const exe = req.sevenZip;
  // 7-Zip は、中に無い名前を渡しても何も言わずに空で終わる（終了コードも 0）。一覧（作り置きがある）で先に確かめる
  const listed = await listArchive(exe, archive);
  if (!listed.some((e) => e.path === entry)) {
    console.warn(`[mylib] アーカイブの中に見つかりません（7-Zip）: ${entry}（${path.basename(archive)}）`);
    return new Response('not found', { status: 404 });
  }
  if (!media && !rangeHeader) {
    // 画像など: 取り出し終えてから返す。7-Zip が失敗したら、ここで投げて 500 にする（流しながら返すと、失敗しても
    // 「空の成功」になって画面からは見分けられなかった）。大きすぎるものは一時キャッシュに書き出して返す
    try {
      const body = await readEntry(exe, archive, entry, STREAM_LIMIT);
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { 'Content-Type': mime, 'Content-Length': String(body.length), 'Cache-Control': 'no-cache' }
      });
    } catch (err) {
      if (!(err instanceof EntryTooLargeError)) throw err;
    }
  }
  const cached = await ensureCached(archive, entry, () => openEntryStream(exe, archive, entry));
  return fileResponse(cached, rangeHeader, mime);
}

/** 一時的に開けない（Windows の検査中など）ときの、zip の目次の読み直しの上限 */
const INDEX_PATIENCE_MS = 45_000;
const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * zip の目次を読む。読めなければ null（7-Zip に回す）。
 * 初めて開く zip は Windows の検査が終わるまで開けない（EPERM など）ことがあり、検査は大きな zip で 30 秒ほど続く。
 * 数秒で諦めて 7-Zip に回すと、7-Zip も同じ理由で開けずに失敗していたので、一時的な理由のあいだは待って読み直す。
 * 壊れている・分割などで読めないときは、待たずに 7-Zip に回す
 */
async function readZipIndexPatiently(archive: string): Promise<Awaited<ReturnType<typeof readZipIndex>> | null> {
  const deadline = Date.now() + INDEX_PATIENCE_MS;
  for (;;) {
    try {
      return await readZipIndex(archive);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !TRANSIENT_CODES.has(code) || Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

// ── 一時キャッシュ ───────────────────────────────────────

const inflight = new Map<string, Promise<string>>();

async function ensureCached(archive: string, entry: string, open: () => Promise<Readable> | Readable): Promise<string> {
  if (!cacheDir) throw new Error(t('キャッシュの場所が設定されていません'));
  const stat = await retryTransient(() => fs.stat(archive));
  const key = crypto.createHash('sha1').update(`${archive}|${stat.size}|${stat.mtimeMs}|${entry}`).digest('hex');
  const target = path.join(cacheDir, `${key}${path.extname(entry).toLowerCase()}`);
  try {
    await fs.access(target);
    const now = new Date();
    await fs.utimes(target, now, now).catch(() => undefined);
    return target;
  } catch {
    /* 無い */
  }
  const running = inflight.get(target);
  if (running) return running;
  const job = (async () => {
    await fs.mkdir(cacheDir, { recursive: true });
    const part = `${target}.part`;
    try {
      await pipeline(await open(), createWriteStream(part));
    } catch (err) {
      // 取り出しに失敗した（7-Zip が開けなかったなど）。書きかけを残すと、次も空のまま使ってしまう
      await fs.rm(part, { force: true }).catch(() => undefined);
      throw err;
    }
    // 書き終えた直後は Defender がそのファイルを検査していて、名前を変えられない（EPERM / EBUSY）ことがある。
    // 失敗を 500 で返すと、<audio> は「この形式は再生できない」（エラー 4）で諦めてしまう。少し待ってやり直す
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(part, target);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '') || attempt >= 20) {
          // 名前を変えられなくても中身は書き終えているので、そのまま使う
          return part;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    void trimCache();
    return target;
  })().finally(() => inflight.delete(target));
  inflight.set(target, job);
  return job;
}

/** 上限を超えたら、最後に使った時刻が古いものから消す */
export async function trimCache(): Promise<void> {
  if (!cacheDir) return;
  let names: string[];
  try {
    names = await fs.readdir(cacheDir);
  } catch {
    return;
  }
  const files = (
    await Promise.all(
      names.map(async (n) => {
        const full = path.join(cacheDir, n);
        try {
          const st = await fs.stat(full);
          return { full, size: st.size, used: st.mtimeMs, part: n.endsWith('.part') };
        } catch {
          return null;
        }
      })
    )
  ).filter((f): f is { full: string; size: number; used: number; part: boolean } => !!f);
  let total = files.reduce((s, f) => s + f.size, 0);
  for (const f of files.sort((a, b) => a.used - b.used)) {
    if (total <= cacheLimitBytes) break;
    if (f.part && Date.now() - f.used < 10 * 60 * 1000) continue; // 書き出し中
    await fs.rm(f.full, { force: true }).catch(() => undefined);
    total -= f.size;
  }
}

/** 起動時: 書きかけを片付ける */
export async function cleanCache(): Promise<void> {
  if (!cacheDir) return;
  try {
    for (const n of await fs.readdir(cacheDir)) {
      if (n.endsWith('.part')) await fs.rm(path.join(cacheDir, n), { force: true }).catch(() => undefined);
    }
  } catch {
    /* まだ無い */
  }
  await trimCache();
}
