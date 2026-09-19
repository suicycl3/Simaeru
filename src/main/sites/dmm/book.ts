import { authenticated, unauthenticated, authUnknown, type AuthResult } from '@shared/auth';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { ProductInput } from '../../db/repo';
import type { FloorAdapter, FloorSyncContext } from '../types';
import { DmmAuthError, fetchJson, politeDelay } from './client';
import { t } from '@shared/i18n';

const SHELF_PAGE = 'https://book.dmm.co.jp/shelf/';

/**
 * 電子書籍の「本棚」はシリーズ単位で返る（巻ではない）。
 * レスポンス実体を実測して確定させたスキーマ:
 *   { series_books: [...], pager: { page, per_page, total_count } }
 * 購入日は返らないため purchasedAt は null になる。
 */

interface BookAuthor {
  id: string;
  name: string;
  is_valid: boolean;
}

interface SeriesBook {
  shop_name: string | null;
  series_id: string;
  content_id: string | null;
  title: string;
  image_urls: { pt?: string | null; ps?: string | null; pl?: string | null } | null;
  author: BookAuthor[] | null;
  category: { id: string; name: string } | null;
  is_toon: boolean | null;
  is_rental: boolean | null;
  has_volumes: boolean | null;
  latest_purchased_volume_content_id: string | null;
  product_url: string | null;
}

interface ShelfResponse {
  series_books: SeriesBook[] | null;
  pager: { page: number; per_page: number; total_count: number } | null;
}

/**
 * 作品ページのホストは shop_name で決まる（アダルト=book.dmm.co.jp / 一般=book.dmm.com）。
 * 本棚APIが返す product_url は本棚を開いた側のホストになることがあり、
 * 一般作品なのに co.jp のURLが返ってくる（実測）。ここで必ず組み直す。
 */
export function bookProductUrl(
  shopName: string | null | undefined,
  seriesId: string,
  contentId: string | null
): string {
  const host = shopName === 'general' ? 'book.dmm.com' : 'book.dmm.co.jp';
  return `https://${host}/product/${seriesId}/${contentId ?? ''}/`;
}

function toInput(item: SeriesBook): ProductInput {
  const authors = (item.author ?? []).map((a) => a.name).filter(Boolean);
  const tags: string[] = [];
  if (item.shop_name) tags.push(item.shop_name === 'adult' ? 'アダルト' : '一般');
  if (item.is_rental) tags.push('レンタル');
  if (item.is_toon) tags.push('タテヨミ');

  return {
    siteId: 'dmm',
    floorId: 'book',
    category: 'book',
    // シリーズが同一性の単位。content_id は「最後に買った巻」なので購入のたびに変わる。
    productId: item.series_id,
    contentId: item.content_id ?? item.latest_purchased_volume_content_id ?? null,
    title: item.title,
    maker: authors[0] ?? null,
    authors,
    creators: (item.author ?? [])
      .filter((a) => a?.name)
      .map((a) => ({ role: '著者', name: a.name, id: a.id ?? null })),
    genre: item.category?.name ?? null,
    productType: item.has_volumes ? 'series' : 'single',
    // 本棚APIは購入日を返さない（order=added_desc の並びとしてしか出てこない）
    purchasedAt: null,
    coverUrl: item.image_urls?.pl ?? item.image_urls?.ps ?? item.image_urls?.pt ?? null,
    detailUrl: bookProductUrl(
      item.shop_name,
      item.series_id,
      item.content_id ?? item.latest_purchased_volume_content_id
    ),
    isDownloadable: false,
    isStreaming: true,
    hasDrm: true,
    tags,
    raw: item
  };
}

function dumpRaw(name: string, body: unknown): void {
  try {
    const dir = path.join(app.getPath('userData'), 'debug');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(body, null, 2), 'utf8');
  } catch {
    /* デバッグ用途なので失敗しても同期は続ける */
  }
}

export interface BookPurchased {
  contentId: string | null;
  /** "2026-01-30" 等。本棚APIは購入日を返さないので、ここでしか取れない */
  purchasedDate: string | null;
  streamingUrl: string | null;
  downloadUrl: string | null;
  /** 付録（イラスト集など）の配布URL */
  appendix: { streaming: unknown[]; download: unknown[] } | null;
}

/**
 * 巻ごとの購入状態。**購入日はここにしか無い**（本棚APIは返さない）。
 * URLは本棚APIが返す product_url（https://book.dmm.{co.jp|com}/product/{seriesId}/{contentId}/）
 * から shop_name とIDを割り出す。
 */
export async function fetchBookPurchased(productUrl: string): Promise<BookPurchased | null> {
  const m = productUrl.match(/https?:\/\/(book\.dmm\.(?:co\.jp|com))\/product\/([^/]+)\/([^/?]+)/);
  if (!m) return null;
  const [, host, seriesId, contentId] = m;
  const shopName = host === 'book.dmm.co.jp' ? 'adult' : 'general';
  try {
    return await fetchPurchasedOn(host, shopName, seriesId, contentId, productUrl);
  } catch (err) {
    // 一般向けは dmm.com のログインが要る。FANZA 側の本棚には一般の作品も並ぶので、
    // dmm.com に未ログインのときは FANZA 側のホストでも聞いてみる（通らなければ元のエラーを返す）
    if (!(err instanceof DmmAuthError) || shopName !== 'general') throw err;
    try {
      return await fetchPurchasedOn('book.dmm.co.jp', shopName, seriesId, contentId, productUrl);
    } catch {
      throw err;
    }
  }
}

/** 一般向けの DMM ブックス（dmm.com）にログインしているか。本棚APIが 200 を返すかで見る */
export async function probeBookComLogin(): Promise<AuthResult> {
  try {
    const result = await fetchJson<ShelfResponse>(
      'https://book.dmm.com/ajax/bff/library/?shop_name=general&page=1&order=added_desc&show_expired=0',
      { referer: BOOK_COM_LIBRARY }
    );
    return Array.isArray(result?.series_books) || typeof result?.pager?.total_count === 'number' ? authenticated() : authUnknown('Unexpected library response');
  } catch (err) {
    return err instanceof DmmAuthError ? unauthenticated() : authUnknown(err);
  }
}

export const BOOK_COM_LIBRARY = 'https://book.dmm.com/library/';
/** dmm.com のログイン画面。ログインしたら本棚へ戻る */
export const BOOK_COM_LOGIN_URL = `https://accounts.dmm.com/service/login/password/=/path=${encodeURIComponent(BOOK_COM_LIBRARY)}`;

async function fetchPurchasedOn(
  host: string,
  shopName: string,
  seriesId: string,
  contentId: string,
  productUrl: string
): Promise<BookPurchased | null> {
  const res = await fetchJson<{
    volumes?: {
      content_id?: string;
      purchased_date?: string;
      streaming_url?: string;
      download_url?: string;
      appendix?: { streaming?: unknown[]; download?: unknown[] };
    } | null;
  }>(
    `https://${host}/ajax/bff/product_volume_purchased/` +
      `?shop_name=${shopName}&series_id=${encodeURIComponent(seriesId)}&content_id=${encodeURIComponent(contentId)}`,
    { referer: productUrl }
  );
  const v = res.volumes;
  if (!v) return null;
  return {
    contentId: v.content_id ?? null,
    purchasedDate: v.purchased_date || null,
    streamingUrl: v.streaming_url || null,
    downloadUrl: v.download_url || null,
    appendix: v.appendix
      ? { streaming: v.appendix.streaming ?? [], download: v.appendix.download ?? [] }
      : null
  };
}

export const bookFloor: FloorAdapter = {
  floorId: 'book',
  label: '電子書籍',

  async fetchAll(ctx: FloorSyncContext): Promise<ProductInput[]> {
    // ショップ別の内訳。shop_name=all の取得漏れを検算するために残しておく。
    try {
      const facets = await fetchJson<unknown>(
        'https://book.dmm.co.jp/ajax/bff/library/facets/?shop_name=all&show_expired=0',
        { referer: SHELF_PAGE }
      );
      dumpRaw('book-library-facets', facets);
    } catch {
      /* 検算用なので失敗しても本体の取得は続ける */
    }

    const out: ProductInput[] = [];
    const seen = new Set<string>();
    let total: number | null = null;

    for (let page = 1; page <= 500; page++) {
      if (ctx.isCancelled()) break;
      const url =
        'https://book.dmm.co.jp/ajax/bff/library/' +
        `?shop_name=all&page=${page}&order=added_desc&show_expired=0&format_webp=1`;
      const res = await fetchJson<ShelfResponse>(url, { referer: SHELF_PAGE });
      if (page === 1) dumpRaw('book-library-page1', res);

      const items = res.series_books ?? [];
      if (typeof res.pager?.total_count === 'number') total = res.pager.total_count;
      if (items.length === 0) break;

      const pageIds: string[] = [];
      for (const item of items) {
        if (seen.has(item.series_id)) continue;
        seen.add(item.series_id);
        out.push(toInput(item));
        pageIds.push(item.series_id);
      }
      ctx.onProgress(out.length, total);
      if (total !== null && out.length >= total) break;
      // order=added_desc（追加の新しい順）なので、ページが丸ごと既知なら以降も既知。
      // ただしシリーズは巻を買い足すと中身が変わるため、行そのものは毎回更新される。
      if (ctx.canStopAfterPage(pageIds)) {
        ctx.onProgress(out.length, total, t('電子書籍: 既知のぶんに到達したので打ち切りました'));
        break;
      }
      await politeDelay();
    }
    return out;
  }
};
