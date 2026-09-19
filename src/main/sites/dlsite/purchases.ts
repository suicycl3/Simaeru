import { getWwwHtml, politeDelay } from './client';
import {
  parsePackPage,
  parseSerialPage,
  parseSplitPage,
  parseUserbuyPage,
  type DlsiteDlKind,
  type PackChild,
  type SerialInfo,
  type UserbuyRow
} from './purchaseParse';
import { t } from '@shared/i18n';

/**
 * DLsite の購入履歴（旧www側）。
 *
 * play API のライブラリには「ダウンロード導線」「ライセンスキー」「価格」が無い。
 * とくにPCゲーム(pro/soft)にはシリアルコード配布のみの作品があり、
 * その場合ダウンロードボタンは /home/serial/ を指す。判定にはこの履歴が要る。
 */

/** 1ページ50件固定（実測） */
const PAGE_SIZE = 50;
/** 事故防止の上限。1ページ50件なので 40 ページ = 2000 件 */
const MAX_PAGES = 40;

function userbuyPath(page: number): string {
  return `/home/mypage/userbuy/=/type/all/start/all/sort/1/order/1/page/${page}`;
}

export interface PurchaseFetchOptions {
  onProgress?: (message: string) => void;
  isCancelled?: () => boolean;
  /**
   * 差分同期用。1ページぶんの workno を渡して true が返ったら、そこで読むのをやめる。
   * 購入履歴は新しい順なので、そのページが全部「取得済み（導線まで入っている）」なら
   * それより古いぶんも取得済み。
   */
  canStopAfterPage?: (worknos: string[]) => boolean;
  /**
   * ライセンスキーを取りに行くかどうか。取得済みの作品はページを開き直さない
   * （キーは変わらないので、差分同期のたびに開くのは無駄なリクエストになる）。
   */
  needsSerial?: (workno: string) => boolean;
}

/** 作品1件ぶんの購入まわりの情報。履歴＋（必要なら）パック/シリアルのページから組み立てる */
export interface PurchaseInfo {
  workno: string;
  buyDate: string | null;
  priceText: string | null;
  dlKind: DlsiteDlKind;
  /** 履歴のDLボタンの行き先。シリアル配布ならキー確認ページ */
  dlUrl: string | null;
  /** シリアル配布のとき、キー確認ページから取ったライセンスキー */
  serialKey: string | null;
  /** 実ファイルのダウンロードURL。シリアル配布はキー確認ページにしか出てこない */
  downloadUrl: string | null;
  /** まとめ買いの収録作品なら、親（パック）の workno */
  parentWorkno: string | null;
}

/**
 * 購入履歴を全ページ辿って workno 単位にまとめる。
 * 同じ作品を複数回買っている場合は、最初に出てきた行（＝新しい注文）を採る。
 */
export async function fetchAllPurchases(
  opts: PurchaseFetchOptions = {}
): Promise<Map<string, UserbuyRow>> {
  const rows = new Map<string, UserbuyRow>();
  let total: number | null = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (opts.isCancelled?.()) break;
    const html = await getWwwHtml(userbuyPath(page));
    const parsed = parseUserbuyPage(html);
    if (page === 1) total = parsed.total;
    if (parsed.rows.length === 0) break;

    for (const row of parsed.rows) {
      if (!rows.has(row.workno)) rows.set(row.workno, row);
    }
    opts.onProgress?.(t('DLsite: 購入履歴 {size}/{1} 件', { size: rows.size, 1: total ?? '?' }));

    if (opts.canStopAfterPage?.(parsed.rows.map((r) => r.workno))) {
      opts.onProgress?.(t('DLsite: 購入履歴は既知のぶんに到達したので打ち切りました'));
      break;
    }

    // 総件数が分かっていればそれで、分からなければ半端なページで終わりと判断する
    const seen = page * PAGE_SIZE;
    if (total !== null ? seen >= total : parsed.rows.length < PAGE_SIZE) break;
    await politeDelay();
  }
  return rows;
}

/** ライセンスキー確認ページ。シリアル配布の作品にしか無い */
export async function fetchSerialInfo(workno: string): Promise<SerialInfo> {
  const html = await getWwwHtml(`/home/serial/=/product_id/${workno}.html`);
  return parseSerialPage(html);
}

/**
 * 案内HTMLだけを取得する。各ファイルURLは DownloadManager に渡す。
 * DLsite は未ログインだとこのページを 404 で返すので、「作品が消えた」と読めない文言にする。
 */
export async function fetchSplitLinks(workno: string) {
  let html: string;
  try {
    html = await getWwwHtml(`/home/download/split/=/product_id/${workno}.html`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/HTTP 404|HTTP 410/.test(message)) {
      throw new Error(t('分割ダウンロードの案内ページを開けませんでした。DLsite にログインしていないか、作品が取り下げられています（{workno}）', { workno }));
    }
    throw err;
  }
  return parseSplitPage(html, workno);
}

/** まとめ買い（パック）のダウンロードページ。収録作品ごとの導線が並んでいる */
export async function fetchPackChildren(workno: string): Promise<PackChild[]> {
  const html = await getWwwHtml(`/home/download/pack/product/=/product_id/${workno}.html`);
  return parsePackPage(html);
}

function infoFromRow(row: UserbuyRow): PurchaseInfo {
  return {
    workno: row.workno,
    buyDate: row.buyDate,
    priceText: row.priceText,
    dlKind: row.dlKind,
    dlUrl: row.dlUrl,
    serialKey: null,
    // 履歴のリンクがそのまま実ファイルを指すのは download のときだけ
    downloadUrl: row.dlKind === 'download' ? row.dlUrl : null,
    parentWorkno: null
  };
}

/**
 * 購入まわりの情報を workno 単位で作る。履歴だけでは足りないぶんを補う:
 *
 * - まとめ買い(pack)は履歴に親の1行しか出ないので、パックのページを開いて
 *   収録作品それぞれの導線を拾う。収録作品は単体の販売ページが消えていることがあり
 *   （実測で確認）、この経路でしかダウンロードに辿り着けない。
 * - シリアル配布(serial)はキー確認ページを開いて、ライセンスキーと実ファイルのURLを取る。
 *   どちらもそのページにしか無いので、サイトへ飛ばさずアプリ側で持っておく。
 *
 * 個別のページ取得に失敗しても、その作品が履歴どまりになるだけなので握りつぶして続ける。
 */
export async function buildPurchaseIndex(
  opts: PurchaseFetchOptions = {}
): Promise<Map<string, PurchaseInfo>> {
  const rows = await fetchAllPurchases(opts);
  const index = new Map<string, PurchaseInfo>();
  for (const row of rows.values()) index.set(row.workno, infoFromRow(row));

  // まとめ買いを収録作品へ展開する
  const packs = [...index.values()].filter((p) => p.dlKind === 'pack');
  for (const [i, pack] of packs.entries()) {
    if (opts.isCancelled?.()) break;
    opts.onProgress?.(t('DLsite: まとめ買いの収録作品 {0}/{length}', { 0: i + 1, length: packs.length }));
    try {
      for (const child of await fetchPackChildren(pack.workno)) {
        // 単体でも買っていた場合は、そちらの履歴（価格や購入日がある）を優先する
        if (index.has(child.workno)) continue;
        index.set(child.workno, {
          workno: child.workno,
          buyDate: pack.buyDate,
          priceText: null,
          dlKind: child.dlKind,
          dlUrl: child.dlUrl,
          serialKey: null,
          downloadUrl: child.dlKind === 'download' ? child.dlUrl : null,
          parentWorkno: pack.workno
        });
      }
    } catch {
      // パックのページが開けなければ親の導線だけ残る
    }
    await politeDelay();
  }

  // シリアル配布はキーと実ファイルURLを取りに行く（取得済みのぶんは飛ばす）
  const serials = [...index.values()].filter(
    (p) => p.dlKind === 'serial' && (opts.needsSerial?.(p.workno) ?? true)
  );
  for (const [i, entry] of serials.entries()) {
    if (opts.isCancelled?.()) break;
    opts.onProgress?.(t('DLsite: ライセンスキー {0}/{length}', { 0: i + 1, length: serials.length }));
    try {
      const serial = await fetchSerialInfo(entry.workno);
      entry.serialKey = serial.licenseKey;
      entry.downloadUrl = serial.downloadUrl;
    } catch {
      // 取れなければキー確認ページへのリンクだけ残る
    }
    await politeDelay();
  }

  return index;
}

export type { SerialInfo, UserbuyRow };
