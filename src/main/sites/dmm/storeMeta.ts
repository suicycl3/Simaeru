import { fetchText } from './client';
import {
  EMPTY_STORE_META,
  parseBookStoreHtml,
  parseDlsoftStoreHtml,
  parseDoujinStoreHtml,
  type StoreMeta
} from './storeMetaParse';

export type { StoreMeta } from './storeMetaParse';

/**
 * 店舗ページからの作品メタ取得。
 * HTML構造に依存するので壊れることを前提にし、失敗しても例外は投げず空で返す
 * （一覧や同期を巻き込まないため）。取得は作品を開いたときだけで、同期時には走らせない。
 */

export async function fetchDlsoftStoreMeta(contentId: string): Promise<StoreMeta> {
  try {
    const html = await fetchText(
      `https://dlsoft.dmm.co.jp/detail/${encodeURIComponent(contentId)}/`
    );
    return parseDlsoftStoreHtml(html);
  } catch {
    return EMPTY_STORE_META;
  }
}

/**
 * 電子書籍の店舗ページ。アダルトと一般でホストが違う（book.dmm.co.jp / book.dmm.com）が、
 * 本棚APIが返す product_url にどちらも含まれているので、そのURLをそのまま使う。
 */
export async function fetchBookStoreMeta(
  productUrl: string
): Promise<StoreMeta & { resolvedUrl: string | null }> {
  // 保存済みURLのホストが逆（一般作品なのに co.jp 等）でも自力で直せるよう、
  // 失敗したらもう一方のホストで引き直す。
  const alt = productUrl.includes('book.dmm.co.jp')
    ? productUrl.replace('book.dmm.co.jp', 'book.dmm.com')
    : productUrl.replace('book.dmm.com', 'book.dmm.co.jp');

  for (const url of [productUrl, alt]) {
    try {
      const meta = parseBookStoreHtml(await fetchText(url));
      if (meta.ok) return { ...meta, resolvedUrl: url };
    } catch {
      /* 次のホストを試す */
    }
  }
  return { ...EMPTY_STORE_META, resolvedUrl: null };
}

export async function fetchDoujinStoreMeta(contentId: string): Promise<StoreMeta> {
  try {
    const html = await fetchText(
      `https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=${encodeURIComponent(contentId)}/`
    );
    return parseDoujinStoreHtml(html);
  } catch {
    return EMPTY_STORE_META;
  }
}
