import type { ProductVolume, VolumeSet } from '@shared/types';
import { DmmAuthError, fetchJson, politeDelay } from './client';

/**
 * 電子書籍のシリーズ内の巻一覧。
 *
 * 本棚API（/ajax/bff/library/）は**シリーズ単位**でしか返さないため、
 * 「このシリーズのどの巻を持っているか」は分からない。巻の一覧はこちら:
 *
 *   GET /ajax/bff/contents_book/?shop_name={adult|general}&series_id={sid}
 *       &page=N&per_page=M&last_read_position=0&order=asc&purchase_status=all&format_webp=1
 *
 * 呼び出し方は book.dmm.co.jp のJSチャンク（9697-*.js）から読み取った本家と同じ。
 * レスポンスは全巻ぶん返り、**所持している巻にだけ `purchased` が入る**
 * （本家も `volume_books.map(v => v.purchased ? 所持 : 未所持)` で判定している）。
 * 未ログインだと全巻 `purchased: null` になるので、その場合は所持0巻に見える。
 */

interface VolumeBook {
  content_id?: string | null;
  title?: string | null;
  volume_number?: number | null;
  content_publish_date?: string | null;
  image_urls?: { pt?: string | null; ps?: string | null; pl?: string | null } | null;
  product_url?: string | null;
  purchased?: {
    streaming_url?: string | null;
    download_url?: string | null;
    appendix?: { streaming?: unknown[]; download?: unknown[] } | null;
  } | null;
}

interface ContentsResponse {
  volume_books?: VolumeBook[] | null;
  pager?: { page: number; per_page: number; total_count: number } | null;
}

/** 1ページの取得件数。本家は可変だが、巻数の多いシリーズでも数回で済む値にする */
const PER_PAGE = 100;
/** 事故防止の上限（＝最大 3000 巻） */
const MAX_PAGES = 30;

function toVolume(v: VolumeBook): ProductVolume | null {
  if (!v.content_id) return null;
  return {
    contentId: v.content_id,
    volumeNumber: typeof v.volume_number === 'number' ? v.volume_number : null,
    title: v.title ?? '',
    publishedAt: v.content_publish_date ? v.content_publish_date.slice(0, 10) : null,
    coverUrl: v.image_urls?.pt ?? v.image_urls?.ps ?? v.image_urls?.pl ?? null,
    streamingUrl: v.purchased?.streaming_url || null,
    downloadUrl: v.purchased?.download_url || null
  };
}

/** レスポンス1ページぶんを共通形へ。通信を持たないので実データで検証できる */
export function parseVolumePage(res: ContentsResponse): {
  total: number | null;
  owned: ProductVolume[];
  count: number;
} {
  const books = res.volume_books ?? [];
  const owned: ProductVolume[] = [];
  for (const b of books) {
    // purchased が入っている巻＝所持している巻
    if (!b.purchased) continue;
    const volume = toVolume(b);
    if (volume) owned.push(volume);
  }
  return { total: res.pager?.total_count ?? null, owned, count: books.length };
}

/**
 * シリーズの所持巻を列挙する。URLは本棚APIが返す product_url
 * （https://book.dmm.{co.jp|com}/product/{seriesId}/{contentId}/）から
 * ホストと series_id を割り出す（アダルト=book.dmm.co.jp / 一般=book.dmm.com）。
 */
export async function fetchBookVolumes(productUrl: string): Promise<VolumeSet | null> {
  const m = productUrl.match(/https?:\/\/(book\.dmm\.(?:co\.jp|com))\/product\/([^/]+)\//);
  if (!m) return null;
  const [, host, seriesId] = m;
  const shopName = host === 'book.dmm.co.jp' ? 'adult' : 'general';
  try {
    return await fetchVolumesOn(host, shopName, seriesId, productUrl);
  } catch (err) {
    // 一般向けで dmm.com に未ログインなら、FANZA 側のホストでも聞いてみる（fetchBookPurchased と同じ）
    if (!(err instanceof DmmAuthError) || shopName !== 'general') throw err;
    try {
      return await fetchVolumesOn('book.dmm.co.jp', shopName, seriesId, productUrl);
    } catch {
      throw err;
    }
  }
}

async function fetchVolumesOn(host: string, shopName: string, seriesId: string, productUrl: string): Promise<VolumeSet | null> {

  const owned: ProductVolume[] = [];
  let total: number | null = null;
  let loaded = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url =
      `https://${host}/ajax/bff/contents_book/` +
      `?shop_name=${shopName}&series_id=${encodeURIComponent(seriesId)}` +
      `&page=${page}&per_page=${PER_PAGE}&last_read_position=0&order=asc` +
      `&purchase_status=all&format_webp=1`;
    const res = await fetchJson<ContentsResponse>(url, { referer: productUrl });
    const parsed = parseVolumePage(res);
    if (page === 1) total = parsed.total;
    if (parsed.count === 0) break;

    owned.push(...parsed.owned);
    loaded += parsed.count;
    if (total !== null ? loaded >= total : parsed.count < PER_PAGE) break;
    await politeDelay();
  }

  // 巻番号で並べておく（APIは order=asc だが、ページをまたぐと崩れることがある）
  owned.sort((a, b) => (a.volumeNumber ?? 0) - (b.volumeNumber ?? 0));
  return { totalCount: total, owned };
}
