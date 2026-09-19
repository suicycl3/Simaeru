import fs from 'node:fs/promises';
import path from 'node:path';
import type { AudioGroup, ContentEntry, ContentIndex, LocalFile } from '@shared/types';
import {
  baseName,
  classifyEntry,
  dirName,
  extOf,
  naturalCompare,
  planLossyOnly,
  planPdfStrip,
  versionTags,
  type FileFact
} from '@shared/contentRules';
import { hasExecutable } from '@shared/storagePolicy';
import { isArchiveFile, isSecondaryPart } from '../archive/sevenZip';
import { listArchiveEntries } from '../archive/archiveAccess';
import { retryTransient } from '../fsRetry';
import { archiveEntryUrl, fileUrl } from './localProtocol';
import { t } from '@shared/i18n';

/**
 * 作品の手元のファイル（展開済みフォルダ・アーカイブ・単体ファイル）を見て、
 * 音声のグループ・台本・画像・動画に振り分ける（DESIGN-download.md §6-3, §6-5）。
 *
 * 台本は**置き場所ではなく拡張子で拾う**。サブフォルダの深さや名前が作品ごとに違うため。
 *
 * **ファイル操作はすべて非同期。** メインプロセスで同期に開くと、Defender がアーカイブを
 * 検査している間（数百MBで30秒ほど）ウィンドウごと固まる（実際に「応答なし」になった）。
 */

const MAX_FILES = 20000;
const MAX_DEPTH = 12;
const STAT_BATCH = 64;

/** フォルダを歩いて、相対パスの一覧にする */
export async function walkFolder(root: string): Promise<FileFact[]> {
  const out: FileFact[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let items: import('node:fs').Dirent[];
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = items.filter((i) => i.isFile());
    // stat は並べて投げる（1件ずつ待つと数千ファイルで遅い）
    for (let i = 0; i < files.length && out.length < MAX_FILES; i += STAT_BATCH) {
      const batch = files.slice(i, i + STAT_BATCH);
      const sizes = await Promise.all(
        batch.map((f) =>
          fs
            .stat(path.join(dir, f.name))
            .then((s) => s.size)
            .catch(() => 0)
        )
      );
      batch.forEach((f, k) => out.push({ rel: rel ? `${rel}/${f.name}` : f.name, size: sizes[k], isDir: false }));
    }
    for (const d of items.filter((i) => i.isDirectory())) {
      if (out.length >= MAX_FILES) return;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      out.push({ rel: childRel, size: 0, isDir: true });
      await walk(path.join(dir, d.name), childRel, depth + 1);
    }
  };
  await walk(root, '', 0);
  return out;
}

/**
 * ゲームの素材として入っている音声・画像は、ボイス作品のプレイリストに混ぜない。
 * 実行ファイルか index.html があるフォルダより下は「ゲームの中身」とみなす。
 */
function gameRoots(facts: FileFact[]): string[] {
  return facts
    .filter((f) => !f.isDir && (extOf(f.rel) === '.exe' || /^index\.html?$/i.test(baseName(f.rel))))
    .map((f) => dirName(f.rel));
}

function underAny(rel: string, roots: string[]): boolean {
  return roots.some((r) => (r === '' ? true : rel === r || rel.startsWith(`${r}/`)));
}

interface Sink {
  audio: ContentEntry[];
  documents: ContentEntry[];
  subtitles: ContentEntry[];
  images: ContentEntry[];
  videos: ContentEntry[];
  books: ContentEntry[];
  wavBytes: number;
  wavCount: number;
}

function collect(
  sink: Sink,
  facts: FileFact[],
  container: string,
  inArchive: boolean,
  urlOf: (rel: string) => string
): { wavBytes: number; wavCount: number } {
  const games = gameRoots(facts);
  let wavBytes = 0;
  let wavCount = 0;
  for (const f of facts) {
    if (f.isDir) continue;
    if (extOf(f.rel) === '.wav') {
      wavBytes += f.size;
      wavCount++;
    }
    const cls = classifyEntry(f.rel);
    if (cls === 'other') continue;
    const entry: ContentEntry = {
      url: urlOf(f.rel),
      relPath: f.rel,
      name: baseName(f.rel),
      size: f.size,
      container,
      inArchive
    };
    const inGame = underAny(f.rel, games);
    switch (cls) {
      case 'audio':
        if (!inGame) sink.audio.push(entry);
        break;
      case 'document':
        // ゲームの中の html（index.html など）は読み物ではない。txt / pdf は説明書として拾う
        if (!inGame || ['.txt', '.pdf'].includes(extOf(f.rel))) {
          if (!(inGame && /\.html?$/i.test(f.rel))) sink.documents.push(entry);
        }
        break;
      case 'subtitle':
        sink.subtitles.push(entry);
        break;
      case 'scriptImage':
        sink.documents.push(entry);
        break;
      case 'image':
        if (!inGame) sink.images.push(entry);
        break;
      case 'video':
        if (!inGame) sink.videos.push(entry);
        break;
      case 'book':
        sink.books.push(entry);
        break;
    }
  }
  sink.wavBytes += wavBytes;
  sink.wavCount += wavCount;
  return { wavBytes, wavCount };
}

/** 音声を「1フォルダ = 1グループ」にまとめる（§6-5） */
export function groupAudio(audio: ContentEntry[]): AudioGroup[] {
  const byContainer = new Map<string, Map<string, ContentEntry[]>>();
  for (const a of audio) {
    // 展開済みフォルダやアーカイブが複数ある作品もあるので、置き場所ごとに分ける
    const folders = byContainer.get(a.container) ?? new Map<string, ContentEntry[]>();
    const list = folders.get(dirName(a.relPath)) ?? [];
    list.push(a);
    folders.set(dirName(a.relPath), list);
    byContainer.set(a.container, folders);
  }
  const multi = byContainer.size > 1;
  const groups: AudioGroup[] = [];
  for (const [container, folders] of byContainer) {
    for (const [folder, tracks] of folders) {
      tracks.sort((a, b) => naturalCompare(a.name, b.name));
      const leaf = folder.split('/').pop() || (multi ? baseName(container) : '（ルート）');
      groups.push({
        folder: multi ? `${baseName(container)}/${folder}` : folder,
        label: leaf,
        tags: versionTags(folder),
        tracks
      });
    }
  }
  // 特典・おまけは本編のあとに並べる
  const bonus = (g: AudioGroup): number => (g.tags.includes('特典') ? 1 : 0);
  return groups.sort((a, b) => bonus(a) - bonus(b) || naturalCompare(a.folder, b.folder));
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function buildContentIndex(
  productRef: number,
  files: LocalFile[],
  sevenZip: string | null,
  extractedFrom: (archive: string) => LocalFile | null
): Promise<ContentIndex> {
  const sink: Sink = { audio: [], documents: [], subtitles: [], images: [], videos: [], books: [], wavBytes: 0, wavCount: 0 };
  const sources: ContentIndex['sources'] = [];
  const archives: ContentIndex['archives'] = [];
  const lossyOnly: ContentIndex['lossyOnly'] = [];
  const pdfStrip: ContentIndex['pdfStrip'] = [];
  const addLossy = (container: string, inArchive: boolean, facts: FileFact[]): void => {
    const plan = planLossyOnly(facts.filter((f) => !f.isDir).map((f) => ({ path: f.rel, size: f.size })));
    if (plan.remove.length > 0) lossyOnly.push({ container, inArchive, count: plan.remove.length, bytes: plan.removeBytes, kept: plan.kept.length });
    const pdf = planPdfStrip(facts.filter((f) => !f.isDir).map((f) => ({ path: f.rel, size: f.size })));
    if (pdf.remove.length > 0) {
      pdfStrip.push({ container, inArchive, count: pdf.remove.length, bytes: pdf.removeBytes, names: pdf.remove.map((r) => r.path) });
    }
  };
  let audioInArchive = false;

  for (const file of files) {
    if (file.missingAt) continue;
    const stat = await retryTransient(() => fs.stat(file.path)).catch((err: NodeJS.ErrnoException) => {
      // 黙って飛ばすと「中身が空」に見えてしまう。理由を残す
      sources.push({ path: file.path, kind: 'file', error: t('ファイルを読めませんでした（{0}）', { 0: err.code ?? err.message }) });
      return null;
    });
    if (!stat) continue;
    if (stat.isDirectory()) {
      sources.push({ path: file.path, kind: 'folder' });
      const walked = await walkFolder(file.path);
      collect(sink, walked, file.path, false, (rel) => fileUrl(path.join(file.path, rel)));
      addLossy(file.path, false, walked);
      continue;
    }
    if (isSecondaryPart(file.path)) continue;
    if (isArchiveFile(file.path)) {
      // 展開済みなら中身はそちらで並べる（同じ中身を二重に並べない）。概要だけは出す
      const extracted = extractedFrom(file.path);
      const hasExtracted = !!extracted && (await exists(extracted.path));
      try {
        const listing = await listArchiveEntries(file.path, sevenZip);
        sources.push({ path: file.path, kind: 'archive' });
        const before = sink.audio.length;
        const facts = listing.entries.map((e) => ({ rel: e.path, size: e.size, isDir: e.isDir }));
        const wav = hasExtracted
          ? {
              wavCount: facts.filter((f) => !f.isDir && extOf(f.rel) === '.wav').length,
              wavBytes: facts.filter((f) => !f.isDir && extOf(f.rel) === '.wav').reduce((s, f) => s + f.size, 0)
            }
          : collect(sink, facts, file.path, true, (rel) => archiveEntryUrl(file.path, rel));
        if (sink.audio.length > before) audioInArchive = true;
        if (!hasExtracted) addLossy(file.path, true, facts);
        const fileEntries = listing.entries.filter((e) => !e.isDir);
        archives.push({
          path: file.path,
          files: fileEntries.length,
          uncompressedBytes: fileEntries.reduce((s, e) => s + e.size, 0),
          wavCount: wav.wavCount,
          wavBytes: wav.wavBytes,
          hasExecutable: hasExecutable(fileEntries.map((e) => e.path)),
          native: listing.native,
          storedMedia: fileEntries.filter((e) => e.stored).length
        });
      } catch (err) {
        sources.push({ path: file.path, kind: 'archive', error: t('中身を読めませんでした: {0}', { 0: err instanceof Error ? err.message : String(err) }) });
      }
      continue;
    }
    // 単体のファイル（PDF や mp4 をそのまま落とした作品）
    sources.push({ path: file.path, kind: 'file' });
    const dir = path.dirname(file.path);
    collect(sink, [{ rel: path.basename(file.path), size: stat.size, isDir: false }], dir, false, (rel) =>
      fileUrl(path.join(dir, rel))
    );
  }

  const sortEntries = (list: ContentEntry[]): ContentEntry[] => list.sort((a, b) => naturalCompare(a.relPath, b.relPath));

  return {
    productRef,
    sources,
    archives,
    lossyOnly,
    pdfStrip,
    audioGroups: groupAudio(sink.audio),
    documents: sortEntries(sink.documents),
    subtitles: sortEntries(sink.subtitles),
    images: sortEntries(sink.images),
    videos: sortEntries(sink.videos),
    books: sortEntries(sink.books),
    wavBytes: sink.wavBytes,
    wavCount: sink.wavCount,
    audioOnlyInArchive: audioInArchive,
    storage: null
  };
}
