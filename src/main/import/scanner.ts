import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { Repo } from '../db/repo';
import { buildMatchIndex, isRuntimeDir, isScanTarget, matchFile, type CandidateProduct, type MatchResult } from './matcher';
import { t } from '@shared/i18n';

/**
 * 手元のフォルダを走査して、購入済み作品と突き合わせる。
 *
 * **読み取りだけ。** ファイルの移動も改名もしない（ユーザーの既存の整理を壊さないため）。
 * 作品IDが1件だけ一致したものは自動で紐付け、それ以外は候補として返してユーザーに選ばせる。
 */

/** 判断待ちのファイル1件 */
export interface ScanFile {
  path: string;
  sizeBytes: number;
}

/**
 * 同じフォルダにあって候補も同じファイルのまとまり。
 * 同じフォルダのファイルは同じ作品の一部（分割書庫・特典・説明書など）であることが多いので、
 * 1件ずつ同じ候補を並べ直さず、まとめて1回で紐付けられるようにする。
 */
export interface ScanGroup {
  /** まとめた親フォルダ（絶対パス） */
  dir: string;
  /** 画面に出すフォルダ名 */
  label: string;
  files: ScanFile[];
  /** 合計バイト数 */
  sizeBytes: number;
  candidates: Array<{ productId: number; title: string; confidence: string; reason: string }>;
}

export interface ScanResult {
  /** 走査したファイル数 */
  scanned: number;
  /** 作品IDで自動確定した数 */
  linked: number;
  /** すでに登録済みで飛ばした数 */
  skipped: number;
  /** ユーザーの判断が要るもの（フォルダごとにまとめたもの） */
  pending: ScanGroup[];
}

const MAX_DEPTH = 6;
/** 判断待ちが増えすぎても扱えないので上限を決める */
const MAX_PENDING = 400;
/** まとめる前の判断待ちファイルの上限。1フォルダに数千個ある場合に備える */
const MAX_PENDING_FILES = 5_000;

// 走査は非同期で行う。同期で数千ファイルを stat すると、そのあいだウィンドウごと固まる
async function walk(
  dir: string,
  depth: number,
  out: string[],
  onProgress: (n: number) => void,
  skipDirs: Set<string>
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  // 台帳に載っているフォルダ（展開したゲームなど）の中は、その作品の一部なので個別に拾わない
  if (skipDirs.has(path.resolve(dir).toLowerCase())) return;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // 読めないフォルダは飛ばす
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // DirectX など同梱のランタイムは作品ではないので中を見ない
      if (isRuntimeDir(entry.name)) continue;
      await walk(full, depth + 1, out, onProgress, skipDirs);
    } else if (entry.isFile() && isScanTarget(entry.name)) {
      out.push(full);
      if (out.length % 200 === 0) onProgress(out.length);
    }
  }
}

/** パスから突き合わせに使う名前（ファイル名＋親フォルダ3階層）を作る */
export function pathParts(file: string): string[] {
  const parts = file.split(path.sep);
  return parts.slice(Math.max(0, parts.length - 4));
}

export async function scanFolders(
  repo: Repo,
  folders: string[],
  onProgress: (message: string) => void
): Promise<ScanResult> {
  // 作品側の正規化は走査の前に1度だけ。フォルダをいくつ指定しても、この索引を使い回す
  const index = buildMatchIndex(repo.allProductsForMatching() as CandidateProduct[]);
  const known = repo.knownLocalPaths();
  const skipDirs = new Set(
    repo
      .allLocalFiles()
      .filter((f) => f.kind === 'folder')
      .map((f) => path.resolve(f.path).toLowerCase())
  );

  const files: string[] = [];
  for (const folder of folders) {
    onProgress(t('走査中: {folder}', { folder }));
    await walk(folder, 0, files, (n) => onProgress(t('走査中: {n} 件', { n })), skipDirs);
  }

  const result: ScanResult = { scanned: files.length, linked: 0, skipped: 0, pending: [] };
  const unresolved: Array<{ file: string; sizeBytes: number; match: MatchResult }> = [];

  for (const [i, file] of files.entries()) {
    if (i % 200 === 0) onProgress(t('照合中: {i}/{length}', { i, length: files.length }));
    if (known.has(file)) {
      result.skipped++;
      continue;
    }
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) continue;
    const size = stat.size;

    const match: MatchResult = matchFile(pathParts(file), index);
    if (match.decided && match.candidates[0]) {
      repo.addLocalFile({
        productRef: match.candidates[0].product.id,
        path: file,
        sizeBytes: size,
        kind: kindOf(file),
        source: 'scan'
      });
      result.linked++;
      continue;
    }
    if (unresolved.length < MAX_PENDING_FILES) unresolved.push({ file, sizeBytes: size, match });
  }

  result.pending = groupPending(unresolved).slice(0, MAX_PENDING);
  onProgress(
    t('完了: {linked} 件を自動で紐付け / {length} 件は要確認', {
      linked: result.linked,
      length: result.pending.length
    })
  );
  return result;
}

/** 候補の並びを比べるための印。同じ作品の組み合わせなら同じ文字列になる */
function signatureOf(match: MatchResult): string {
  return match.candidates
    .map((c) => c.product.id)
    .sort((a, b) => a - b)
    .join(',');
}

/**
 * 判断待ちをフォルダごとにまとめる。
 *
 * 同じフォルダでも候補が食い違うファイル（それぞれ別の作品IDが付いているなど）は分けたままにする。
 * 勝手に1つの作品へ寄せると、まとめて紐付けたときに取り違えるため。
 * 候補が出なかったファイルは、そのフォルダの読みが1通りしかないときだけ、そこへ合流させる。
 */
export function groupPending(
  items: Array<{ file: string; sizeBytes: number; match: MatchResult }>
): ScanGroup[] {
  const byDir = new Map<string, Array<{ file: string; sizeBytes: number; match: MatchResult }>>();
  for (const item of items) {
    const dir = path.dirname(item.file);
    const list = byDir.get(dir);
    if (list) list.push(item);
    else byDir.set(dir, [item]);
  }

  const groups: ScanGroup[] = [];
  for (const [dir, list] of byDir) {
    const signatures = [...new Set(list.map((i) => signatureOf(i.match)).filter((sig) => sig !== ''))];
    const only = signatures.length === 1 ? signatures[0] : null;
    const buckets = new Map<string, ScanGroup>();
    for (const item of list) {
      const sig = signatureOf(item.match);
      // 候補なしのファイルは、フォルダの読みが1通りのときだけそこへ入れる
      const key = sig === '' && only ? only : sig;
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.files.push({ path: item.file, sizeBytes: item.sizeBytes });
        bucket.sizeBytes += item.sizeBytes;
        continue;
      }
      const source = sig === '' && only ? list.find((i) => signatureOf(i.match) === only)! : item;
      buckets.set(key, {
        dir,
        label: path.basename(dir) || dir,
        files: [{ path: item.file, sizeBytes: item.sizeBytes }],
        sizeBytes: item.sizeBytes,
        candidates: source.match.candidates.map((c) => ({
          productId: c.product.id,
          title: c.product.title,
          confidence: c.confidence,
          reason: c.reason
        }))
      });
    }
    groups.push(...buckets.values());
  }
  return groups;
}

function kindOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (['.zip', '.7z', '.rar', '.lzh', '.tar'].includes(ext)) return 'archive';
  if (['.exe', '.msi'].includes(ext)) return 'installer';
  if (['.pdf', '.epub'].includes(ext)) return 'book';
  if (['.mp4', '.mkv', '.wmv', '.avi'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.flac', '.m4a', '.ogg'].includes(ext)) return 'audio';
  return 'other';
}
