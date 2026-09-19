import { getWwwHtmlOrNull } from './client';
import { parseDlsiteWorkPage, type DlsiteStoreMeta } from './storeParse';

/**
 * 作品ページから、play API に無いメタ（説明文・スタッフ・容量・動作環境）を取る。
 * ページが消えている作品（販売終了、まとめ買い専用の収録作品など）は null を返す。
 */
export async function fetchDlsiteStoreMeta(detailUrl: string): Promise<DlsiteStoreMeta | null> {
  const html = await getWwwHtmlOrNull(detailUrl);
  return html ? parseDlsiteWorkPage(html) : null;
}

export type { DlsiteStoreMeta };
