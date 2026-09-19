import type { ProductInput } from '../../db/repo';
import type { FloorAdapter, FloorSyncContext } from '../types';
import { fetchJson, politeDelay } from './client';
import { t } from '@shared/i18n';

const MYLIBRARY_PAGE = 'https://www.dmm.co.jp/dc/-/mylibrary/';
const API_BASE = 'https://www.dmm.co.jp/dc/doujin/api';

interface DoujinItem {
  contentId: string;
  productId: string;
  title: string;
  imageSrc: string | null;
  genre: string | null;
  makerName: string | null;
  isStreaming?: boolean;
  isUnavailable?: boolean;
  isCloudGame?: boolean;
  isDownloadGame?: boolean;
}

interface DoujinListResponse {
  error_code: number;
  data?: {
    /** キーは "2026年08月29日" のような購入日 */
    items?: Record<string, DoujinItem[]>;
    total?: number;
    hasNext?: boolean;
  } | null;
}

export interface DoujinDetail {
  contentId: string;
  title: string;
  makerName: string | null;
  makerId: number | null;
  deliveryDate: string | null;
  fileSize: string | null;
  detailLink: string | null;
  downloadLinks: Record<string, string>;
  drm: { dmmBooks: boolean; softDenchi: boolean } | null;
  isViewable: boolean;
  /** クラウドで遊べる作品のときだけ isOpen が true になり url が入る */
  cloudGame?: { isOpen: boolean; url: string | null; versionDate: string | null } | null;
}

/** "2026年08月29日" → "2026-08-29" */
function parseJpDate(text: string): string | null {
  const m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** "2.93GB" / "598.13KB" → バイト数。解釈できなければ null */
export function parseSizeText(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
  if (!m) return null;
  const units: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
  const mult = units[m[2].toLowerCase()];
  const n = Number(m[1]);
  return Number.isFinite(n) && mult ? Math.round(n * mult) : null;
}

/**
 * 一覧APIの表紙は `d_100005pl-100x75.jpg` という**100×75の縮小版**で、
 * カードに引き伸ばすとぼやける。サイズ指定を外すと原寸（実測 560×420）が取れる。
 * `-540x405` のような別サイズは用意されていない（実測で別画像が返る）ので、
 * 指定を丸ごと落とすだけにする。
 */
export function largeCover(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/-\d+x\d+(\.[a-z]+)$/i, '$1');
}

function toInput(item: DoujinItem, purchasedAt: string | null): ProductInput {
  const tags: string[] = [];
  if (item.isDownloadGame) tags.push('DLゲーム');
  if (item.isCloudGame) tags.push('クラウドゲーム');
  return {
    siteId: 'dmm',
    floorId: 'doujin',
    category: 'doujin',
    productId: item.productId || item.contentId,
    contentId: item.contentId ?? null,
    title: item.title,
    maker: item.makerName ?? null,
    makerId: null,
    authors: [],
    creators: item.makerName ? [{ role: 'サークル', name: item.makerName, id: null }] : [],
    genre: item.genre ?? null,
    productType: item.isDownloadGame ? 'game' : null,
    purchasedAt,
    purchasedAtSource: purchasedAt ? 'order' : null,
    coverUrl: largeCover(item.imageSrc),
    detailUrl: `https://www.dmm.co.jp/dc/-/mylibrary/detail/=/product_id=${item.contentId}/`,
    isDownloadable: !item.isUnavailable,
    isStreaming: !!item.isStreaming,
    isUnavailable: !!item.isUnavailable,
    tags,
    raw: item
  };
}

/**
 * 同人ライブラリ。lovecul.dmm.co.jp の TL/BL も同じバックエンドを見ており
 * （実測でレスポンスがバイト一致）、このフロア1つで購入済み全件を網羅する。
 */
export const doujinFloor: FloorAdapter = {
  floorId: 'doujin',
  label: '同人',

  async fetchAll(ctx: FloorSyncContext): Promise<ProductInput[]> {
    const out: ProductInput[] = [];
    let total: number | null = null;
    const limit = 100; // 画面上は20。100でも受け付けるが、無視されても hasNext で回り切る。

    for (let page = 1; page <= 1000; page++) {
      if (ctx.isCancelled()) break;
      const url =
        `${API_BASE}/mylibraries/?page=${page}&sort=purchasedate_desc&genre=all&limit=${limit}`;
      const res = await fetchJson<DoujinListResponse>(url, { referer: MYLIBRARY_PAGE });
      if (res.error_code) throw new Error(t('同人ライブラリAPIエラー: error_code={error_code}', { error_code: res.error_code }));
      const groups = res.data?.items ?? {};
      if (typeof res.data?.total === 'number') total = res.data.total;

      let countThisPage = 0;
      const pageIds: string[] = [];
      for (const [dateLabel, items] of Object.entries(groups)) {
        const purchasedAt = parseJpDate(dateLabel);
        for (const item of items ?? []) {
          const input = toInput(item, purchasedAt);
          out.push(input);
          pageIds.push(input.productId);
          countThisPage++;
        }
      }
      ctx.onProgress(out.length, total);
      if (countThisPage === 0 || res.data?.hasNext !== true) break;
      // 購入日の新しい順なので、ページが丸ごと既知になったらそれ以降も既知
      if (ctx.canStopAfterPage(pageIds)) {
        ctx.onProgress(out.length, total, t('{0}: 既知のぶんに到達したので打ち切りました', { 0: t('同人') }));
        break;
      }
      await politeDelay();
    }
    return out;
  }
};

/**
 * 詳細（ファイルサイズ・DRM・ダウンロードリンク）は1件1リクエストになるため、
 * 同期時には取らず、UIで開いたときにだけ取りに行く。
 */
export async function fetchDoujinDetail(contentId: string): Promise<DoujinDetail> {
  const res = await fetchJson<{ error_code: number; data: DoujinDetail }>(
    `${API_BASE}/mylibraries/details/${contentId}/`,
    { referer: `https://www.dmm.co.jp/dc/-/mylibrary/detail/=/product_id=${contentId}/` }
  );
  if (res.error_code) throw new Error(t('詳細APIエラー: error_code={error_code}', { error_code: res.error_code }));
  return res.data;
}

/** 収録ファイル一覧（型・サイズ・解像度） */
export async function fetchDoujinFiles(contentId: string): Promise<unknown> {
  const res = await fetchJson<{ error_code: number; data: unknown }>(
    `${API_BASE}/mylibraries/folder-structures/${contentId}/`,
    { referer: `https://www.dmm.co.jp/dc/-/mylibrary/detail/=/product_id=${contentId}/` }
  );
  return res.data;
}
