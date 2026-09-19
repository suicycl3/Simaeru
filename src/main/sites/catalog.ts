import { fetchText, politeDelay } from './dmm/client';
import { getWwwHtml } from './dlsite/client';
import { catalogPageUrl, parseCatalogPage, type CatalogItem, type CatalogStore } from './catalogParse';

/** 一覧のページを読む上限（DLsite は 1 ページ 100 件、DMM は 50〜120 件） */
const MAX_PAGES = 20;

/**
 * サークル・ブランドの作品一覧（未購入の作品を含む）を、ページを送りながら取る。
 * 新しい作品が出てこなくなったページで終える。
 */
export async function fetchMakerCatalog(store: CatalogStore, makerId: string): Promise<CatalogItem[]> {
  const items = new Map<string, CatalogItem>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = catalogPageUrl(store, makerId, page);
    let html: string;
    try {
      html = store.startsWith('dlsite-') ? await getWwwHtml(url) : await fetchText(url);
    } catch (err) {
      // 最後のページの次は 404 になる（DLsite）。2 ページ目以降なら、そこで終わり
      if (page > 1 && /HTTP 404/.test(err instanceof Error ? err.message : String(err))) break;
      throw err;
    }
    const found = parseCatalogPage(store, html);
    let added = 0;
    for (const item of found) {
      if (items.has(item.productId)) continue;
      items.set(item.productId, item);
      added++;
    }
    if (added === 0) break;
    await politeDelay(600);
  }
  return [...items.values()];
}
