import type { ArchiveWorkType, Category, PdfStripType, WorkType } from './types';
import { ARCHIVE_WORK_TYPES, PDF_STRIP_TYPES } from './types';

/**
 * 落としたアーカイブを「展開して使う」か「圧縮したまま持つ」かの決まり。
 *
 * | 扱い | 対象 | 理由 |
 * |---|---|---|
 * | 展開する（extract） | ゲーム・ツール（PCゲーム区分で種別不明のものを含む）、中身に実行ファイルがあるもの | 展開しないと起動できない。展開後はアーカイブを消すのが既定（設定で残せる） |
 * | 圧縮のまま（archive） | マンガ・CG・ボイス・音楽・動画・小説・その他 | 展開せずにアプリ／NeeView で読める。ファイル数が数百〜数千になるものを散らかさない |
 *
 * DRM 付きの電子書籍・動画はそもそもアーカイブではないので、どちらにも当たらない（保管だけ）。
 */

export type StorageMode = 'extract' | 'archive';

export interface StorageDecision {
  mode: StorageMode;
  reason: string;
}

const EXTRACT_TYPES: WorkType[] = ['game', 'tool'];

export function decideStorage(
  product: { category: Category | string; workType: WorkType | null },
  contents?: { hasExecutable: boolean }
): StorageDecision {
  if (product.workType && EXTRACT_TYPES.includes(product.workType)) {
    return { mode: 'extract', reason: product.workType === 'game' ? 'ゲームは展開して使います' : 'ツールは展開して使います' };
  }
  if (product.category === 'game' && (!product.workType || product.workType === 'other')) {
    return { mode: 'extract', reason: 'PCゲームは展開して使います' };
  }
  // 種別が「その他」「不明」のときは中身で決める
  if ((!product.workType || product.workType === 'other') && contents?.hasExecutable) {
    return { mode: 'extract', reason: '実行ファイルが入っているため展開して使います' };
  }
  return { mode: 'archive', reason: '圧縮したまま保管し、展開せずに閲覧・再生します' };
}

/** 圧縮したまま持つときの種別の区分（設定を引くのに使う）。種別が分からない作品は other */
export function archiveWorkType(product: { workType: WorkType | null }): ArchiveWorkType {
  const w = product.workType as ArchiveWorkType | null;
  return w && ARCHIVE_WORK_TYPES.includes(w) ? w : 'other';
}

/**
 * 画像と同じ内容の PDF を消す対象の種別か。**同人の CG・マンガだけ**
 * （商業の電子書籍やボイス作品の PDF は、本体や台本のことがあるので触らない）。
 */
export function pdfStripType(product: { category: Category | string; workType: WorkType | null }): PdfStripType | null {
  if (product.category !== 'doujin') return null;
  const w = product.workType as PdfStripType | null;
  return w && PDF_STRIP_TYPES.includes(w) ? w : null;
}

/** アーカイブの中身に実行ファイルがあるか（ゲームの手がかり） */
export function hasExecutable(paths: string[]): boolean {
  return paths.some((p) => /\.(exe|msi|bat)$/i.test(p) || /(^|\/)index\.html?$/i.test(p));
}

/** 圧縮してもほぼ縮まない（無圧縮で入れ直す）もの */
export const STORE_EXTS = [
  '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.mp4', '.m4v', '.webm', '.mkv', '.mov',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.zip', '.7z', '.rar', '.pdf'
];
