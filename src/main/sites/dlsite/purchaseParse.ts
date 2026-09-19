/**
 * DLsite の購入履歴ページ / シリアルページのHTMLを読む純粋関数。
 *
 * play.dlsite.com のAPIには「ダウンロード導線」と「ライセンスキー」が無く、
 * 旧www側のページにしかない。HTML依存で壊れやすいので通信を持たない形に切り出し、
 * 実キャプチャで検証できるようにしてある（tools/test-dlsite-purchase.mjs）。
 */

/** 購入履歴のDLボタンが指す先の種類 */
import type { ProductLink } from '@shared/types';
import { htmlToText } from '@shared/htmlText';

export type DlsiteDlKind = 'download' | 'split' | 'pack' | 'serial' | 'none';

/** 分割案内ページの実ファイルだけを番号順に返す。案内・広告リンクは含めない。 */
export function parseSplitPage(html: string, workno: string): ProductLink[] {
  const parts = new Map<number, ProductLink>();
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>/gi)) {
    let url: URL;
    try {
      url = new URL(htmlToText(match[2]), 'https://www.dlsite.com');
    } catch { continue; }
    if (url.origin !== 'https://www.dlsite.com') continue;
    const part = url.pathname.match(/^\/home\/download\/=\/number\/(\d+)\/product_id\/([A-Z]{2}\d+)\.html$/);
    if (!part || part[2] !== workno || Number(part[1]) < 1) continue;
    const number = Number(part[1]);
    if (!parts.has(number)) {
      parts.set(number, { label: `分割ダウンロード ${number}`, url: url.href, kind: 'download' });
    }
  }
  return [...parts.entries()].sort(([a], [b]) => a - b).map(([, link]) => link);
}

export interface UserbuyRow {
  workno: string;
  /** "2026/08/17 13:23" → "2026-08-17 13:23" */
  buyDate: string | null;
  priceText: string | null;
  paymentMethod: string | null;
  dlKind: DlsiteDlKind;
  dlUrl: string | null;
}

export interface UserbuyPage {
  /** ページャに出ている総件数。取れなければ null */
  total: number | null;
  rows: UserbuyRow[];
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "2026/08/17 13:23" → "2026-08-17 13:23" */
function normalizeDate(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const p = (v: string): string => v.padStart(2, '0');
  const date = `${m[1]}-${p(m[2])}-${p(m[3])}`;
  return m[4] ? `${date} ${p(m[4])}:${m[5]}` : date;
}

function dlKindOf(url: string): DlsiteDlKind {
  if (url.includes('/home/serial/')) return 'serial';
  if (url.includes('/home/download/split/')) return 'split';
  if (url.includes('/home/download/pack/')) return 'pack';
  if (url.includes('/home/download/')) return 'download';
  return 'none';
}

/**
 * 購入履歴（/home/mypage/userbuy/=/type/all/start/all/sort/1/order/1/page/N）。
 * 1行 = 1注文で、`td.buy_date` / 作品リンク / `td.re_dl` の DLボタン /
 * `td.payment_method` / `td.work_price` を持つ。
 */
export function parseUserbuyPage(html: string): UserbuyPage {
  const totalMatch = html.match(/class="page_total"[^>]*>\s*<strong>([\d,]+)</);
  const total = totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : null;

  const rows: UserbuyRow[] = [];
  for (const m of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const tr = m[1];
    const buyDate = tr.match(/<td class="buy_date">([^<]*)<\/td>/)?.[1];
    if (!buyDate) continue; // ヘッダ行など

    const workno = tr.match(/product_id\/([A-Z]{2}\d+)\.html/)?.[1];
    if (!workno) continue;

    const dlUrl =
      tr.match(/<td class="re_dl">[\s\S]*?<a[^>]+href="([^"]+)"[^>]*class="btn_dl"/)?.[1] ??
      tr.match(/<a[^>]+class="btn_dl"[^>]*href="([^"]+)"/)?.[1] ??
      null;

    const priceCell = tr.match(/<td class="work_price">([\s\S]*?)<\/td>/)?.[1];
    const payCell = tr.match(/<td class="payment_method">([\s\S]*?)<\/td>/)?.[1];
    const payment = payCell ? stripTags(payCell) : null;

    rows.push({
      workno,
      buyDate: normalizeDate(buyDate),
      priceText: priceCell ? stripTags(priceCell) || null : null,
      paymentMethod: payment && payment !== '-' ? payment : null,
      dlKind: dlUrl ? dlKindOf(dlUrl) : 'none',
      dlUrl
    });
  }
  return { total, rows };
}

export interface SerialInfo {
  /** ライセンスキー。取れなければ null */
  licenseKey: string | null;
  /** 実ファイルのダウンロードページURL */
  downloadUrl: string | null;
}

/**
 * ライセンスキー確認ページ（/home/serial/=/product_id/{workno}.html）。
 * 実HTMLで確認済みの構造:
 *   <table><tr><th>ライセンスキー</th><td><strong class="color_02">XXXX-XXXX-XXXX-XXXX</strong></td></tr></table>
 *   <p class="work_download"><a href="…/home/download/=/product_id/{workno}.html" class="btn_dl">ダウンロード</a></p>
 */
export function parseSerialPage(html: string): SerialInfo {
  const cell = html.match(/<th>\s*ライセンスキー\s*<\/th>\s*<td>([\s\S]*?)<\/td>/)?.[1];
  const licenseKey = cell ? stripTags(cell) || null : null;
  const downloadUrl =
    html.match(/<p class="work_download">\s*<a[^>]+href="([^"]+)"/)?.[1] ??
    html.match(/href="(https:\/\/www\.dlsite\.com\/home\/download\/=\/product_id\/[^"]+)"/)?.[1] ??
    null;
  return { licenseKey, downloadUrl };
}

export interface PackChild {
  workno: string;
  title: string | null;
  dlKind: DlsiteDlKind;
  dlUrl: string | null;
}

/**
 * まとめ買い（パック）のダウンロードページ
 * （/home/download/pack/product/=/product_id/{親workno}.html）。
 *
 * 親作品の行に続けて `<tr class="child_item">` が収録作品ぶん並ぶ。子作品は
 * 単体の販売ページが消えていることがある（/pro/work/… が404になる作品がある）が、
 * このページからは各作品のダウンロード（またはシリアル）へ行ける。
 */
export function parsePackPage(html: string): PackChild[] {
  const children: PackChild[] = [];
  for (const m of html.matchAll(/<tr class="child_item">([\s\S]*?)<\/tr>/g)) {
    const tr = m[1];
    const workno = tr.match(/product_id\/([A-Z]{2}\d+)\.html/)?.[1];
    if (!workno) continue;

    // ダウンロード導線は work_download ブロックの中だけを見る（配信/SNSの a と混ざるため）
    const block = tr.match(/<div class="work_download">([\s\S]*?)<\/div>/)?.[1] ?? '';
    const href = block.match(/href="([^"#]+)"/)?.[1] ?? null;
    const title = tr.match(/<dd class="work_name">([\s\S]*?)<\/dd>/)?.[1];

    children.push({
      workno,
      title: title ? stripTags(title) || null : null,
      dlKind: href ? dlKindOf(href) : 'none',
      dlUrl: href
    });
  }
  return children;
}
