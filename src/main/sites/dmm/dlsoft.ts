import type { Creator } from '@shared/types';
import type { ProductInput } from '../../db/repo';
import type { FloorAdapter, FloorSyncContext } from '../types';
import { fetchJson, politeDelay } from './client';
import { t } from '@shared/i18n';

const LIBRARY_PAGE = 'https://dlsoft.dmm.co.jp/library/';

interface DlsoftItem {
  contentId: string;
  productId: string;
  deliveryBeginDate: string | null;
  libraryProductType: string | null;
  floor: string | null;
  title: string;
  packageImageUrl: string | null;
  brand?: { name?: string | null; listUrl?: string | null } | null;
  authorArray?: Array<{ name?: string | null; listUrl?: string | null }> | null;
  tagArray?: Array<{ code?: string | null; displayName?: string | null }> | null;
  catalog?: { isDisplayCatalog?: boolean; catalogPageUrl?: string | null } | null;
}

interface DlsoftResponse {
  error: unknown;
  body?: { totalCount?: number; library?: DlsoftItem[] } | null;
}

/** listUrl (…?maker=31147&sort=ranking) から maker id を取り出す */
function makerIdFrom(listUrl: string | null | undefined): string | null {
  if (!listUrl) return null;
  const m = listUrl.match(/[?&]maker=(\d+)/);
  return m ? m[1] : null;
}

/** listUrl (…?author=20464&…) から作者IDを取り出す */
function authorIdFrom(listUrl: string | null | undefined): string | null {
  const m = listUrl?.match(/[?&]author=(\d+)/);
  return m ? m[1] : null;
}

function creatorsOf(item: DlsoftItem): Creator[] {
  const out: Creator[] = [];
  if (item.brand?.name) {
    out.push({ role: 'ブランド', name: item.brand.name, id: makerIdFrom(item.brand.listUrl) });
  }
  for (const a of item.authorArray ?? []) {
    if (a?.name) out.push({ role: '作者', name: a.name, id: authorIdFrom(a.listUrl) });
  }
  return out;
}

/**
 * 一覧APIが返すパッケージ画像は `..._0017packps.jpg`（実測 125×200）。
 * 末尾を pl にすると大きい版（実測 411×560）が取れる。
 */
export function largePackage(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/ps(\.[a-z]+)$/i, 'pl$1');
}

function toInput(item: DlsoftItem, parentProductId: string | null = null): ProductInput {
  const tags = (item.tagArray ?? [])
    .map((tItem) => tItem?.displayName ?? tItem?.code ?? '')
    .filter((tItem): tItem is string => !!tItem);
  return {
    siteId: 'dmm',
    floorId: 'dlsoft',
    category: 'game',
    productId: item.productId || item.contentId,
    contentId: item.contentId ?? null,
    title: item.title,
    maker: item.brand?.name ?? null,
    makerId: makerIdFrom(item.brand?.listUrl),
    authors: (item.authorArray ?? []).map((a) => a?.name ?? '').filter((a): a is string => !!a),
    genre: item.floor ?? null,
    productType: item.libraryProductType ?? null,
    // 一覧APIに注文日は無い。これは作品の配信開始日なので購入日としては暫定扱いにし、
    // 詳細API(order.orderDate)を取ったときに本物へ差し替える。発売日側には確定値として入れる。
    purchasedAt: item.deliveryBeginDate ?? null,
    purchasedAtSource: 'delivery',
    releasedAt: item.deliveryBeginDate ?? null,
    creators: creatorsOf(item),
    parentProductId,
    coverUrl: largePackage(item.packageImageUrl),
    detailUrl:
      item.catalog?.catalogPageUrl ?? `https://dlsoft.dmm.co.jp/detail/${item.contentId}/`,
    isDownloadable: true,
    // 'browser' タグ = ブラウザで遊べる（＝インストール不要）
    isStreaming: (item.tagArray ?? []).some((tItem) => tItem?.code === 'browser'),
    tags,
    raw: item
  };
}

export interface DlsoftDownload {
  canDownload: boolean;
  deliveryDate: string | null;
  /** 'rar' | 'zip' など */
  fileType: string | null;
  /** メガバイト単位の文字列。例 "3399.63" */
  volume: string | null;
  osList: { win: string | null; osx: string | null; android: string | null; ios: string | null } | null;
  /** 単一ファイル配布のとき。相対パス */
  singleFileUrl: string | null;
  /** 分割配布の1つ目（自己解凍exe）。相対パス */
  combinedFileUrl: string | null;
  /** 分割配布の2つ目以降。相対パス */
  splitFileUrlArray: string[];
  requirementToolArray: Array<{ text: string; url: string }>;
}

export interface DlsoftBrowserPlay {
  canPlay: boolean;
  playPageUrl: string | null;
  description: string | null;
  osList: Record<string, string | null> | null;
}

export interface DlsoftDetail {
  productId: string;
  title: string;
  /** 実際に購入した日時。一覧APIの deliveryBeginDate とは別物 */
  orderDate: string | null;
  orderItemNo: string | null;
  download: DlsoftDownload | null;
  browser: DlsoftBrowserPlay | null;
  /** セット商品のとき、収録されている単品 */
  children: Array<{
    productId: string;
    title: string;
    download: DlsoftDownload | null;
    browser: DlsoftBrowserPlay | null;
  }>;
}

interface DetailSingleResponse {
  error: unknown;
  body?: {
    productDetail?: {
      product: DlsoftItem;
      download: DlsoftDownload | null;
      browser: DlsoftBrowserPlay | null;
    } | null;
    order?: { orderDate: string | null; orderItemNo: string | null } | null;
  } | null;
}

interface DetailSetResponse {
  error: unknown;
  body?: {
    product: DlsoftItem;
    childProducts?: Array<{
      product: DlsoftItem;
      download: DlsoftDownload | null;
      browser: DlsoftBrowserPlay | null;
    }> | null;
    order?: { orderDate: string | null; orderItemNo: string | null } | null;
  } | null;
}

/** ダウンロードURLは相対パスで返るので、絶対URLに直す */
export function toAbsoluteDownloadUrl(relative: string): string {
  return relative.startsWith('http') ? relative : `https://dlsoft.dmm.co.jp${relative}`;
}

/** "3399.63"（MB）→ バイト数 */
export function volumeToBytes(volume: string | null | undefined): number | null {
  if (!volume) return null;
  const mb = Number(volume);
  return Number.isFinite(mb) ? Math.round(mb * 1024 * 1024) : null;
}

/**
 * 単品/セットの詳細。ダウンロードURL・ファイル形式・容量・対応OS・必要ツール、
 * そして **実際の注文日** が取れる。一覧APIには注文日が無く、
 * `deliveryBeginDate` は作品の配信開始日なので購入日として使ってはいけない。
 */
export async function fetchDlsoftDetail(
  productId: string,
  productType: string | null,
  /**
   * セット収録品ならその親セットのID。
   * セット経由でしか持っていない単品は detail/single/ が HTTP 500 を返すため、
   * 親セットの詳細から自分の分を抜き出す必要がある（実測で確認）。
   */
  parentProductId?: string | null
): Promise<DlsoftDetail> {
  if (parentProductId) {
    const parent = await fetchDlsoftDetail(parentProductId, 'set');
    const mine = parent.children.find((c) => c.productId === productId);
    return {
      productId,
      title: mine?.title ?? '',
      // 購入したのは親セットなので注文日・注文番号は親のもの
      orderDate: parent.orderDate,
      orderItemNo: parent.orderItemNo,
      download: mine?.download ?? null,
      browser: mine?.browser ?? null,
      children: []
    };
  }
  const kind = productType === 'set' ? 'set' : 'single';
  const url = `https://dlsoft.dmm.co.jp/ajax/v1/library/detail/${kind}/?productId=${encodeURIComponent(productId)}`;
  const res = await fetchJson<DetailSingleResponse & DetailSetResponse>(url, {
    // 実ページは詳細ページ自身を Referer にしている（実キャプチャに合わせる）
    referer: `https://dlsoft.dmm.co.jp/library/detail/${kind}/${productId}/`,
    csrfPage: LIBRARY_PAGE, headers: { 'Content-Type': 'application/json' }
  });

  const order = res.body?.order ?? null;
  if (kind === 'set') {
    const body = res.body as DetailSetResponse['body'];
    return {
      productId,
      title: body?.product?.title ?? '',
      orderDate: order?.orderDate ?? null,
      orderItemNo: order?.orderItemNo ?? null,
      download: null,
      browser: null,
      children: (body?.childProducts ?? []).map((child) => ({
        productId: child.product.productId,
        title: child.product.title,
        download: child.download ?? null,
        browser: child.browser ?? null
      }))
    };
  }

  const detail = (res.body as DetailSingleResponse['body'])?.productDetail ?? null;
  return {
    productId,
    title: detail?.product?.title ?? '',
    orderDate: order?.orderDate ?? null,
    orderItemNo: order?.orderItemNo ?? null,
    download: detail?.download ?? null,
    browser: detail?.browser ?? null,
    children: []
  };
}

/**
 * セット商品に収録されている単品を、一覧に並べられる形で取り出す。
 * セット本体はプレイもインストールもできない「入れ物」なので、
 * 中身を独立した行として持たないとライブラリとして使えない。
 * 購入日はセットを買った日（＝親の注文日）を引き継ぐ。
 */
async function fetchSetChildren(set: ProductInput): Promise<ProductInput[]> {
  const productId = set.productId;
  const url = `https://dlsoft.dmm.co.jp/ajax/v1/library/detail/set/?productId=${encodeURIComponent(productId)}`;
  const res = await fetchJson<DetailSetResponse>(url, {
    referer: `https://dlsoft.dmm.co.jp/library/detail/set/${productId}/`,
    csrfPage: LIBRARY_PAGE, headers: { 'Content-Type': 'application/json' }
  });

  const orderDate = res.body?.order?.orderDate ?? null;
  return (res.body?.childProducts ?? []).map((child) => {
    const input = toInput(child.product, productId);
    const dl = child.download;
    return {
      ...input,
      purchasedAt: orderDate ?? set.purchasedAt ?? null,
      purchasedAtSource: orderDate ? ('order' as const) : set.purchasedAtSource,
      fileSizeText: dl?.volume ? `${dl.volume} MB` : null,
      fileSizeBytes: volumeToBytes(dl?.volume),
      isDownloadable: dl?.canDownload ?? false,
      isStreaming: !!child.browser?.canPlay
    };
  });
}

export const dlsoftFloor: FloorAdapter = {
  floorId: 'dlsoft',
  label: 'PCゲーム',

  async fetchAll(ctx: FloorSyncContext): Promise<ProductInput[]> {
    const out: ProductInput[] = [];
    let total: number | null = null;

    for (let page = 1; page <= 200; page++) {
      if (ctx.isCancelled()) break;
      const url =
        'https://dlsoft.dmm.co.jp/ajax/v1/library' +
        `?service=all&brand=&searchWord=&sort=order_desc&browserOnly=0&page=${page}`;
      const res = await fetchJson<DlsoftResponse>(url, {
        referer: LIBRARY_PAGE,
        csrfPage: LIBRARY_PAGE, headers: { 'Content-Type': 'application/json' }
      });
      const items = res.body?.library ?? [];
      if (typeof res.body?.totalCount === 'number') total = res.body.totalCount;
      if (items.length === 0) break;
      const pageIds: string[] = [];
      for (const item of items) {
        const input = toInput(item);
        out.push(input);
        pageIds.push(input.productId);
      }
      ctx.onProgress(out.length, total);
      if (total !== null && out.length >= total) break;
      // 購入(配信)日の新しい順なので、ページが丸ごと既知なら以降も既知
      if (ctx.canStopAfterPage(pageIds)) {
        ctx.onProgress(out.length, total, t('PCゲーム: 既知のぶんに到達したので打ち切りました'));
        break;
      }
      await politeDelay();
    }

    // セットは中身を1件ずつ展開する。セット数だけ追加リクエストが要るが、
    // 一覧に出ているセットの数はたかが知れているので同期時にまとめて取る。
    // セットの中身は変わらないので、差分モードでは展開済みのセットを飛ばす
    const sets = out.filter(
      (p) => p.productType === 'set' && !(ctx.incremental && ctx.isKnown(p.productId))
    );
    const children: ProductInput[] = [];
    for (const [i, set] of sets.entries()) {
      if (ctx.isCancelled()) break;
      ctx.onProgress(out.length + children.length, null, t('セットを展開中 {0}/{length}', { 0: i + 1, length: sets.length }));
      try {
        children.push(...(await fetchSetChildren(set)));
      } catch {
        // 1つのセットが取れなくても他は続ける（本体行は残るので取りこぼしにはならない）
      }
      await politeDelay();
    }

    // 単品として単独購入もしているものは既に out にある。後勝ちで潰さないよう既出は捨てる。
    const seen = new Set(out.map((p) => p.productId));
    for (const child of children) {
      if (seen.has(child.productId)) continue;
      seen.add(child.productId);
      out.push(child);
    }
    return out;
  }
};
