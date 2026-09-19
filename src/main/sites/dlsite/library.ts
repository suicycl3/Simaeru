import type { Category, Creator, ProductLink } from '@shared/types';
import type { ProductInput } from '../../db/repo';
import type { FloorAdapter, FloorSyncContext } from '../types';
import { get, politeDelay, post } from './client';
import { buildPurchaseIndex, type PurchaseInfo } from './purchases';
import { t } from '@shared/i18n';

/**
 * DLsite Play の購入済みライブラリ。
 *
 * 同期の手順は play.dlsite.com のJSチャンクから読み取った実物の流れに合わせてある:
 *   1. GET  /api/v4/content/count?last=0   → 件数と分割サイズ
 *   2. GET  /api/v4/content/sales?last=0   → 購入した workno と購入日
 *   3. POST /api/v4/content/works {worknos} → 作品情報（page_limit ずつ）
 *   4. POST /api/v3/genres {genre_ids}      → ジャンルID→名前（100件ずつ）
 *   5. 旧www の購入履歴HTML               → ダウンロード導線・価格・ライセンスキー（APIに無い）
 *
 * **購入日は works 側には入っていない**（実測で全件 null）。sales の
 * workno→sales_date を works にマージするのが本家クライアントのやり方。
 */

interface CountResponse {
  user?: number;
  production?: number;
  page_limit?: number;
  concurrency?: number;
}

interface SalesItem {
  workno: string;
  sales_date: string | null;
}

interface LocalizedName {
  ja_JP?: string;
  en?: string;
  [lang: string]: string | undefined;
}

interface DlsiteWork {
  workno: string;
  name?: LocalizedName | null;
  maker?: { id?: string; name?: LocalizedName } | null;
  authors?: Array<{ id?: string; name?: LocalizedName }> | null;
  series?: { title_id?: string; name?: string; volume_number?: number } | null;
  images?: { main?: string; thumb?: string } | null;
  genre_ids?: number[] | null;
  tags?: unknown[] | null;
  work_type?: string | null;
  site_id?: string | null;
  age?: string | null;
  file_type?: string | null;
  pc_file_size?: number | null;
  release_date?: string | null;
  downloadable?: boolean | null;
  playable?: boolean | null;
  has_pc_download_content?: boolean | null;
}

interface Genre {
  id: number;
  name?: LocalizedName;
}

/** 実データに現れた作品種別コード。未知のコードはそのまま出す */
const WORK_TYPE_LABELS: Record<string, string> = {
  MNG: 'マンガ',
  ICG: 'CG・イラスト',
  ADV: 'アドベンチャー',
  SOU: 'ボイス・ASMR',
  RPG: 'ロールプレイング',
  MOV: '動画',
  SLN: 'シミュレーション',
  ACN: 'アクション',
  ETC: 'その他'
};

/**
 * DLsiteのサブサイトを、DMM側の区分に合わせて写す。
 * 区分はサイトをまたいで同じ物差しにしたいので、DLsiteの分け方をそのまま持ち込まない。
 *   maniax/home(同人) → doujin / books・comic(商業書籍) → book / pro・soft(商業ソフト) → game
 * 同人サイドにゲームが含まれるのはDMMの同人フロアと同じ扱い。
 */
const SITE_CATEGORIES: Record<string, Category> = {
  maniax: 'doujin',
  home: 'doujin',
  books: 'book',
  comic: 'book',
  pro: 'game',
  soft: 'game'
};

/** DLsiteのサブサイト。作品ページURLの組み立てに使う */
const SITE_LABELS: Record<string, string> = {
  maniax: '同人',
  books: '商業書籍',
  comic: 'コミック',
  pro: '商業',
  soft: 'ソフト',
  home: '全年齢'
};

function jp(name: LocalizedName | null | undefined): string | null {
  if (!name) return null;
  return name.ja_JP ?? name.en ?? Object.values(name).find((v) => !!v) ?? null;
}

/** "2023-01-06T15:00:00Z" → JSTの "2023-01-07 00:00" */
function toJstStamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso.slice(0, 16).replace('T', ' ');
  const jst = new Date(ms + 9 * 60 * 60 * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())} ` +
    `${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}`
  );
}

/**
 * 購入まわりの情報から操作リンクを組み立てる。
 *
 * シリアル配布でも「サイトで確認してください」で終わらせない。ライセンスキーと
 * 実ファイルのURLは同期時にキー確認ページから取ってあるので、キーはアプリ側に表示し、
 * ボタンは実ファイルのダウンロードを直接指す。取れなかったときだけ確認ページを残す。
 */
function purchaseLinks(purchase: PurchaseInfo | null | undefined): ProductLink[] {
  if (!purchase) return [];
  const links: ProductLink[] = [];
  if (purchase.downloadUrl) {
    links.push({ label: 'ダウンロード', url: purchase.downloadUrl, kind: 'download' });
  }
  if (purchase.dlUrl && purchase.dlUrl !== purchase.downloadUrl) {
    switch (purchase.dlKind) {
      case 'serial':
        // キーも実URLも取れているならページを開く必要はない
        if (!purchase.downloadUrl || !purchase.serialKey) {
          links.push({ label: 'ライセンスキーのページ', url: purchase.dlUrl, kind: 'page' });
        }
        break;
      case 'split':
        links.push({ label: '分割ダウンロード', url: purchase.dlUrl, kind: 'page' });
        break;
      case 'pack':
        links.push({ label: 'まとめてダウンロード', url: purchase.dlUrl, kind: 'page' });
        break;
      default:
        break;
    }
  }
  return links;
}

/** 作品1件を共通モデルへ。実キャプチャで検証できるよう純粋関数にしてある */
export function mapDlsiteWork(
  work: DlsiteWork,
  salesDate: string | null,
  genreNames: Map<number, string>,
  purchase?: PurchaseInfo | null
): ProductInput {
  const makerName = jp(work.maker?.name);
  const creators: Creator[] = [];
  if (makerName) {
    creators.push({ role: 'サークル', name: makerName, id: work.maker?.id ?? null });
  }
  for (const a of work.authors ?? []) {
    const name = jp(a.name);
    if (name) creators.push({ role: '作者', name, id: a.id ?? null });
  }
  if (work.series?.name) {
    creators.push({ role: 'シリーズ', name: work.series.name, id: work.series.title_id ?? null });
  }

  const tags = [
    ...(work.genre_ids ?? []).map((id) => genreNames.get(id)).filter((tItem): tItem is string => !!tItem),
    ...(work.work_type ? [WORK_TYPE_LABELS[work.work_type] ?? work.work_type] : []),
    ...(work.site_id && SITE_LABELS[work.site_id] ? [SITE_LABELS[work.site_id]] : []),
    ...(work.age === 'r18' ? ['成人向け'] : [])
  ];

  const site = work.site_id ?? 'maniax';
  return {
    siteId: 'dlsite',
    floorId: 'library',
    category: SITE_CATEGORIES[work.site_id ?? ''] ?? 'doujin',
    productId: work.workno,
    contentId: work.workno,
    title: jp(work.name) ?? work.workno,
    maker: makerName,
    makerId: work.maker?.id ?? null,
    authors: (work.authors ?? []).map((a) => jp(a.name) ?? '').filter(Boolean),
    creators,
    genre: work.work_type ? (WORK_TYPE_LABELS[work.work_type] ?? work.work_type) : null,
    productType: work.work_type ?? null,
    // 購入日は sales 側から渡ってくる。works には入っていない。
    // sales に無い作品（法人購入分など）は購入履歴の注文日で埋める。
    purchasedAt: toJstStamp(salesDate) ?? purchase?.buyDate ?? null,
    purchasedAtSource: salesDate || purchase?.buyDate ? 'order' : null,
    releasedAt: toJstStamp(work.release_date),
    coverUrl: work.images?.main ?? work.images?.thumb ?? null,
    detailUrl: `https://www.dlsite.com/${site}/work/=/product_id/${work.workno}.html`,
    fileSizeBytes: work.pc_file_size ?? null,
    fileSizeText: formatBytes(work.pc_file_size),
    isDownloadable:
      !!(work.downloadable || work.has_pc_download_content) ||
      (!!purchase && purchase.dlKind !== 'none'),
    isStreaming: !!work.playable,
    links: purchaseLinks(purchase),
    serialKey: purchase?.serialKey ?? null,
    priceText: purchase?.priceText ?? null,
    // まとめ買いの収録作品は親（パック）に紐付けておく
    parentProductId: purchase?.parentWorkno ?? null,
    tags: [...new Set(tags)],
    raw: work
  };
}

/** 1472137762 → "1.37GB"。DLsiteの作品ページと同じ 1024 刻みの表記に合わせる */
function formatBytes(bytes: number | null | undefined): string | null {
  if (!bytes || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(2)}${units[unit]}`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** ジャンルID→日本語名。100件ずつに分けて引く（本家と同じ刻み） */
async function fetchGenreNames(ids: number[]): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  for (const part of chunk([...new Set(ids)], 100)) {
    try {
      const res = await post<{ genres?: Genre[] }>('/api/v3/genres', { genre_ids: part });
      for (const g of res.genres ?? []) {
        const name = jp(g.name);
        if (name) names.set(g.id, name);
      }
    } catch {
      // ジャンル名が引けなくてもタグが減るだけなので、同期そのものは続ける
    }
    await politeDelay();
  }
  return names;
}

export const dlsiteLibraryFloor: FloorAdapter = {
  floorId: 'library',
  label: 'DLsite',

  async fetchAll(ctx: FloorSyncContext): Promise<ProductInput[]> {
    const count = await get<CountResponse>('/api/v4/content/count?last=0');
    const pageLimit = Math.max(1, count.page_limit ?? 100);
    const total = (count.user ?? 0) + (count.production ?? 0);
    ctx.onProgress(0, total || null, t('DLsite: {total} 件', { total }));

    // 購入日は sales にしかない
    const salesRaw = await get<SalesItem[] | { sales?: SalesItem[] }>('/api/v4/content/sales?last=0');
    const sales = Array.isArray(salesRaw) ? salesRaw : (salesRaw.sales ?? []);
    const salesDates = new Map<string, string | null>();
    for (const s of sales) salesDates.set(s.workno, s.sales_date ?? null);

    // 差分モードでは、まだ持っていない作品と、持っていてもダウンロード導線が
    // 入っていない作品だけを引く。作品情報（名前・サークル・ジャンル）は基本変わらないので
    // 取り直す必要がなく、導線が欠けている行だけは購入履歴とあわせて埋め直したい。
    const allWorknos = [...salesDates.keys()];
    const worknos = ctx.incremental ? allWorknos.filter((w) => !ctx.isComplete(w)) : allWorknos;
    if (ctx.incremental) {
      ctx.onProgress(0, total || null, t('DLsite: 新規 {length} 件ぶんを取得します', { length: worknos.length }));
    }
    const works: DlsiteWork[] = [];
    for (const part of chunk(worknos, pageLimit)) {
      if (ctx.isCancelled()) break;
      const res = await post<{ works?: DlsiteWork[] }>('/api/v4/content/works', { worknos: part });
      works.push(...(res.works ?? []));
      ctx.onProgress(works.length, total || null);
      await politeDelay();
    }

    // 法人(production)購入分。持っていなければ 0 件で素通りする。
    if ((count.production ?? 0) > 0 && !ctx.isCancelled()) {
      const pages = Math.ceil((count.production ?? 0) / pageLimit);
      for (let page = 1; page <= pages; page++) {
        if (ctx.isCancelled()) break;
        try {
          const res = await get<{ works?: DlsiteWork[] }>(
            `/api/v4/content/products?page=${page}&last=0`
          );
          works.push(...(res.works ?? []));
        } catch {
          break;
        }
        ctx.onProgress(works.length, total || null);
        await politeDelay();
      }
    }

    ctx.onProgress(works.length, total || null, t('DLsite: ジャンル名を取得中'));
    const genreNames = await fetchGenreNames(works.flatMap((w) => w.genre_ids ?? []));

    // ダウンロード導線・価格・ライセンスキーは旧www側にしかない。
    // ここが落ちても作品一覧そのものは出したいので、失敗は握って続ける。
    ctx.onProgress(works.length, total || null, t('DLsite: 購入履歴を取得中'));
    let purchases = new Map<string, PurchaseInfo>();
    try {
      purchases = await buildPurchaseIndex({
        isCancelled: () => ctx.isCancelled(),
        onProgress: (message) => ctx.onProgress(works.length, total || null, message),
        // 導線（ダウンロード/シリアル）まで入っている作品だけのページに来たら打ち切る
        canStopAfterPage: (worknos) =>
          ctx.incremental && worknos.length > 0 && worknos.every((w) => ctx.isComplete(w)),
        // キーは変わらないので、取得済みの作品はページを開き直さない
        needsSerial: (workno) => !ctx.incremental || !ctx.hasSerial(workno)
      });
    } catch (err) {
      ctx.onProgress(
        works.length,
        total || null,
        t('DLsite: 購入履歴を取得できませんでした ({0})', { 0: err instanceof Error ? err.message : String(err) })
      );
    }

    const seen = new Set<string>();
    const out: ProductInput[] = [];
    for (const w of works) {
      if (!w.workno || seen.has(w.workno)) continue;
      seen.add(w.workno);
      out.push(
        mapDlsiteWork(w, salesDates.get(w.workno) ?? null, genreNames, purchases.get(w.workno))
      );
    }
    return out;
  }
};
