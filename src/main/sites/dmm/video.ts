import { authenticated, unauthenticated, authUnknown, type AuthResult } from '@shared/auth';
import type { Creator } from '@shared/types';
import type { ProductInput } from '../../db/repo';
import type { FloorAdapter, FloorSyncContext } from '../types';
import { DmmAuthError, fetchGraphql, fetchJson, politeDelay } from './client';
import { CONTENT_PAGE_DATA_QUERY } from './videoQueries';
import { t } from '@shared/i18n';

const ENDPOINT = 'https://api.video.dmm.co.jp/graphql';

/**
 * ログインウィンドウの開始URLはマイライブラリそのもの。
 * 未認証ならサイト側がFANZAのログイン画面へ誘導してくれる。
 * accounts のログインURLを直接開くと、DMM本体にログイン済みの場合は
 * 素通りして video へ即リダイレクトするだけで、動画側の認証は済まない。
 */
export const VIDEO_LOGIN_URL = 'https://video.dmm.co.jp/mylibrary/';

/**
 * 動画(FANZA)のマイライブラリ。
 * このクエリ本文は video.dmm.co.jp の JS チャンクから抽出した実物で、
 * フラグメントも当時のまま。勝手にフィールドを足すとスキーマ不一致で落ちるため、
 * 変更するときは必ず実レスポンスで確認すること（tools/probe-video*.js 参照）。
 */
const MYLIBRARY_QUERY = `query Mylibrary($offset: Int!, $limit: Int!, $filter: PPVContentViewingRightsItemSummaryListFilterInput!, $sort: PPVContentViewingRightsItemSummaryListSort!) {
  user {
    ... on Member {
      ppvLibrary {
        mylibraryList: contentViewingRightsSummaryList(
          filter: $filter
          offset: $offset
          limit: $limit
          sort: $sort
        ) {
          items {
            ...purchasedContentSummaryFields
          }
          pageInfo {
            hasNext
            totalCount
          }
        }
      }
    }
  }
}

fragment purchasedContentSummaryFields on PPVContentViewingRightsItemSummary {
  id
  content {
    __CONTENT_ID__title
    packageImage {
      largeUrl
      mediumUrl
    }
    floor
    contentType
    isDiscontinued
  }
  contentItem {
    isLiked
    isHidden
    latestViewingRightsAcquiredAt
  }
  highestQualityGroup
  highestStreamingQualityProductItem {
    status
    expiresAt
    deliveryStartAt
  }
  highestDownloadQualityProductItem {
    status
    expiresAt
    deliveryStartAt
  }
}`;

/**
 * 一覧では作品IDが返らない（返るのは視聴権アイテムのID）。作品詳細を引くには
 * content.id が要るので、まず id 付きで投げ、スキーマに無ければ検証済みの形へ落とす。
 * こうしておけば仕様が変わっても一覧取得そのものは死なない。
 */
const QUERY_WITH_CONTENT_ID = MYLIBRARY_QUERY.replace('__CONTENT_ID__', 'id\n    ');
const QUERY_VERIFIED = MYLIBRARY_QUERY.replace('__CONTENT_ID__', '');
let queryInUse: string | null = null;

interface ProductItem {
  status: string | null;
  expiresAt: string | null;
  deliveryStartAt: string | null;
}

interface VideoItem {
  id: string;
  content: {
    id?: string | null;
    title: string;
    packageImage: { largeUrl: string | null; mediumUrl: string | null } | null;
    floor: string | null;
    contentType: string | null;
    isDiscontinued: boolean | null;
  } | null;
  contentItem: {
    isLiked: boolean | null;
    isHidden: boolean | null;
    latestViewingRightsAcquiredAt: string | null;
  } | null;
  highestQualityGroup: string | null;
  highestStreamingQualityProductItem: ProductItem | null;
  highestDownloadQualityProductItem: ProductItem | null;
}

interface MylibraryData {
  user?: {
    ppvLibrary?: {
      mylibraryList?: {
        items: VideoItem[] | null;
        pageInfo: { hasNext: boolean; totalCount: number } | null;
      } | null;
    } | null;
  } | null;
}

/**
 * 動画の作品ページ。GraphQL の floor は大文字（`AV`・`AMATEUR`）で返るが、ページのパスは小文字（`/av/`）。
 * 大文字のままだと開いても作品ページにならない。
 */
export function videoContentUrl(floor: string | null | undefined, contentId: string): string {
  return `https://video.dmm.co.jp/${(floor || 'av').toLowerCase()}/content/?id=${encodeURIComponent(contentId)}`;
}

/** "2026-08-29T12:34:56+09:00" → "2026-08-29 12:34" */
function toLocalStamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : (iso.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null);
}

function toInput(item: VideoItem): ProductInput {
  const c = item.content;
  const tags: string[] = [];
  if (item.highestQualityGroup) tags.push(item.highestQualityGroup);
  if (item.contentItem?.isLiked) tags.push('お気に入り');
  if (item.contentItem?.isHidden) tags.push('非表示');
  if (c?.contentType) tags.push(c.contentType);

  return {
    siteId: 'dmm',
    floorId: 'video',
    category: 'video',
    productId: item.id,
    // 作品ID（sone00076 など）。詳細取得やURL組み立てにはこちらを使う。
    contentId: item.content?.id ?? item.id,
    title: c?.title ?? '(タイトル不明)',
    maker: null,
    authors: [],
    genre: c?.floor ?? null,
    productType: c?.contentType ?? null,
    purchasedAt: toLocalStamp(item.contentItem?.latestViewingRightsAcquiredAt),
    purchasedAtSource: 'order',
    // 配信開始日を発売日として扱う。ストリーミング側が無ければダウンロード側を見る。
    releasedAt: toLocalStamp(
      item.highestStreamingQualityProductItem?.deliveryStartAt ??
        item.highestDownloadQualityProductItem?.deliveryStartAt
    ),
    coverUrl: c?.packageImage?.largeUrl ?? c?.packageImage?.mediumUrl ?? null,
    // content.id が取れていれば作品ページURLを組み立てられる（取れないときは null）
    detailUrl: c?.id ? videoContentUrl(c.floor, c.id) : null,
    isDownloadable: !!item.highestDownloadQualityProductItem,
    isStreaming: !!item.highestStreamingQualityProductItem,
    isUnavailable: !!c?.isDiscontinued,
    hasDrm: true,
    tags,
    raw: item
  };
}

async function fetchPage(
  offset: number,
  limit: number,
  displayStatus: 'VISIBLE' | 'HIDDEN'
): Promise<{ items: VideoItem[]; hasNext: boolean; total: number | null }> {
  const variables = {
    offset,
    limit,
    filter: { displayStatus },
    sort: 'VIEWING_RIGHTS_ACQUIRED_AT_DESC'
  };
  let data: MylibraryData;
  try {
    data = await fetchGraphql<MylibraryData>(ENDPOINT, {
      operationName: 'Mylibrary',
      query: queryInUse ?? QUERY_WITH_CONTENT_ID,
      variables
    });
    queryInUse = queryInUse ?? QUERY_WITH_CONTENT_ID;
  } catch (err) {
    if (queryInUse) throw err;
    // content.id が無いスキーマだった場合はここに来る
    queryInUse = QUERY_VERIFIED;
    data = await fetchGraphql<MylibraryData>(ENDPOINT, {
      operationName: 'Mylibrary',
      query: QUERY_VERIFIED,
      variables
    });
  }

  const list = data.user?.ppvLibrary?.mylibraryList;
  if (!list) {
    // user が Member に解決されない＝動画サービス側が未ログイン。
    // DMM本体にログイン済みでも動画は別途ログインを求められる（実測）。
    throw new DmmAuthError(
      t('FANZA動画が未ログインです。サイドバーの「動画にログイン」からログインしてください。')
    );
  }
  return {
    items: list.items ?? [],
    hasNext: list.pageInfo?.hasNext ?? false,
    total: list.pageInfo?.totalCount ?? null
  };
}

/**
 * 動画サービス側にログインできているか。
 * URLでは判定できない（本体ログイン済みだと video のURLへ素通りするため）。
 * 実際に1件だけ問い合わせて Member として解決されるかで見る。
 */
export async function probeVideoLogin(): Promise<AuthResult> {
  try {
    const data = await fetchGraphql<MylibraryData>(ENDPOINT, {
      operationName: 'Mylibrary',
      query: QUERY_VERIFIED,
      variables: {
        offset: 0,
        limit: 1,
        filter: { displayStatus: 'VISIBLE' },
        sort: 'VIEWING_RIGHTS_ACQUIRED_AT_DESC'
      }
    });
    if (data.user?.ppvLibrary) return authenticated();
    return data.user === null ? unauthenticated() : authUnknown('Unexpected library response');
  } catch (err) {
    return err instanceof DmmAuthError ? unauthenticated() : authUnknown(err);
  }
}

interface NamedRef {
  id?: string | null;
  name: string;
}

interface ContentPageContent {
  id: string;
  title: string;
  description: string | null;
  floor: string | null;
  deliveryStartDate?: string | null;
  makerReleasedAt?: string | null;
  duration?: number | null;
  actresses?: NamedRef[] | null;
  histrions?: NamedRef[] | null;
  directors?: NamedRef[] | null;
  series?: NamedRef | null;
  maker?: NamedRef | null;
  label?: NamedRef | null;
  genres?: NamedRef[] | null;
  relatedTags?: Array<{ id?: string | null; name?: string; tags?: NamedRef[] }> | null;
}

export interface VideoContentDetail {
  content: ContentPageContent | null;
  description: string | null;
  releasedAt: string | null;
  durationMinutes: number | null;
  tags: string[];
  creators: Creator[];
}

/** floor 名から ContentPageData のフロア別フラグメントの出し分けを決める */
function floorFlags(floor: string | null | undefined): Record<string, boolean> {
  const f = (floor ?? '').toLowerCase();
  return {
    isAv: f === 'av' || f === '',
    isAmateur: f === 'amateur',
    isAnime: f === 'anime',
    isCinema: f === 'cinema'
  };
}

/**
 * 作品詳細（説明文・ジャンル・タグ・出演者など）。
 * 一覧APIはタイトルと画像しか返さないので、開いたときにだけ引く。
 */
export async function fetchVideoContentDetail(
  contentId: string,
  floor: string | null
): Promise<VideoContentDetail> {
  const data = await fetchGraphql<{ ppvContent: ContentPageContent | null }>(ENDPOINT, {
    operationName: 'ContentPageData',
    query: CONTENT_PAGE_DATA_QUERY,
    variables: {
      id: contentId,
      // ログイン限定フィールドを要求すると、動画側が未ログインのときに
      // HasRole: unauthenticated で弾かれる。ここで欲しいのは公開メタだけなので false。
      isLoggedIn: false,
      shouldFetchRelatedTags: true,
      shouldGetBookmark: false,
      guestToken: '',
      ...floorFlags(floor)
    }
  });

  const c = data.ppvContent;
  const creators: Creator[] = [];
  for (const a of c?.actresses ?? []) creators.push({ role: '出演', name: a.name, id: a.id ?? null });
  for (const a of c?.histrions ?? []) creators.push({ role: '出演', name: a.name, id: a.id ?? null });
  for (const d of c?.directors ?? []) creators.push({ role: '監督', name: d.name, id: d.id ?? null });
  if (c?.maker) creators.push({ role: 'メーカー', name: c.maker.name, id: c.maker.id ?? null });
  if (c?.label) creators.push({ role: 'レーベル', name: c.label.name, id: c.label.id ?? null });
  if (c?.series) creators.push({ role: 'シリーズ', name: c.series.name, id: c.series.id ?? null });

  const tags = [
    ...(c?.genres ?? []).map((g) => g.name),
    ...(c?.relatedTags ?? []).flatMap((tItem) => (tItem.tags ? tItem.tags.map((x) => x.name) : [tItem.name ?? '']))
  ].filter((tItem): tItem is string => !!tItem);

  return {
    content: c,
    description: c?.description ?? null,
    releasedAt: toLocalStamp(c?.makerReleasedAt ?? c?.deliveryStartDate),
    durationMinutes: c?.duration ?? null,
    tags: [...new Set(tags)],
    creators
  };
}

interface PlayLink {
  link: string;
  part: number;
}

interface PlayInfoResponse {
  [productId: string]:
    | {
        detail?: { product_id?: string; content_id?: string; play_time?: number };
        play_info?: {
          pc?: {
            stream?: { links?: PlayLink[]; linksOf4kH264?: string };
            /** 画質(kbps)ごとのダウンロードリンク */
            download?: { links?: Record<string, PlayLink[]> };
          };
        };
      }
    | unknown;
}

export interface VideoPlayInfo {
  productId: string | null;
  playTimeMinutes: number | null;
  /** パートごとのプレイヤー。codec 'h264' は 4K 作品の H.264 版（パートではない） */
  streams: Array<{ url: string; part: number; codec: 'h264' | null }>;
  /** 画質・パートごとのダウンロード。画質の高い順 */
  downloads: Array<{ quality: string; name: string | null; sizeMb: number | null; order: number; part: number; url: string }>;
}

interface DeliveryQuality {
  quality?: string | number;
  quality_display_name?: string;
  /** MB */
  file_size?: number;
  quality_order?: number;
}

/**
 * 動画のプレイヤー URL の `part=` を 1 つにする。
 * API は 2 パート目以降を `…/part=1/part=2/` のように前のパートを残した形で返すが、公式のページが開くのは最後のパートだけの形。
 */
export function videoPartUrl(url: string): string {
  return url.replace(/(?:part=\d+\/)+(?=$|[?#])/, (seg) => {
    const all = seg.match(/part=\d+\//g) ?? [];
    return all[all.length - 1] ?? seg;
  });
}

/**
 * floor 名から旧www側の shop 名を決める。GraphQL の floor と綴りが違う（AV → videoa、AMATEUR → videoc）。
 * 当たらなかったときのために、よく使う shop を後ろに並べる。
 */
export function shopNameFor(floor: string | null): string[] {
  const f = (floor ?? 'av').toLowerCase();
  const known: Record<string, string> = { av: 'videoa', '': 'videoa', amateur: 'videoc', anime: 'anime' };
  const primary = known[f] ?? f;
  return [...new Set([primary, 'videoa', 'videoc'])];
}

/**
 * 再生・ダウンロードの導線。GraphQL側には無く、旧www側のこのAPIにしかない。
 * product_id をキーにしたJSONで、`play_info.pc` に
 * ストリーミングのプレイヤーURLと画質別のダウンロードURLが入っている。
 */
export async function fetchVideoPlayInfo(
  contentId: string,
  floor: string | null
): Promise<VideoPlayInfo | null> {
  // 作品の floor に合う shop だけを聞く。違う shop は 503 などを返すので、合う shop が「導線無し」を返したときだけほかも試す。
  // 失敗したときに出すのは、合う shop の理由（違う shop の 503 で上書きしない）
  let primaryError: unknown = null;
  let noEntry: string | null = null;
  const shops = shopNameFor(floor);
  for (const [index, shop] of shops.entries()) {
    try {
      const url = `https://www.dmm.co.jp/digital/-/mylibrary/ajax-play-url/=/cid=${encodeURIComponent(contentId)}/shop=${shop}/device=pc/`;
      const get = (): Promise<PlayInfoResponse> => fetchJson<PlayInfoResponse>(url, { referer: 'https://www.dmm.co.jp/digital/-/mylibrary/' });
      let res: PlayInfoResponse;
      try {
        res = await get();
      } catch (err) {
        // 一時的な 5xx は、少し待って 1 回だけやり直す
        if (!/HTTP 5\d\d/.test(err instanceof Error ? err.message : String(err))) throw err;
        await new Promise((r) => setTimeout(r, 2000));
        res = await get();
      }
      const entry = Object.values(res).find(
        (v): v is { detail?: { product_id?: string; play_time?: number }; play_info?: unknown } =>
          !!v && typeof v === 'object' && 'play_info' in (v as object)
      );
      if (!entry) {
        // 導線の無い応答。どの形だったかを理由に残す（中身の値は出さず、キーと短い文言だけ）
        if (index === 0) {
          const text = JSON.stringify(res);
          noEntry = `${shop}: ${text.length > 160 ? `${text.slice(0, 160)}…` : text}`;
        }
        continue;
      }

      const pc = (entry as { play_info?: { pc?: NonNullable<PlayInfoResponse[string]> } }).play_info
        ?.pc as
        | {
            stream?: { links?: PlayLink[]; linksOf4kH264?: string };
            download?: { links?: Record<string, PlayLink[]> };
          }
        | undefined;
      const abs = (u: string): string =>
        u.startsWith('http') ? u : `https://www.dmm.co.jp${u}`;

      const streams: VideoPlayInfo['streams'] = (pc?.stream?.links ?? []).map((l, i) => ({ url: abs(l.link), part: l.part ?? i + 1, codec: null }));
      if (pc?.stream?.linksOf4kH264) streams.push({ url: abs(pc.stream.linksOf4kH264), part: 1, codec: 'h264' });

      // 画質の呼び名・容量・並びは detail.delivery_content_info.pc.download にある（画質の印で突き合わせる）
      const info = new Map<string, DeliveryQuality>();
      const delivery = (entry.detail as { delivery_content_info?: { pc?: { download?: DeliveryQuality[] } } } | undefined)
        ?.delivery_content_info?.pc?.download;
      for (const q of delivery ?? []) if (q.quality !== undefined) info.set(String(q.quality), q);
      const downloads: VideoPlayInfo['downloads'] = Object.entries(pc?.download?.links ?? {})
        .flatMap(([quality, links]) =>
          (links ?? []).map((l, i) => {
            const q = info.get(quality);
            return {
              quality,
              name: q?.quality_display_name ?? null,
              sizeMb: typeof q?.file_size === 'number' ? q.file_size : null,
              order: typeof q?.quality_order === 'number' ? q.quality_order : quality === '4k' ? 1_000_000 : Number(quality) || 0,
              part: l.part ?? i + 1,
              url: abs(l.link)
            };
          })
        )
        .sort((a, b) => b.order - a.order || a.part - b.part);

      return {
        productId: entry.detail?.product_id ?? null,
        playTimeMinutes: entry.detail?.play_time ?? null,
        streams,
        downloads
      };
    } catch (err) {
      if (index === 0) {
        primaryError = err;
        break;
      }
    }
  }
  if (primaryError) {
    const message = primaryError instanceof Error ? primaryError.message : String(primaryError);
    // URL は長く、画面では理由が切れて見えなくなるので落とす
    const e = new Error(`${shops[0]}: ${message.replace(/^GET \S+ failed: /, '')}`);
    e.name = primaryError instanceof Error ? primaryError.name : 'Error';
    throw e;
  }
  if (noEntry) throw new Error(t('再生・ダウンロードの導線が返りませんでした（{detail}）', { detail: noEntry }));
  return null;
}

export const videoFloor: FloorAdapter = {
  floorId: 'video',
  label: '動画',

  async fetchAll(ctx: FloorSyncContext): Promise<ProductInput[]> {
    const out: ProductInput[] = [];
    const seen = new Set<string>();
    const limit = 100;

    // 通常表示ぶんを取り切ってから、非表示にした作品も拾う
    for (const displayStatus of ['VISIBLE', 'HIDDEN'] as const) {
      let total: number | null = null;
      for (let offset = 0; offset < 100000; offset += limit) {
        if (ctx.isCancelled()) break;
        let page;
        try {
          page = await fetchPage(offset, limit, displayStatus);
        } catch (err) {
          // 非表示ぶんが取れないだけなら通常ぶんは活かす
          if (displayStatus === 'HIDDEN' && out.length > 0) break;
          throw err;
        }
        if (total === null) total = page.total;
        const pageIds: string[] = [];
        for (const item of page.items) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          const input = toInput(item);
          out.push(input);
          pageIds.push(input.productId);
        }
        ctx.onProgress(out.length, displayStatus === 'VISIBLE' ? total : null);
        if (!page.hasNext || page.items.length === 0) break;
        // 購入日の新しい順。ページが丸ごと既知ならこの表示区分はここまで。
        if (ctx.canStopAfterPage(pageIds)) {
          ctx.onProgress(out.length, total, t('動画: 既知のぶんに到達したので打ち切りました'));
          break;
        }
        await politeDelay();
      }
    }
    return out;
  }
};
