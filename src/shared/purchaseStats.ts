/**
 * 購入履歴の統計と、件数の移り変わり（バーチャートレース）の元データを作る。
 * DB には触らない純粋な関数。メインは台帳から読んだ行を渡し、画面の見本（devMock）は見本の作品を渡す。
 *
 * - 1 つの作品は、同じ鍵（名寄せ後のタグ・ブランドなど）について 1 件として数える
 * - タグは tagRules の分類と利用者の上書きを通し、属性のタグだけを数える
 * - 購入日の無い作品は数えない（今の台帳ではすべてにある）
 */
import type { Creator, WorkType } from './types';
import { WORK_TYPE_LABELS } from './types';
import {
  EMPTY_TAG_OVERRIDES,
  TAG_GROUPS,
  canonicalTag,
  classifyTag,
  classifyTagIn,
  dictionaryOf,
  tagFoldKey,
  tidyTagLabel,
  type TagDictionary,
  type TagKind,
  type TagRuleOverrides
} from './tagRules';

export interface StatsRow {
  siteId: string;
  /** フロア（公式ジャンルの一覧がそろったフロアかを見る）。無ければ語の形だけで判定する */
  floorId?: string | null;
  workType: WorkType | null;
  /** 'YYYY-MM-DD' または 'YYYY-MM-DD HH:mm' */
  purchasedAt: string | null;
  maker: string | null;
  creators: Creator[];
  tags: string[];
  /** 作品の詳細（店舗ページのジャンル・スタッフ）を取得済みか。省略は取得済みとみなす */
  metaFetched?: boolean;
  /** 詳細の取得を試行回数の上限まで試して、取れなかったか */
  metaGivenUp?: boolean;
}

/**
 * タグ情報のある作品か。詳細を取得済みのもの。DLsite は同期の時点でジャンル名まで取れるので、未取得でもタグ情報がある。
 * DMM は同期で取れるタグがほぼ属性ではない（「DLゲーム」「ブラウザ対応」など）ので、詳細を取るまでタグ情報は無いとみなす
 */
export const hasTagInfo = (row: Pick<StatsRow, 'siteId' | 'metaFetched'>): boolean => row.metaFetched !== false || row.siteId === 'dlsite';
/** 声優・作者などの人の情報があるか。どちらのサイトも詳細を取らないと分からない */
export const hasPeopleInfo = (row: Pick<StatsRow, 'metaFetched'>): boolean => row.metaFetched !== false;

export interface StatsFilter {
  /** 'YYYY-MM'（この月を含む） */
  from?: string | null;
  /** 'YYYY-MM'（この月を含む） */
  to?: string | null;
  /** 空・省略ならすべてのサイト */
  siteIds?: string[];
}

export interface RankItem {
  key: string;
  label: string;
  count: number;
}

export interface ExcludedTag extends RankItem {
  kind: TagKind;
  /** 利用者が外した（kind は属性） */
  byUser: boolean;
}

export interface PurchaseStats {
  total: number;
  /**
   * タグ情報の揃い具合（絞り込みの中で）。
   * - tagged: タグ情報のある作品（タグの割合はこれで割る）
   * - unfetched: 詳細を取っていない作品（DMM。DLsite は同期でタグが取れるので含めない）
   * - givenUp: unfetched のうち、取得を試しきって取れなかったもの
   * - peopleMissing: 声優・作者の分からない作品（詳細を取っていない作品。DLsite も含む）
   * - noAttributeTags: タグ情報はあるが、数える属性タグが 1 つも無い作品（店舗ページが無くなった作品など）
   */
  coverage: { tagged: number; unfetched: number; givenUp: number; peopleMissing: number; noAttributeTags: number };
  firstMonth: string | null;
  lastMonth: string | null;
  bySite: Array<{ siteId: string; count: number }>;
  byWorkType: Array<{ workType: WorkType | 'unknown'; label: string; count: number }>;
  monthly: Array<{ month: string; total: number; bySite: Record<string, number> }>;
  /** 数えるタグすべて（件数の多い順）。画面は上位だけ出し、切り替えで残りも出す */
  tags: Array<RankItem & { sites: string[] }>;
  /**
   * 期間の終わりから 12 か月と、その前の 12 か月で、購入に占める割合が増えたタグ。
   * 件数の差で比べると、買う数が増えただけで上位のタグが並ぶので、割合で比べる
   */
  risingTags: Array<RankItem & { previous: number; share: number; previousShare: number }>;
  makers: RankItem[];
  voices: RankItem[];
  authors: RankItem[];
  excludedTags: ExcludedTag[];
  /** 利用者が「数える」に戻したタグ */
  includedTags: Array<RankItem & { kind: TagKind }>;
  /** 時刻のある作品だけの、曜日（0=日）× 時（0〜23）の件数 */
  weekHour: { count: number; cells: number[][] };
}

export type RaceDimension = 'tag' | 'maker' | 'voice' | 'author' | 'workType';
export type RaceMode = 'cumulative' | 'window';

export interface RaceOptions extends StatsFilter {
  dimension: RaceDimension;
  mode: RaceMode;
  /** mode = 'window' のときの幅（か月） */
  windowMonths?: number;
  /** 一度でも上位この本数に入ったものだけを返す */
  topN: number;
}

export interface RaceData {
  months: string[];
  /** その月に買った件数（絞り込み後） */
  monthTotals: number[];
  series: Array<{ key: string; label: string; values: number[] }>;
  /**
   * 選んだ対象の情報がまだ無い作品（タグ・声優・作者は詳細を取るまで分からない）。
   * recent は期間の終わりの 3 か月のうちの数（買ったばかりの作品ほど未取得になりやすい）
   */
  missing: { total: number; recent: number };
  /** 期間の中に 1 件以上ある対象の数（順位を指定できる上限） */
  totalKeys: number;
}

const VOICE_ROLES = new Set(['声優', '出演']);
const AUTHOR_ROLES = new Set(['作者', '作家', '著者', '原画', 'イラスト', 'シナリオ']);

export const monthOf = (purchasedAt: string | null): string | null =>
  purchasedAt && /^\d{4}-\d{2}/.test(purchasedAt) ? purchasedAt.slice(0, 7) : null;

/** from〜to の月の一覧（両端を含む） */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

function filterRows(rows: StatsRow[], filter: StatsFilter): Array<StatsRow & { month: string }> {
  const sites = filter.siteIds?.length ? new Set(filter.siteIds) : null;
  const out: Array<StatsRow & { month: string }> = [];
  for (const row of rows) {
    const month = monthOf(row.purchasedAt);
    if (!month) continue;
    if (filter.from && month < filter.from) continue;
    if (filter.to && month > filter.to) continue;
    if (sites && !sites.has(row.siteId)) continue;
    out.push({ ...row, month });
  }
  return out;
}

/** 表記ゆれだけでまとまったタグの代表名（一番多い表記）を決めるための数え台 */
class LabelVotes {
  private votes = new Map<string, Map<string, number>>();
  vote(key: string, label: string): void {
    const m = this.votes.get(key) ?? new Map<string, number>();
    m.set(label, (m.get(label) ?? 0) + 1);
    this.votes.set(key, m);
  }
  label(key: string): string {
    const m = this.votes.get(key);
    if (!m) return key;
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'))[0][0];
  }
}

/** 作品 1 件ぶんの、数えるタグの鍵（重なりは 1 つ）。代表名の投票もする */
function attributeTags(
  row: StatsRow,
  overrides: TagRuleOverrides,
  dictionary: TagDictionary,
  blurbs: ReadonlySet<string>,
  votes: LabelVotes
): string[] {
  const keys = new Set<string>();
  for (const tag of row.tags) {
    const { key, label } = canonicalTag(tag, dictionary);
    const excludedByUser = overrides.exclude.includes(key);
    const includedByUser = overrides.include.includes(key);
    if (excludedByUser || (!includedByUser && classifyTagIn(tag, row, dictionary, blurbs) !== 'attribute')) continue;
    votes.vote(key, label ?? tidyTagLabel(tag));
    keys.add(key);
  }
  return [...keys];
}

/** 作品 1 件ぶんの、次元ごとの鍵と表示名 */
function keysOf(
  row: StatsRow,
  dimension: RaceDimension,
  overrides: TagRuleOverrides,
  dictionary: TagDictionary,
  blurbs: ReadonlySet<string>,
  votes: LabelVotes
): Array<{ key: string; label: string }> {
  switch (dimension) {
    case 'tag':
      return attributeTags(row, overrides, dictionary, blurbs, votes).map((key) => ({ key, label: key }));
    case 'maker':
      return row.maker ? [{ key: `m:${row.maker}`, label: row.maker }] : [];
    case 'voice':
    case 'author': {
      const roles = dimension === 'voice' ? VOICE_ROLES : AUTHOR_ROLES;
      const names = new Set(row.creators.filter((c) => roles.has(c.role) && c.name.trim()).map((c) => c.name.trim()));
      return [...names].map((name) => ({ key: `p:${name}`, label: name }));
    }
    case 'workType': {
      const wt = row.workType ?? 'other';
      return [{ key: `w:${wt}`, label: WORK_TYPE_LABELS[wt] }];
    }
  }
}

function rank(counts: Map<string, number>, labelOf: (key: string) => string, limit: number): RankItem[] {
  return [...counts]
    .map(([key, count]) => ({ key, label: labelOf(key), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ja'))
    .slice(0, limit);
}

const bump = (map: Map<string, number>, key: string, by = 1): void => {
  map.set(key, (map.get(key) ?? 0) + by);
};

export function buildPurchaseStats(
  rows: StatsRow[],
  filter: StatsFilter = {},
  overrides: TagRuleOverrides = EMPTY_TAG_OVERRIDES,
  limit = 50
): PurchaseStats {
  const list = filterRows(rows, filter);
  const dictionary = dictionaryOf(overrides);
  const blurbs = new Set(overrides.blurbs ?? []);
  const months = list.map((r) => r.month).sort();
  const firstMonth = months[0] ?? null;
  const lastMonth = months.at(-1) ?? null;

  const bySite = new Map<string, number>();
  const byWorkType = new Map<string, number>();
  const monthly = new Map<string, { total: number; bySite: Record<string, number> }>();
  const tagCounts = new Map<string, number>();
  const tagSites = new Map<string, Set<string>>();
  const makers = new Map<string, number>();
  const voices = new Map<string, number>();
  const authors = new Map<string, number>();
  const excluded = new Map<string, { kind: TagKind; byUser: boolean; count: number }>();
  const included = new Map<string, { kind: TagKind; count: number }>();
  const votes = new LabelVotes();
  const cells = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  let timed = 0;

  // 増えたタグを見る 2 つの 12 か月（期間の終わりから）
  const recentFrom = lastMonth ? shiftMonth(lastMonth, -11) : null;
  const previousFrom = lastMonth ? shiftMonth(lastMonth, -23) : null;
  const recent = new Map<string, number>();
  const previous = new Map<string, number>();
  let recentTotal = 0;
  let previousTotal = 0;
  const coverage = { tagged: 0, unfetched: 0, givenUp: 0, peopleMissing: 0, noAttributeTags: 0 };

  for (const row of list) {
    bump(bySite, row.siteId);
    bump(byWorkType, row.workType ?? 'unknown');
    const tagged = hasTagInfo(row);
    if (!hasPeopleInfo(row)) coverage.peopleMissing++;
    if (tagged) {
      coverage.tagged++;
      // 割合が増えたタグは、タグ情報のある作品だけで割る（未取得の作品で割合が下がらないように）
      if (recentFrom && row.month >= recentFrom) recentTotal++;
      else if (previousFrom && row.month >= previousFrom) previousTotal++;
    } else {
      coverage.unfetched++;
      if (row.metaGivenUp) coverage.givenUp++;
    }
    const m = monthly.get(row.month) ?? { total: 0, bySite: {} };
    m.total++;
    m.bySite[row.siteId] = (m.bySite[row.siteId] ?? 0) + 1;
    monthly.set(row.month, m);

    const time = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):/.exec(row.purchasedAt ?? '');
    if (time) {
      const day = new Date(Number(time[1]), Number(time[2]) - 1, Number(time[3])).getDay();
      cells[day][Number(time[4])]++;
      timed++;
    }

    const seen = new Set<string>();
    let counted = 0;
    for (const tag of row.tags) {
      const { key, label } = canonicalTag(tag, dictionary);
      if (seen.has(key)) continue;
      seen.add(key);
      const kind = classifyTagIn(tag, row, dictionary, blurbs);
      const byUser = overrides.exclude.includes(key);
      const userIncluded = overrides.include.includes(key);
      votes.vote(key, label ?? tidyTagLabel(tag));
      if (byUser || (kind !== 'attribute' && !userIncluded)) {
        const e = excluded.get(key) ?? { kind, byUser, count: 0 };
        e.count++;
        excluded.set(key, e);
        continue;
      }
      if (userIncluded && kind !== 'attribute') {
        const i = included.get(key) ?? { kind, count: 0 };
        i.count++;
        included.set(key, i);
      }
      bump(tagCounts, key);
      counted++;
      const sites = tagSites.get(key) ?? new Set<string>();
      sites.add(row.siteId);
      tagSites.set(key, sites);
      if (recentFrom && row.month >= recentFrom) bump(recent, key);
      else if (previousFrom && row.month >= previousFrom) bump(previous, key);
    }
    if (tagged && counted === 0) coverage.noAttributeTags++;
    if (row.maker) bump(makers, row.maker);
    for (const name of new Set(row.creators.filter((c) => VOICE_ROLES.has(c.role)).map((c) => c.name.trim()))) if (name) bump(voices, name);
    for (const name of new Set(row.creators.filter((c) => AUTHOR_ROLES.has(c.role)).map((c) => c.name.trim()))) if (name) bump(authors, name);
  }

  const labelOf = (key: string): string => votes.label(key);
  return {
    total: list.length,
    coverage,
    firstMonth,
    lastMonth,
    bySite: [...bySite].map(([siteId, count]) => ({ siteId, count })).sort((a, b) => b.count - a.count),
    byWorkType: [...byWorkType]
      .map(([wt, count]) => ({
        workType: wt as WorkType | 'unknown',
        label: wt === 'unknown' ? '不明' : WORK_TYPE_LABELS[wt as WorkType],
        count
      }))
      .sort((a, b) => b.count - a.count),
    monthly: firstMonth && lastMonth
      ? monthRange(firstMonth, lastMonth).map((month) => ({ month, ...(monthly.get(month) ?? { total: 0, bySite: {} }) }))
      : [],
    tags: rank(tagCounts, labelOf, Infinity).map((r) => ({ ...r, sites: [...(tagSites.get(r.key) ?? [])].sort() })),
    risingTags: [...recent.keys()]
      .map((key) => {
        const count = recent.get(key) ?? 0;
        const before = previous.get(key) ?? 0;
        return {
          key,
          label: labelOf(key),
          count,
          previous: before,
          share: recentTotal ? count / recentTotal : 0,
          previousShare: previousTotal ? before / previousTotal : 0
        };
      })
      // 1 件だけのたまたまを除く
      .filter((r) => r.count >= 2 && r.share > r.previousShare)
      .sort((a, b) => b.share - b.previousShare - (a.share - a.previousShare) || b.count - a.count)
      .slice(0, 10),
    makers: rank(makers, (k) => k, limit),
    voices: rank(voices, (k) => k, limit),
    authors: rank(authors, (k) => k, limit),
    excludedTags: [...excluded]
      .map(([key, e]) => ({ key, label: labelOf(key), kind: e.byUser ? 'attribute' as TagKind : e.kind, byUser: e.byUser, count: e.count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ja')),
    includedTags: [...included]
      .map(([key, i]) => ({ key, label: labelOf(key), kind: i.kind, count: i.count }))
      .sort((a, b) => b.count - a.count),
    weekHour: { count: timed, cells }
  };
}

/**
 * 件数の移り変わり。月ごとに、累計（期間の始めから）か、直近 windowMonths か月の件数を出す。
 * 一度でも上位 topN に入ったものだけを返す（動画に出てこないものは送らない）。
 */
export function buildRaceData(rows: StatsRow[], options: RaceOptions, overrides: TagRuleOverrides = EMPTY_TAG_OVERRIDES): RaceData {
  const list = filterRows(rows, options);
  const dictionary = dictionaryOf(overrides);
  const blurbs = new Set(overrides.blurbs ?? []);
  const all = list.map((r) => r.month).sort();
  const from = options.from ?? all[0];
  const to = options.to ?? all.at(-1);
  if (!from || !to || from > to) return { months: [], monthTotals: [], series: [], missing: { total: 0, recent: 0 }, totalKeys: 0 };
  const months = monthRange(from, to);
  const index = new Map(months.map((m, i) => [m, i]));
  const monthTotals = new Array<number>(months.length).fill(0);
  const perMonth = new Map<string, number[]>();
  const labels = new Map<string, string>();
  const votes = new LabelVotes();

  const missing = { total: 0, recent: 0 };
  const needs = options.dimension === 'tag' ? hasTagInfo : options.dimension === 'voice' || options.dimension === 'author' ? hasPeopleInfo : () => true;
  for (const row of list) {
    const i = index.get(row.month);
    if (i === undefined) continue;
    monthTotals[i]++;
    if (!needs(row)) {
      missing.total++;
      if (i >= months.length - 3) missing.recent++;
    }
    for (const { key, label } of keysOf(row, options.dimension, overrides, dictionary, blurbs, votes)) {
      const arr = perMonth.get(key) ?? new Array<number>(months.length).fill(0);
      arr[i]++;
      perMonth.set(key, arr);
      labels.set(key, label);
    }
  }

  const window = Math.max(1, Math.round(options.windowMonths ?? 12));
  const values = new Map<string, number[]>();
  for (const [key, counts] of perMonth) {
    const out = new Array<number>(months.length).fill(0);
    let running = 0;
    for (let i = 0; i < counts.length; i++) {
      running += counts[i];
      if (options.mode === 'window' && i >= window) running -= counts[i - window];
      out[i] = running;
    }
    values.set(key, out);
  }

  // 月ごとの上位に一度でも入ったもの
  const keep = new Set<string>();
  const keys = [...values.keys()];
  for (let i = 0; i < months.length; i++) {
    keys
      .filter((k) => values.get(k)![i] > 0)
      .sort((a, b) => values.get(b)![i] - values.get(a)![i] || a.localeCompare(b))
      .slice(0, options.topN)
      .forEach((k) => keep.add(k));
  }
  const labelOf = (key: string): string => (options.dimension === 'tag' ? votes.label(key) : labels.get(key) ?? key);
  return {
    months,
    monthTotals,
    series: [...keep].map((key) => ({ key, label: labelOf(key), values: values.get(key)! })),
    missing,
    totalKeys: values.size
  };
}

/** 名寄せの辞典を画面で確かめる・直すための一覧 */
export interface DictionaryView {
  /** 利用者が辞典を編集しているか（false なら既定の辞典） */
  edited: boolean;
  groups: Array<{
    label: string;
    /** 既定の辞典にあるグループか */
    builtin: boolean;
    /** 台帳でこのグループに寄った作品の数（1 作品 1 件） */
    count: number;
    /** 代表名と別名。台帳に実際にある表記は、その件数を添える */
    members: Array<{ tag: string; count: number; seen: string[] }>;
  }>;
  /** 台帳にあるタグ（表記ごと。件数の多い順）。寄せる先の候補に使う */
  tags: Array<{ tag: string; count: number; group: string | null; kind: TagKind }>;
  /**
   * 寄せる候補。DMM にある属性のタグと DLsite にある属性のタグの組（少なくとも片方は片方のサイトにだけある）のうち、
   * 片方がもう片方を含む・区切りで分けた語が重なる・DMM の伏せ字（●）を埋めると同じになるもの。
   * 辞典はこの台帳を元に作ったので、ほかの利用者の台帳にしか無いタグはここから拾えるようにする
   */
  suggestions: Array<{ id: string; dmm: DictionarySide; dlsite: DictionarySide; reason: 'contains' | 'shares' | 'masked' }>;
}

export interface DictionarySide {
  /** 代表の表記（辞典のグループに入っていればその名前） */
  tag: string;
  count: number;
  /** 入っている辞典のグループ */
  group: string | null;
}

export function buildDictionaryView(rows: StatsRow[], overrides: TagRuleOverrides = EMPTY_TAG_OVERRIDES): DictionaryView {
  const dictionary = dictionaryOf(overrides);
  const blurbs = new Set(overrides.blurbs ?? []);
  const rawCounts = new Map<string, number>();
  const groupCounts = new Map<string, number>();
  for (const row of rows) {
    const groups = new Set<string>();
    for (const tag of new Set(row.tags)) {
      rawCounts.set(tag, (rawCounts.get(tag) ?? 0) + 1);
      const label = dictionary.alias.get(tagFoldKey(tag));
      if (label) groups.add(label);
    }
    for (const label of groups) groupCounts.set(label, (groupCounts.get(label) ?? 0) + 1);
  }
  // 畳んだ鍵ごとの、台帳にある表記と件数
  const byFold = new Map<string, Array<{ tag: string; count: number }>>();
  for (const [tag, count] of rawCounts) {
    const key = tagFoldKey(tag);
    byFold.set(key, [...(byFold.get(key) ?? []), { tag, count }]);
  }
  const memberOf = (tag: string): { tag: string; count: number; seen: string[] } => {
    const seen = byFold.get(tagFoldKey(tag)) ?? [];
    return { tag, count: seen.reduce((a, b) => a + b.count, 0), seen: seen.map((x) => x.tag) };
  };
  return {
    edited: overrides.groups !== null,
    suggestions: suggestMerges(rows, overrides, dictionary, blurbs),
    groups: Object.entries(dictionary.groups).map(([label, members]) => ({
      label,
      builtin: label in TAG_GROUPS,
      count: groupCounts.get(label) ?? 0,
      members: [label, ...members].map(memberOf)
    })),
    tags: [...rawCounts]
      .map(([tag, count]) => ({ tag, count, group: dictionary.alias.get(tagFoldKey(tag)) ?? null, kind: classifyTag(tag, blurbs) }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'ja'))
  };
}

/** 区切りで分けた語（畳んだ鍵を / で分けたもの） */
const partsOf = (fold: string): string[] => fold.split('/').filter((p) => p.length >= 2);

function suggestMerges(
  rows: StatsRow[],
  overrides: TagRuleOverrides,
  dictionary: TagDictionary,
  blurbs: ReadonlySet<string>,
  limit = 60
): DictionaryView['suggestions'] {
  // 名寄せの鍵ごとに、どのサイトにあるか・件数・代表の表記
  const keys = new Map<string, { sites: Set<string>; count: number; votes: Map<string, number>; group: string | null }>();
  for (const row of rows) {
    const seen = new Set<string>();
    for (const tag of row.tags) {
      if (classifyTagIn(tag, row, dictionary, blurbs) !== 'attribute') continue;
      const { key, label } = canonicalTag(tag, dictionary);
      if (overrides.exclude.includes(key)) continue;
      const k = keys.get(key) ?? { sites: new Set<string>(), count: 0, votes: new Map<string, number>(), group: label };
      k.sites.add(row.siteId);
      k.votes.set(tag, (k.votes.get(tag) ?? 0) + 1);
      if (!seen.has(key)) k.count++;
      seen.add(key);
      keys.set(key, k);
    }
  }
  const side = (k: { count: number; votes: Map<string, number>; group: string | null }): DictionarySide => ({
    tag: k.group ?? [...k.votes].sort((a, b) => b[1] - a[1])[0][0],
    count: k.count,
    group: k.group
  });
  // そのサイトにあるタグ。組の少なくとも片方は、片方のサイトにだけあるもの（両方にあるもの同士は、もう同じ名前で数えている）
  const on = (site: string): Array<DictionarySide & { folds: string[]; single: boolean; key: string }> =>
    [...keys]
      .filter(([, k]) => k.sites.has(site))
      .map(([key, k]) => ({
        ...side(k),
        key,
        single: k.sites.size === 1,
        // グループに入っているものは、伏せ字の別名（痴● など）はもう解決済みなので比べない（痴女 に当たってしまう）
        folds: [...new Set([...k.votes.keys(), ...(k.group ? [k.group] : [])].map(tagFoldKey))].filter(
          (fold) => !(k.group && fold.includes('●'))
        )
      }));
  const dmm = on('dmm');
  const dlsite = on('dlsite');
  const dismissed = new Set(overrides.dismissed ?? []);

  /**
   * 語どうしの関係。
   * - 伏せ字: ● を任意の 1 文字として同じになる
   * - 含む: 短いほうの後ろに 3 文字まで付いた形（断面図あり・学園もの・女主人公のみ）。
   *   前に付いたもの（白ギャル・逆アナル）は別の意味になりやすいので見ない。否定（〜ない・なし）も見ない
   */
  const near = (a: string, b: string): 'masked' | 'same' | 'contains' | null => {
    if (a === b) return 'same';
    const masked = (x: string, y: string): boolean =>
      x.includes('●') && new RegExp(`^${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/●/g, '.')}$`).test(y);
    if (masked(a, b) || masked(b, a)) return 'masked';
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    const rest = long.slice(short.length);
    if (short.length >= 2 && rest.length <= 3 && long.startsWith(short) && !/^(?:ない|なし|無し|以外)/.test(rest)) return 'contains';
    return null;
  };
  /** 全体どうし、または区切りで分けた語どうしで見る */
  const relation = (a: string, b: string): 'contains' | 'shares' | 'masked' | null => {
    const whole = near(a, b);
    if (whole === 'masked') return 'masked';
    if (whole === 'contains') return 'contains';
    const pa = partsOf(a);
    const pb = partsOf(b);
    if (pa.length < 2 && pb.length < 2) return null;
    for (const x of pa) {
      for (const y of pb) {
        const r = near(x, y);
        if (r === 'masked') return 'masked';
        if (r) return 'shares';
      }
    }
    return null;
  };

  const out: Array<DictionaryView['suggestions'][number] & { bothSingle: boolean }> = [];
  for (const a of dmm) {
    for (const b of dlsite) {
      if (a.key === b.key || (!a.single && !b.single)) continue;
      // 両方とも別々のグループに入っているものは、もう利用者か辞典が分けたもの
      if (a.group && b.group) continue;
      const id = `${a.key}|${b.key}`;
      if (dismissed.has(id)) continue;
      let reason: ReturnType<typeof relation> = null;
      for (const fa of a.folds) {
        for (const fb of b.folds) {
          reason = relation(fa, fb);
          if (reason) break;
        }
        if (reason) break;
      }
      if (reason) {
        out.push({
          id,
          dmm: { tag: a.tag, count: a.count, group: a.group },
          dlsite: { tag: b.tag, count: b.count, group: b.group },
          reason,
          bothSingle: a.single && b.single
        });
      }
    }
  }
  // 両方とも片方のサイトにだけある組（まだまとまっていない組）を先に。そのうえで件数の少ないほうが多い順
  return out
    .sort((x, y) => Number(y.bothSingle) - Number(x.bothSingle) || Math.min(y.dmm.count, y.dlsite.count) - Math.min(x.dmm.count, x.dlsite.count))
    .slice(0, limit)
    .map(({ bothSingle: _, ...rest }) => rest);
}
