import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { t } from '@shared/i18n';
import { isZipPath, readZipIndex } from './zipReader';

/**
 * アーカイブの一覧・展開・中身の読み出しを 7-Zip（7z.exe）で行う。
 *
 * - ZIPの一覧・展開は自前の名前デコードと同じ文字コードを使う。
 *   UTF-8フラグ無しのUTF-8 ZIPもあり、Shift_JIS固定では選択展開が0件になる。
 * - 出力は `-sccUTF-8` で UTF-8 にさせて読む。
 * - パスワード入力で止まらないよう、標準入力はつながない（聞かれたら失敗として返る）。
 */

export interface ArchiveEntry {
  /** アーカイブ内のパス。区切りは '/' に揃える */
  path: string;
  size: number;
  isDir: boolean;
}

const ARCHIVE_EXTS = new Set(['.zip', '.7z', '.rar', '.lzh', '.lha', '.tar', '.cab']);

/**
 * 分割アーカイブの見分け方。
 * - `name.part1.exe` + `name.part2.rar`（WinRAR の自己解凍＋続き。DMM の大きな PC ゲームで見る）
 * - `name.part01.rar` / `name.7z.001` / `name.zip.001`
 * 展開は**先頭の1本だけ**に対して行えば、7-Zip が続きを拾う。
 */
export function splitInfo(file: string): { base: string; index: number } | null {
  const name = path.basename(file);
  let m = /^(.*)\.part0*(\d+)\.(exe|rar)$/i.exec(name);
  if (m) return { base: m[1], index: Number(m[2]) };
  m = /^(.*\.(?:7z|zip|rar))\.0*(\d+)$/i.exec(name);
  if (m) return { base: m[1], index: Number(m[2]) };
  return null;
}

// ── 解凍するだけの exe（自己解凍書庫） ──────────────────────

/**
 * 自己解凍の exe の中身として扱う形式。7-Zip が `Type = …` で名乗る名前（小文字）。
 * インストーラ（NSIS・Inno Setup）や、ふつうの実行ファイル（PE）は含めない。
 */
const SFX_TYPES = new Set(['7z', 'rar', 'rar5', 'zip', 'cab']);
/** 自己解凍書庫と分かった exe（小文字の絶対パス）。isArchiveFile がここを見る */
const sfxFiles = new Set<string>();
const sfxKey = (file: string): string => path.resolve(file).toLowerCase();

/** 自己解凍書庫を調べる対象か（分割の `.partN.exe` は別に扱うので除く） */
export function isSfxCandidate(file: string): boolean {
  return /\.exe$/i.test(file) && !splitInfo(file);
}

/** 自己解凍書庫だと覚えておく（台帳の kind='sfx' から起動時に戻す） */
export function rememberSfx(file: string): void {
  sfxFiles.add(sfxKey(file));
}

/** 自己解凍書庫だと分かっている exe か */
export function isKnownSfx(file: string): boolean {
  return sfxFiles.has(sfxKey(file));
}

/**
 * `7z l -slt` の見出し（書庫そのものの情報）から、自己解凍書庫の形式を取り出す。
 * 書庫でなければ null。パスワード付きも null（開けないので展開の対象にしない）。
 */
export function sfxTypeOf(header: string): string | null {
  const types = [...header.matchAll(/^Type = (.+)$/gm)].map((m) => m[1].trim());
  // NSIS などのインストーラは、中身を取り出せても「解凍するだけ」ではない
  if (types.some((type) => /nsis|inno/i.test(type))) return null;
  const archive = types.find((type) => SFX_TYPES.has(type.toLowerCase()));
  if (!archive) return null;
  if (/^Encrypted = \+/m.test(header)) return null;
  return archive;
}

/**
 * exe が「解凍するだけ」の自己解凍書庫か、7-Zip に聞く。**exe は実行しない。**
 * 書庫の見出しまで読めば分かるので、中身の一覧が流れ始めたら 7-Zip を止める（大きな書庫でも待たない）。
 */
export function detectSfx(exe: string, file: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(exe, ['l', '-slt', '-sccUTF-8', '-scsUTF-8', file], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let buffer = '';
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve(value);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      // 見出しの終わり（ここから中身の一覧）
      const end = buffer.indexOf('\n----------');
      if (end >= 0) finish(sfxTypeOf(buffer.slice(0, end)));
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(sfxTypeOf(buffer)));
  });
}

/** 展開の対象になるアーカイブか。分割の2本目以降は false（先頭だけを対象にする） */
export function isArchiveFile(file: string): boolean {
  const split = splitInfo(file);
  if (split) return split.index === 1;
  if (isKnownSfx(file)) return true;
  return ARCHIVE_EXTS.has(path.extname(file).toLowerCase());
}

/** 分割の2本目以降か（一覧で「展開」ボタンを出さないため） */
export function isSecondaryPart(file: string): boolean {
  const split = splitInfo(file);
  return !!split && split.index > 1;
}

/** 展開先のフォルダ名。拡張子（分割なら .partN.exe まで）を落とす */
export function extractFolderName(file: string): string {
  const split = splitInfo(file);
  if (split) return split.base.replace(/\.(7z|zip|rar)$/i, '');
  return path.basename(file, path.extname(file));
}

function commonArgs(file: string): string[] {
  const args = ['-sccUTF-8', '-scsUTF-8'];
  const ext = path.extname(splitInfo(file)?.base ?? file).toLowerCase();
  if (ext === '.zip' || /\.zip\.\d+$/i.test(file)) args.push('-mcp=932');
  return args;
}

async function archiveArgs(file: string): Promise<string[]> {
  if (isZipPath(file)) {
    try {
      const { legacyCodePage } = await readZipIndex(file);
      return ['-sccUTF-8', '-scsUTF-8', `-mcp=${legacyCodePage}`];
    } catch { /* 分割など自前で読めないZIPは従来の設定を使う */ }
  }
  return commonArgs(file);
}

function friendlyError(code: number | null, stderr: string): string {
  const text = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' / ');
  if (/Wrong password|password/i.test(stderr)) return t('パスワード付きのアーカイブは展開できません。');
  if (/Can not open the file as archive|Cannot open the file as archive/i.test(stderr)) {
    return t('アーカイブとして開けませんでした（壊れているか、未対応の形式です）。');
  }
  if (/There is not enough space|No space left/i.test(stderr)) return t('保存先の空き容量が足りません。');
  return t('7-Zip がエラーで終了しました（code={code}）{1}', { code, 1: text ? `: ${text}` : '' });
}

// ── 一覧 ──────────────────────────────────────────────────

const listCache = new Map<string, { key: string; entries: ArchiveEntry[] }>();

/** `7z l -slt` の出力を読む */
export function parseSltListing(stdout: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  // -ba を付けると先頭のアーカイブ情報が出ず、空行区切りのブロックがそのまま並ぶ
  for (const block of stdout.split(/\r?\n\r?\n/)) {
    let p: string | null = null;
    let size = 0;
    let isDir = false;
    for (const line of block.split(/\r?\n/)) {
      const eq = line.indexOf(' = ');
      if (eq < 0) continue;
      const k = line.slice(0, eq);
      const v = line.slice(eq + 3);
      if (k === 'Path') p = v;
      else if (k === 'Size') size = Number(v) || 0;
      else if (k === 'Folder') isDir = v === '+';
      else if (k === 'Attributes' && /^D/.test(v)) isDir = true;
    }
    if (p !== null && p !== '') entries.push({ path: p.replace(/\\/g, '/'), size, isDir });
  }
  return entries;
}

export async function listArchive(exe: string, file: string): Promise<ArchiveEntry[]> {
  const stat = await fs.stat(file);
  const key = `${stat.size}:${stat.mtimeMs}`;
  const hit = listCache.get(file);
  if (hit && hit.key === key) return hit.entries;

  const { code, stdout, stderr } = await run(exe, ['l', '-slt', '-ba', ...await archiveArgs(file), file]);
  if (code !== 0) throw new Error(friendlyError(code, stderr));
  const entries = parseSltListing(stdout);
  listCache.set(file, { key, entries });
  return entries;
}

// ── 展開 ──────────────────────────────────────────────────

export interface ExtractOptions {
  onProgress?: (fraction: number, message: string | null) => void;
  signal?: AbortSignal;
  /** これに書いたファイル（アーカイブの中のパス、1行1件、UTF-8）だけを展開する */
  includeListFile?: string;
}

/**
 * dest に展開する。進捗は `-bsp1` の「 45% 12 - name」を読む。
 * 終了コード 1 は「警告あり（一部のファイルが開けないなど）」で、成果物はできているので成功扱い。
 */
export async function extractArchive(exe: string, file: string, dest: string, opts: ExtractOptions = {}): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const args = await archiveArgs(file);
  return new Promise((resolve, reject) => {
    const child = spawn(
      exe,
      [
        'x', '-y', '-bsp1', '-bso0', '-bse2', ...args, `-o${dest}`,
        ...(opts.includeListFile ? ['-spd', `-i@${opts.includeListFile}`] : []),
        '--', file
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stderr = '';
    let last = -1;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      // 進捗はバックスペースで同じ行を書き換えてくるので、最後に出た % を拾う
      const all = [...chunk.matchAll(/(\d{1,3})%(?:\s+\d+)?(?:\s+-\s+([^\b\r\n]+))?/g)];
      const m = all[all.length - 1];
      if (!m) return;
      const pct = Math.min(100, Number(m[1]));
      if (pct !== last) {
        last = pct;
        opts.onProgress?.(pct / 100, m[2]?.trim() || null);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    const onAbort = (): void => {
      child.kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(new Error(t('中止しました')));
      if (code === 0 || code === 1) return resolve();
      reject(new Error(friendlyError(code, stderr)));
    });
  });
}

/** 書き込みを拒否されたときの 7-Zip の出力（フォルダー アクセスの制御など） */
export function isAccessDenied(message: string): boolean {
  return /Access is denied|アクセスが拒否|Can not open output file|Cannot open output file|ERROR_ACCESS_DENIED/i.test(message);
}

// ── zip を作る・確かめる ─────────────────────────────────────

export interface PackOptions {
  /** 0 = 無圧縮（FLAC・画像など、もう縮まないもの）/ 5 = 標準 */
  level: 0 | 5;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/**
 * cwd からの相対パスの一覧（listFile。UTF-8・1行1件）を zip に追加する。
 * 既存の zip があれば追記になるので、無圧縮で入れるものと圧縮するものを2回に分けて呼べる。
 * 日本語名は UTF-8 フラグ付きで書く（`-mcu=on`）。
 */
export function packZip(exe: string, cwd: string, listFile: string, out: string, opts: PackOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      exe,
      ['a', '-tzip', `-mx=${opts.level}`, '-mcu=on', '-scsUTF-8', '-sccUTF-8', '-bsp1', '-bso0', '-bse2', '-y', out, `@${listFile}`],
      { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const all = [...chunk.matchAll(/(\d{1,3})%/g)];
      const m = all[all.length - 1];
      if (m) opts.onProgress?.(Math.min(100, Number(m[1])) / 100);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => (stderr += c));
    const onAbort = (): void => {
      child.kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(new Error(t('中止しました')));
      if (code === 0) return resolve();
      reject(new Error(friendlyError(code, stderr)));
    });
  });
}

/** アーカイブの整合性を確かめる（CRC を全部見る） */
export async function testArchive(exe: string, file: string, signal?: AbortSignal): Promise<void> {
  const { code, stderr } = await run(exe, ['t', '-bso0', '-bsp0', ...commonArgs(file), file], signal);
  if (code !== 0) throw new Error(t('作り直した zip の検査に失敗しました: {0}', { 0: friendlyError(code, stderr) }));
}

// ── 1ファイルの読み出し ────────────────────────────────────

/**
 * アーカイブの中の1ファイルを標準出力に流させて、そのストリームを返す。
 * `-spd` でワイルドカード解釈を切り、`--` の後ろに名前を置く（`[` などを含む名前のため）。
 */
export function openEntryStream(exe: string, file: string, entryPath: string): Readable {
  const child = spawn(
    exe,
    ['e', '-so', '-spd', '-bso0', '-bsp0', ...commonArgs(file), '--', file, entryPath.replace(/\//g, '\\')],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  return child.stdout;
}

export async function readEntry(exe: string, file: string, entryPath: string, maxBytes = 256 * 1024 * 1024): Promise<Buffer> {
  const stream = openEntryStream(exe, file, entryPath);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) {
      stream.destroy();
      throw new Error(t('ファイルが大きすぎるため、展開せずには読めません。'));
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

// ── 共通 ──────────────────────────────────────────────────

function run(
  exe: string,
  args: string[],
  signal?: AbortSignal
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    signal?.addEventListener('abort', () => child.kill(), { once: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
