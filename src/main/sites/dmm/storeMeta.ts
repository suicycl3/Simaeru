import { DmmAuthError, fetchText } from './client';
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
 * HTML構造に依存するので壊れることを前提にし、読めなかったときは空で返す（一覧や同期を巻き込まないため）。
 * ただしログイン切れ・年齢確認（DmmAuthError）だけは作品のせいではないので投げる（呼び出し側が試行回数を進めずに待つ）。
 * 取得は作品を開いたときだけで、同期時には走らせない。
 */

export function fetchDlsoftStoreMeta(contentId: string): Promise<StoreMeta> {
  return fetchStructuredMeta(`https://dlsoft.dmm.co.jp/detail/${encodeURIComponent(contentId)}/`, parseDlsoftStoreHtml);
}

export function fetchDoujinStoreMeta(contentId: string): Promise<StoreMeta> {
  return fetchStructuredMeta(
    `https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=${encodeURIComponent(contentId)}/`,
    parseDoujinStoreHtml
  );
}

/**
 * 項目表のある店舗ページ（PCソフト・同人）を取って読む。
 * 項目表を読めなかったページは、あとで原因を調べるためにアプリログへ様子を残す
 * （出すのは URL と、ページの長さ・目印の有無だけ。本文やヘッダは出さない）。
 */
async function fetchStructuredMeta(url: string, parse: (html: string) => StoreMeta): Promise<StoreMeta> {
  let html: string;
  let meta: StoreMeta;
  try {
    html = await fetchText(url);
    meta = parse(html);
  } catch (err) {
    if (err instanceof DmmAuthError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[store] ${url} を取得できませんでした: ${message}`);
    return /HTTP 404|HTTP 410/.test(message) ? { ...EMPTY_STORE_META, gone: true } : EMPTY_STORE_META;
  }
  if (!meta.structured) {
    const marks = ['contentsDetailBottom__tableDataLeft', 'informationList__ttl', 'application/ld+json', 'age_check']
      .map((m) => `${m}=${html.includes(m) ? 'あり' : 'なし'}`)
      .join(' ');
    console.warn(`[store] ${url} の項目表を読めませんでした（${html.length} 文字 ${marks}）`);
  }
  return meta;
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
