import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { retryTransient } from '../fsRetry';
import { listArchive, openEntryStream } from './sevenZip';
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
    let index = null;
    // 開いた直後は Windows の検査と重なって読めないことがある。すぐ 7-Zip に回すと1枚目だけ遅い・出ないので、少し待って読み直す
    for (let i = 0; i < 3 && !index; i++) {
      try {
        index = await readZipIndex(archive);
      } catch {
        if (i < 2) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      }
    }
    const e = index?.byName.get(entry);
    if (index && !e) return new Response('not found', { status: 404 });
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
  if (!media && !rangeHeader) {
    const stream = openEntryStream(req.sevenZip, archive, entry);
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 200,
      headers: { 'Content-Type': mime, 'Cache-Control': 'no-cache' }
    });
  }
  const exe = req.sevenZip;
  const cached = await ensureCached(archive, entry, () => openEntryStream(exe, archive, entry));
  return fileResponse(cached, rangeHeader, mime);
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
    await pipeline(await open(), createWriteStream(part));
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
