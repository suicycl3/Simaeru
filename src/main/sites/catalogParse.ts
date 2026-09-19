/**
 * サークル・ブランドの作品一覧（ストアの公開ページ）の読み取り。未購入の作品も含む。
 * 総集編・セットの収録作品を、同じサイトの同じサークルの作品から探すために使う。
 * 通信はしない（取得は catalog.ts）。
 */

export interface CatalogItem {
  productId: string;
  title: string;
  url: string;
}

/** 一覧を取るストアの区分。dlsite はフロア（maniax・home など）ごとに一覧が分かれる */
export type CatalogStore = 'dmm-doujin' | 'dmm-dlsoft' | `dlsite-${string}`;

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return m ? decodeEntities(m[1]) : null;
};

function uniq(items: CatalogItem[]): CatalogItem[] {
  const seen = new Set<string>();
  return items.filter((i) => i.title && !seen.has(i.productId) && seen.add(i.productId));
}

/** DMM 同人のサークルの一覧: 表紙のリンク（cid=）と、その中の画像の alt（タイトル） */
export function parseDoujinMakerList(html: string): CatalogItem[] {
  const out: CatalogItem[] = [];
  const re = /<a\s[^>]*href="https:\/\/www\.dmm\.co\.jp\/dc\/doujin\/-\/detail\/=\/cid=([a-z0-9_]+)\/"[^>]*>\s*<img\s([^>]*)>/gi;
  for (const m of html.matchAll(re)) {
    const title = attr(m[2], 'alt');
    if (title) out.push({ productId: m[1], title: title.trim(), url: `https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=${m[1]}/` });
  }
  return uniq(out);
}

/** DMM PCゲームのブランドの一覧: 作品カードのリンク（title 属性がタイトル） */
export function parseDlsoftMakerList(html: string): CatalogItem[] {
  const out: CatalogItem[] = [];
  for (const m of html.matchAll(/<a\s[^>]*class="component-cardProductBuy__detailLink"[^>]*>/gi)) {
    const href = attr(m[0], 'href');
    const title = attr(m[0], 'title');
    const id = href && /https:\/\/dlsoft\.dmm\.co\.jp\/detail\/([a-z0-9_]+)\//i.exec(href)?.[1];
    if (id && title) out.push({ productId: id, title: title.trim(), url: `https://dlsoft.dmm.co.jp/detail/${id}/` });
  }
  return uniq(out);
}

/** DLsite のサークルの一覧: 作品ごとの計測用の要素（data-product_id・data-work_name） */
export function parseDlsiteCircleList(html: string, floor: string): CatalogItem[] {
  const out: CatalogItem[] = [];
  for (const m of html.matchAll(/<div\s[^>]*data-product_id="([A-Z]{2}\d+)"[^>]*>/g)) {
    const title = attr(m[0], 'data-work_name');
    if (title) out.push({ productId: m[1], title: title.trim(), url: `https://www.dlsite.com/${floor}/work/=/product_id/${m[1]}.html` });
  }
  return uniq(out);
}

/** 一覧のページの URL（page は 1 から） */
export function catalogPageUrl(store: CatalogStore, makerId: string, page: number): string {
  const id = encodeURIComponent(makerId);
  if (store === 'dmm-doujin') {
    return `https://www.dmm.co.jp/dc/doujin/-/list/=/article=maker/id=${id}/${page > 1 ? `page=${page}/` : ''}`;
  }
  if (store === 'dmm-dlsoft') return `https://dlsoft.dmm.co.jp/list/?maker=${id}&sort=date${page > 1 ? `&page=${page}` : ''}`;
  const floor = store.slice('dlsite-'.length);
  return `https://www.dlsite.com/${floor}/circle/profile/=/maker_id/${id}/order/release_d/per_page/100/show_type/1/page/${page}`;
}

export function parseCatalogPage(store: CatalogStore, html: string): CatalogItem[] {
  if (store === 'dmm-doujin') return parseDoujinMakerList(html);
  if (store === 'dmm-dlsoft') return parseDlsoftMakerList(html);
  return parseDlsiteCircleList(html, store.slice('dlsite-'.length));
}

/**
 * 作品から、一覧を取るストアを決める。一覧が無いサイト・区分（電子書籍・動画）や、サークルの ID が無いときは null。
 */
export function catalogStoreOf(p: { siteId: string; floorId: string; makerId: string | null; detailUrl: string | null }): {
  store: CatalogStore;
  makerId: string;
} | null {
  if (!p.makerId) return null;
  if (p.siteId === 'dmm' && p.floorId === 'doujin') return { store: 'dmm-doujin', makerId: p.makerId };
  if (p.siteId === 'dmm' && p.floorId === 'dlsoft') return { store: 'dmm-dlsoft', makerId: p.makerId };
  if (p.siteId === 'dlsite') {
    const floor = /dlsite\.com\/([a-z-]+)\/(?:work|announce)\//i.exec(p.detailUrl ?? '')?.[1] ?? 'maniax';
    return { store: `dlsite-${floor}`, makerId: p.makerId };
  }
  return null;
}
