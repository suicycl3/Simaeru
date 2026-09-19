import fs from 'node:fs/promises';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { retryTransient } from '../fsRetry';
import { t } from '@shared/i18n';

/**
 * zip の中央ディレクトリを自前で読む（外部プロセスを起こさない）。
 *
 * 画像を1枚読むたびに 7-Zip を起動していると、ページ送りのたびに数十〜百ms待たされる。
 * zip は末尾の中央ディレクトリに全ファイルの位置が書いてあるので、
 * - 一覧: 末尾を数KB〜数MB読むだけ
 * - 1ファイル: その位置から読むだけ（無圧縮ならそのまま、deflate なら zlib で展開）
 * で済む。**無圧縮のエントリは Range でそのまま切り出せる**ので、音声・動画のシークも速い。
 *
 * 対応: 無圧縮(0) / deflate(8)、ZIP64、UTF-8 フラグ、Info-ZIP Unicode Path。
 * 暗号化・その他の圧縮方式は「未対応」として返し、呼び出し側が 7-Zip に回す。
 */

export interface ZipEntry {
  /** '/' 区切り。フォルダは末尾が '/' */
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  isDir: boolean;
}

export interface ZipIndex {
  file: string;
  size: number;
  mtimeMs: number;
  entries: ZipEntry[];
  byName: Map<string, ZipEntry>;
  /** UTF-8フラグのない名前を外部ツールで読む際のコードページ。 */
  legacyCodePage: 932 | 65001;
}

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MAX_CENTRAL_DIRECTORY = 256 * 1024 * 1024;

const utf8 = new TextDecoder('utf-8', { fatal: true });
const utf8Loose = new TextDecoder('utf-8');
const sjis = new TextDecoder('shift_jis');

/**
 * ファイル名の文字コード。UTF-8 フラグがあれば UTF-8。無ければ、
 * 正しい UTF-8 として読めるなら UTF-8（Mac で作った zip）、読めなければ Shift_JIS（Windows の日本語 zip）。
 */
export function decodeName(bytes: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return utf8Loose.decode(bytes);
  if (bytes.every((b) => b < 0x80)) return utf8Loose.decode(bytes);
  try {
    return utf8.decode(bytes);
  } catch {
    return sjis.decode(bytes);
  }
}

export class UnsupportedZipEntry extends Error {}

const cache = new Map<string, ZipIndex>();
const CACHE_LIMIT = 40;

export async function readZipIndex(file: string): Promise<ZipIndex> {
  const handle = await retryTransient(() => fs.open(file, 'r'));
  try {
    const stat = await handle.stat();
    const hit = cache.get(file);
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
      // よく使うものを後ろへ（古いものから捨てる）
      cache.delete(file);
      cache.set(file, hit);
      return hit;
    }

    const read = async (position: number, length: number): Promise<Buffer> => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, position);
      return bytesRead === length ? buf : buf.subarray(0, bytesRead);
    };

    // 末尾から「中央ディレクトリの終わり」を探す（コメントが最大 65535 バイト付くことがある）
    const tailLength = Math.min(stat.size, 22 + 65535 + 20);
    const tail = await read(stat.size - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error(t('zip の終端が見つかりません（壊れているか zip ではありません）'));

    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== SIG_ZIP64_LOCATOR) throw new Error(t('ZIP64 の情報が見つかりません'));
      const z64Offset = Number(tail.readBigUInt64LE(loc + 8));
      const z64 = await read(z64Offset, 56);
      if (z64.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw new Error(t('ZIP64 の終端が壊れています'));
      count = Number(z64.readBigUInt64LE(32));
      cdSize = Number(z64.readBigUInt64LE(40));
      cdOffset = Number(z64.readBigUInt64LE(48));
    }
    if (cdSize > MAX_CENTRAL_DIRECTORY) throw new Error(t('中央ディレクトリが大きすぎます'));

    const cd = await read(cdOffset, cdSize);
    const entries: ZipEntry[] = [];
    let legacyCodePage: 932 | 65001 = 65001;
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(t('中央ディレクトリが壊れています'));
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc32 = cd.readUInt32LE(p + 16);
      let compressedSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLength = cd.readUInt16LE(p + 28);
      const extraLength = cd.readUInt16LE(p + 30);
      const commentLength = cd.readUInt16LE(p + 32);
      let localHeaderOffset = cd.readUInt32LE(p + 42);
      const nameBytes = cd.subarray(p + 46, p + 46 + nameLength);
      if ((flags & 0x800) === 0) {
        try { utf8.decode(nameBytes); } catch { legacyCodePage = 932; }
      }
      const extra = cd.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);

      let unicodeName: string | null = null;
      for (let e = 0; e + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(e);
        const len = extra.readUInt16LE(e + 2);
        const body = extra.subarray(e + 4, e + 4 + len);
        if (id === 0x0001) {
          // ZIP64: 32bit で溢れた項目だけが、この順で入っている
          let q = 0;
          if (size === 0xffffffff && q + 8 <= body.length) {
            size = Number(body.readBigUInt64LE(q));
            q += 8;
          }
          if (compressedSize === 0xffffffff && q + 8 <= body.length) {
            compressedSize = Number(body.readBigUInt64LE(q));
            q += 8;
          }
          if (localHeaderOffset === 0xffffffff && q + 8 <= body.length) {
            localHeaderOffset = Number(body.readBigUInt64LE(q));
          }
        } else if (id === 0x7075 && body.length > 5) {
          unicodeName = utf8Loose.decode(body.subarray(5));
        }
        e += 4 + len;
      }

      const name = (unicodeName ?? decodeName(nameBytes, (flags & 0x800) !== 0)).replace(/\\/g, '/');
      entries.push({
        name,
        method,
        flags,
        crc32,
        compressedSize,
        size,
        localHeaderOffset,
        isDir: name.endsWith('/')
      });
      p += 46 + nameLength + extraLength + commentLength;
    }

    const index: ZipIndex = {
      file,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      entries,
      legacyCodePage,
      byName: new Map(entries.map((e) => [e.name.replace(/\/$/, ''), e]))
    };
    cache.set(file, index);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    return index;
  } finally {
    await handle.close();
  }
}

/** この形式のまま読めるか（読めなければ 7-Zip に回す） */
export function isReadable(entry: ZipEntry): boolean {
  return (entry.flags & 0x1) === 0 && (entry.method === 0 || entry.method === 8);
}

/** データ本体の開始位置（ローカルヘッダの長さは中央ディレクトリと違うことがあるので読み直す） */
export async function dataOffset(file: string, entry: ZipEntry): Promise<number> {
  const handle = await retryTransient(() => fs.open(file, 'r'));
  try {
    const buf = Buffer.alloc(30);
    await handle.read(buf, 0, 30, entry.localHeaderOffset);
    if (buf.readUInt32LE(0) !== SIG_LOCAL) throw new Error(t('ローカルヘッダが壊れています'));
    return entry.localHeaderOffset + 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
  } finally {
    await handle.close();
  }
}

/**
 * エントリの中身を流す。start/end は展開後のバイト位置（両端を含む）。
 * 無圧縮なら範囲をそのまま切り出す。deflate は頭から展開するので範囲指定はできない。
 */
export async function openEntry(
  file: string,
  entry: ZipEntry,
  range?: { start: number; end: number }
): Promise<Readable> {
  if (!isReadable(entry)) throw new UnsupportedZipEntry(t('未対応の zip エントリです（method={method}）', { method: entry.method }));
  const offset = await dataOffset(file, entry);
  if (entry.method !== 0 && range && (range.start > 0 || range.end < entry.size - 1)) {
    throw new UnsupportedZipEntry(t('圧縮されたエントリは範囲指定で読めません'));
  }
  // 開くところで一時的に断られることがあるので、やり直してから流す
  const handle = await retryTransient(() => fs.open(file, 'r'));
  if (entry.method === 0) {
    const start = range?.start ?? 0;
    const end = range?.end ?? entry.size - 1;
    if (entry.size === 0) return handle.createReadStream({ start: offset, end: offset - 1 });
    return handle.createReadStream({ start: offset + start, end: offset + end });
  }
  const raw = handle.createReadStream({ start: offset, end: offset + Math.max(0, entry.compressedSize - 1) });
  const inflate = zlib.createInflateRaw();
  raw.on('error', (err) => inflate.destroy(err));
  return raw.pipe(inflate);
}

export function isZipPath(file: string): boolean {
  return /\.zip$/i.test(file);
}
