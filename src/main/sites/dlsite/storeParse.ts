import type { Creator } from '@shared/types';

/**
 * DLsite の作品ページ（www 側）から、play API に無いメタを読む純粋関数。
 *
 * play の works API が返すのは workno / 名前 / サークル / ジャンルID / 容量ぐらいで、
 * **説明文とスタッフ（シナリオ・イラスト・声優…）が無い**。どちらも作品ページにしかない。
 * HTML依存で壊れやすいので通信を持たない形に切り出し、実キャプチャで検証している
 * （tools/test-dlsite-store.mjs）。
 */

export interface DlsiteStoreMeta {
  description: string | null;
  /** 作者・シナリオ・イラスト・声優など。役割はページの見出しをそのまま使う */
  creators: Creator[];
  /** 「ジャンル」欄。play 側のジャンル名と重なるが、取りこぼしを埋める */
  tags: string[];
  /** 「ファイル容量」欄。"1.37GB" のような表示文字列 */
  fileSizeText: string | null;
  /**
   * 「作品情報/動作環境」の一覧（CPU・メモリ・必要解像度・DirectX など）。
   * PCゲーム(pro/soft)にしか無い。
   */
  spec: Array<{ label: string; value: string }>;
  /** 「販売日」欄。"YYYY-MM-DD" */
  releasedAt: string | null;
  seriesName: string | null;
}

/** 作品ページの見出しのうち、人・団体を指すもの。値はそのまま役割名にする */
const CREATOR_LABELS = new Set([
  'サークル名',
  'ブランド名',
  'メーカー',
  '作者',
  '著者',
  '原作',
  'シナリオ',
  'イラスト',
  '原画',
  '声優',
  '音楽',
  '翻訳',
  '出版社',
  'レーベル'
]);

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/[ \t　]+/g, ' ').trim();
}

/** 改行を保った本文向け。<br> と </p> は改行にする */
function stripTagsKeepBreaks(html: string): string {
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t　]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** "2024年05月17日" → "2024-05-17" */
function jpDate(text: string): string | null {
  const m = text.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (!m) return null;
  const p = (v: string): string => v.padStart(2, '0');
  return `${m[1]}-${p(m[2])}-${p(m[3])}`;
}

/** td の中の <a> をひとつずつ取り出す。無ければテキスト全体を1件として返す */
function cellValues(td: string): string[] {
  const links = [...td.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => stripTags(m[1]))
    .filter(Boolean);
  if (links.length) return [...new Set(links)];
  const text = stripTags(td);
  return text ? [text] : [];
}

/**
 * 作品ページ。要点は2か所:
 *   - 説明文: <div itemprop="description" class="work_parts_container"> …
 *   - 諸元  : <table id="work_outline"> の <th>見出し</th><td>値</td> の並び
 */
export function parseDlsiteWorkPage(html: string): DlsiteStoreMeta {
  const meta: DlsiteStoreMeta = {
    description: null,
    creators: [],
    tags: [],
    fileSizeText: null,
    spec: [],
    releasedAt: null,
    seriesName: null
  };

  const descBlock =
    html.match(/<div[^>]*itemprop="description"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/)?.[1] ??
    html.match(/<div[^>]*itemprop="description"[^>]*>([\s\S]*?)<div id="work_/)?.[1] ??
    null;
  if (descBlock) {
    const text = stripTagsKeepBreaks(descBlock);
    meta.description = text || null;
  }
  if (!meta.description) {
    // 作品ページの構造が変わっていても、meta description なら残っていることが多い
    const m = html.match(/<meta name="description" content="([^"]*)"/);
    if (m) meta.description = decodeEntities(m[1]).trim() || null;
  }

  const table = html.match(/<table[^>]*id="work_outline"[^>]*>([\s\S]*?)<\/table>/)?.[1] ?? '';
  for (const row of table.matchAll(/<tr>\s*<th>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) {
    const label = stripTags(row[1]);
    const td = row[2];

    if (label === '販売日' || label === '発売日') {
      meta.releasedAt = jpDate(stripTags(td));
      continue;
    }
    if (label === 'ファイル容量') {
      meta.fileSizeText = stripTags(td).replace(/^合計\s*/, '') || null;
      continue;
    }
    if (label === 'ジャンル') {
      meta.tags.push(...cellValues(td));
      continue;
    }
    if (label === 'シリーズ名') {
      meta.seriesName = cellValues(td)[0] ?? null;
      continue;
    }
    if (CREATOR_LABELS.has(label)) {
      for (const name of cellValues(td)) {
        meta.creators.push({ role: label, name, id: null });
      }
    }
  }

  // PCゲーム(pro/soft)はファイル容量と動作環境が work_outline ではなく
  // 「作品情報/動作環境」の dl に入っている。
  const specList = html.match(/<dl class="work_spec_list">([\s\S]*?)<\/dl>/)?.[1] ?? '';
  for (const item of specList.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) {
    const label = stripTags(item[1]);
    const value = stripTags(item[2]);
    if (!label || !value) continue;
    if (label === 'ファイル容量') {
      meta.fileSizeText = meta.fileSizeText ?? value;
      continue;
    }
    meta.spec.push({ label, value });
  }

  meta.tags = [...new Set(meta.tags)];
  return meta;
}
