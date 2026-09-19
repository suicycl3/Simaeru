import type { Creator } from '@shared/types';

/**
 * 店舗ページHTMLから作品メタを取り出す純粋関数群。
 *
 * 作品説明・ジャンル（タグ）・スタッフは購入履歴系のAPIには一切含まれておらず、
 * 店舗の作品ページにしか無いため、HTMLから拾うしかない。構造依存で壊れやすいので、
 * ここは通信を持たない純粋関数に切り出してある（実HTMLを食わせて検証できるように）。
 * 検証: node tools/test-store-parse.mjs
 */

export interface StoreMeta {
  description: string | null;
  tags: string[];
  creators: Creator[];
  /** ページに配信開始日があれば 'YYYY-MM-DD HH:mm' で返す */
  releasedAt?: string | null;
  /** ページにファイル容量があればそのまま返す */
  fileSizeText?: string | null;
  /** 何か1つでも取れたか。UIで「取れなかった」と分かるようにするための印 */
  ok: boolean;
}

export const EMPTY_STORE_META: StoreMeta = {
  description: null,
  tags: [],
  creators: [],
  ok: false
};

function decode(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

function stripTags(html: string): string {
  return decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** <br> を改行として残しつつテキスト化する（作品説明用） */
function stripTagsKeepBreaks(html: string): string {
  return decode(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .split('\n')
    .map((line) => line.replace(/[ \t　]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 値のセルから項目を取り出す。リンクの羅列ならリンク文字列を、
 * そうでなければセル全体をひとつの値として返す。
 */
function cellValues(cellHtml: string): string[] {
  const anchors = [...cellHtml.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => stripTags(m[1]))
    .filter(Boolean);
  if (anchors.length > 0) return [...new Set(anchors)];
  const plain = stripTags(cellHtml);
  return plain ? [plain] : [];
}

/** リンクのURLから記事IDを拾う（?maker=123 / article=creator/id=<uuid> 等） */
function idFromCell(cellHtml: string): string | null {
  const m =
    cellHtml.match(/article=[a-z_]+\/id=([^/"']+)/i) ??
    cellHtml.match(/[?&](?:maker|author|article_id)=([^&"']+)/i);
  return m ? m[1] : null;
}

function descriptionFromJsonLd(html: string): string | null {
  const blocks = html.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g
  );
  for (const block of blocks) {
    try {
      const json = JSON.parse(block[1].trim()) as { '@type'?: string; description?: string };
      if (json['@type'] === 'BreadcrumbList') continue;
      if (typeof json.description === 'string' && json.description.trim()) {
        return json.description.trim();
      }
    } catch {
      /* 壊れたJSON-LDは飛ばす */
    }
  }
  return null;
}

function descriptionFromOg(html: string): string | null {
  const m = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i);
  const text = m?.[1] ? decode(m[1]).trim() : '';
  return text || null;
}

interface LabelRow {
  label: string;
  values: string[];
  id: string | null;
}

/** PCゲーム: ラベルと値が別divの表組み */
function parseDivTable(html: string): LabelRow[] {
  const pattern =
    /contentsDetailBottom__tableDataLeft"[^>]*>\s*<p>([\s\S]*?)<\/p>[\s\S]*?contentsDetailBottom__tableDataRight"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  const out: LabelRow[] = [];
  for (const m of html.matchAll(pattern)) {
    const label = stripTags(m[1]);
    if (label) out.push({ label, values: cellValues(m[2]), id: idFromCell(m[2]) });
  }
  return out;
}

/**
 * 同人: <dl class="informationList"><dt …__ttl>ラベル</dt><dd …__txt|__item>値</dd></dl>
 * 値セルのクラスは一定ではなく、ジャンルだけ `informationList__item`（中は genreTagList）になる。
 */
function parseDefinitionList(html: string): LabelRow[] {
  const pattern =
    /informationList__ttl"[^>]*>([\s\S]*?)<\/dt>\s*<dd class="informationList__(?:txt|item)"[^>]*>([\s\S]*?)<\/dd>/g;
  const out: LabelRow[] = [];
  for (const m of html.matchAll(pattern)) {
    const label = stripTags(m[1]);
    if (label) out.push({ label, values: cellValues(m[2]), id: idFromCell(m[2]) });
  }
  return out;
}

const TAG_LABELS = ['ジャンル', 'ゲームジャンル', '題材', 'カテゴリー'];
const CREATOR_LABELS = [
  '原画',
  'シナリオ',
  '声優',
  '音楽',
  '監督',
  '著者',
  '作者',
  '作家',
  'サークル',
  'シリーズ',
  'シリーズ名',
  '出版社',
  '掲載誌・レーベル'
];

function split(rows: LabelRow[]): { tags: string[]; creators: Creator[] } {
  const tags: string[] = [];
  const creators: Creator[] = [];
  for (const row of rows) {
    if (TAG_LABELS.includes(row.label)) {
      tags.push(...row.values);
    } else if (CREATOR_LABELS.includes(row.label)) {
      for (const name of row.values) {
        creators.push({ role: row.label, name, id: row.values.length === 1 ? row.id : null });
      }
    }
  }
  return { tags: [...new Set(tags)], creators };
}

function build(description: string | null, rows: LabelRow[]): StoreMeta {
  const { tags, creators } = split(rows);
  return {
    description,
    tags,
    creators,
    ok: !!description || tags.length > 0 || creators.length > 0
  };
}

/** "2026/01/30 00:00" → "2026-01-30 00:00" */
function normalizeDate(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}:\d{2}))?/);
  if (!m) return null;
  const date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return m[4] ? `${date} ${m[4]}` : date;
}

/** 汎用の <dt>ラベル</dt><dd>値</dd>。クラス名がハッシュ化されている電子書籍で使う */
function parseDtDd(html: string): LabelRow[] {
  const out: LabelRow[] = [];
  for (const m of html.matchAll(/<dt[^>]*>([\s\S]{0,60}?)<\/dt>\s*<dd[^>]*>([\s\S]{0,2000}?)<\/dd>/g)) {
    const label = stripTags(m[1]);
    if (!label) continue;
    const values = cellValues(m[2]).filter((v) => v !== '----' && v !== '―');
    out.push({ label, values, id: idFromCell(m[2]) });
  }
  return out;
}

/**
 * 電子書籍の店舗ページ。実HTMLで確認済み:
 *  - JSON-LD(Product) に全文の description と brand(出版社)
 *  - <dl><dt>ラベル</dt><dd>値</dd></dl> に
 *    シリーズ名 / 作者 / 掲載誌・レーベル / 出版社 / カテゴリー / ジャンル /
 *    配信開始日 / ファイル容量 / ファイル形式 / 閲覧環境
 *  - クラス名は styled-components のハッシュで不安定なので、dt/dd の構造だけで拾う
 */
export function parseBookStoreHtml(html: string): StoreMeta {
  const rows = parseDtDd(html);
  const pick = (label: string): LabelRow | undefined => rows.find((r) => r.label === label);
  const base = build(descriptionFromJsonLd(html) ?? descriptionFromOg(html), rows);
  return {
    ...base,
    releasedAt: normalizeDate(pick('配信開始日')?.values[0]),
    fileSizeText: pick('ファイル容量')?.values[0] ?? null,
    ok: base.ok || rows.length > 0
  };
}

/**
 * PCゲームの店舗ページ。実HTMLで確認済み:
 *  - JSON-LD(Product) に全文の description
 *  - contentsDetailBottom__tableDataLeft/Right の表に
 *    原画 / シナリオ / 声優 / ゲームジャンル / ジャンル / 対応OS / 配信開始日
 */
export function parseDlsoftStoreHtml(html: string): StoreMeta {
  return build(descriptionFromJsonLd(html) ?? descriptionFromOg(html), parseDivTable(html));
}

/**
 * 同人の店舗ページ。実HTMLで確認済み:
 *  - 作品説明は <p class="summary__txt">（JSON-LD の description はSEO用の要約なので使わない）
 *  - 属性は <dl class="informationList"> の dt/dd に
 *    配信開始日 / 作者 / 作品形式 / ページ数 / シリーズ / 題材 / ジャンル / ファイル容量
 */
export function parseDoujinStoreHtml(html: string): StoreMeta {
  const m = html.match(/<p class="summary__txt"[^>]*>([\s\S]*?)<\/p>/);
  const description = m ? stripTagsKeepBreaks(m[1]) || null : descriptionFromOg(html);
  return build(description, parseDefinitionList(html));
}
