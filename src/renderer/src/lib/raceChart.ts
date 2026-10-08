/**
 * 件数の移り変わりを、バーチャートレース（棒が伸びて順位が入れ替わる）として描く。
 * プレビューも書き出しも同じ関数を使う。「時刻 → その瞬間の絵」の純関数なので、
 * 書き出しは 1 コマずつ描いて ffmpeg に渡すだけでよい（実時間で録画しない）。
 */
import type { RaceData } from '@shared/purchaseStats';

export type RacePacing = 'even' | 'volume';

export interface Timeline {
  /** 各月が始まる時刻（秒） */
  starts: number[];
  /** 各月の長さ（秒） */
  lengths: number[];
  /** 最後の月を止めて見せる時間を含めた全体の長さ（秒） */
  duration: number;
}

/**
 * 月ごとの時間割。
 * - even: どの月も secondsPerMonth
 * - volume: 購入の多い月ほど長く（買っていない月が続く時期を短くする）。全体の長さは even と同じ
 */
export function buildTimeline(monthTotals: number[], secondsPerMonth: number, pacing: RacePacing, holdSeconds = 2): Timeline {
  const n = monthTotals.length;
  if (n === 0) return { starts: [], lengths: [], duration: 0 };
  let weights = new Array<number>(n).fill(1);
  if (pacing === 'volume') {
    const mean = monthTotals.reduce((a, b) => a + b, 0) / n || 1;
    weights = monthTotals.map((c) => Math.min(3, Math.max(0.25, c / mean)));
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  const lengths = weights.map((w) => (w / sum) * secondsPerMonth * n);
  const starts: number[] = [];
  let at = 0;
  for (const len of lengths) {
    starts.push(at);
    at += len;
  }
  return { starts, lengths, duration: at + holdSeconds };
}

export interface RaceBar {
  key: string;
  label: string;
  value: number;
  /** 表示上の位置（0 が表示する範囲の一番上）。月の境目のあいだは小数で、入れ替わりが滑らかに動く */
  position: number;
  /** 順位（1 が一位）。月の境目のあいだは近いほう */
  rank: number;
  /** 0〜1。表示する範囲の上下の端から出入りするときに薄くする */
  opacity: number;
  /** 色（系列ごとに決まる） */
  color: string;
}

export interface RaceFrame {
  monthIndex: number;
  month: string;
  /** その月までに買った件数（期間の始めから） */
  purchased: number;
  bars: RaceBar[];
  max: number;
}

function sortedKeysAt(data: RaceData, i: number): string[] {
  return data.series
    .map((s) => ({ key: s.key, v: s.values[i] }))
    .sort((a, b) => b.v - a.v || a.key.localeCompare(b.key))
    .map((s) => s.key);
}

/**
 * 時刻 t（秒）のコマ。rankFrom 位から rankTo 位までを出す（既定は 1 位から）。
 * 範囲の外の順位の棒も、上下の端の 1 行ぶんは出入りが見えるよう薄くして残す
 */
export function raceFrameAt(data: RaceData, timeline: Timeline, t: number, rankTo: number, rankFrom = 1): RaceFrame | null {
  const n = data.months.length;
  if (n === 0) return null;
  // どの月のどのあたりか（最後の月を過ぎたら止める）
  let i = 0;
  while (i + 1 < n && timeline.starts[i + 1] <= t) i++;
  const frac = i + 1 < n ? Math.min(1, Math.max(0, (t - timeline.starts[i]) / timeline.lengths[i])) : 0;
  const next = Math.min(n - 1, i + 1);
  const ease = frac * frac * (3 - 2 * frac);

  const rankNow = new Map(sortedKeysAt(data, i).map((k, r) => [k, r]));
  const rankNext = new Map(sortedKeysAt(data, next).map((k, r) => [k, r]));
  const bars: RaceBar[] = [];
  const offset = Math.max(0, Math.round(rankFrom) - 1);
  const rows = Math.max(1, Math.round(rankTo) - offset);
  for (const [index, s] of data.series.entries()) {
    const value = s.values[i] + (s.values[next] - s.values[i]) * frac;
    if (value <= 0) continue;
    const rank = (rankNow.get(s.key) ?? n) * (1 - ease) + (rankNext.get(s.key) ?? n) * ease;
    const position = rank - offset;
    if (position <= -1 || position > rows) continue;
    const opacity = Math.max(0, Math.min(1, rows - position, position + 1));
    bars.push({ key: s.key, label: s.label, value, position, rank: Math.round(rank) + 1, opacity, color: seriesColor(index) });
  }
  bars.sort((a, b) => a.position - b.position);
  let purchased = 0;
  for (let m = 0; m <= i; m++) purchased += data.monthTotals[m];
  purchased += Math.round(data.monthTotals[next] * frac * (next > i ? 1 : 0));
  // 棒の長さの基準は、範囲の中に見えている棒の一番長いもの
  const inside = bars.filter((b) => b.position >= -0.5 && b.position < rows);
  return { monthIndex: i, month: data.months[i], purchased, bars, max: Math.max(1, ...(inside.length ? inside : bars).map((b) => b.value)) };
}

export interface RaceStyle {
  title: string;
  /** 右下の大きな年月の書き方 */
  formatMonth: (month: string) => string;
  /** 「購入 123 件」のような添え書き */
  formatPurchased: (count: number) => string;
  /** 出す順位の範囲（rankFrom 位〜rankTo 位） */
  rankFrom: number;
  rankTo: number;
  /** 棒の左に順位の数字を出す（途中の順位から出すときは、これに関係なく出す） */
  showRank?: boolean;
  /** 段組み（列の数）。'auto' は横長・正方形で行が細くなりすぎるときに増やす。省略は 1 列 */
  columns?: number | 'auto';
}

/** 自動の段組みで目指す行の高さ（短い辺 720px あたり） */
const AUTO_ROW_HEIGHT = 30;
/** 1 列の最小の幅（短い辺 720px あたり） */
const MIN_COLUMN_WIDTH = 360;

/** 段組みの列の数を決める。自動は 1 列の最小の幅（MIN_COLUMN_WIDTH）を守る */
export function raceColumns(width: number, height: number, rows: number, columns: number | 'auto' = 1): number {
  const u = Math.min(width, height) / 720;
  // 手で選んだ数は、そのとおりに分ける（細くなれば名前は … で省く）。本数より多くはしない
  if (columns !== 'auto') return Math.max(1, Math.min(Math.round(columns), rows));
  // 縦長は 1 列（縦に長いので、行の高さが足りる）
  if (width < height) return 1;
  const maxByWidth = Math.max(1, Math.floor((width - 80 * u) / (MIN_COLUMN_WIDTH * u)));
  const area = height - headerHeight(u, false) - 24 * u;
  const perColumn = Math.max(1, Math.floor(area / (AUTO_ROW_HEIGHT * u)));
  return Math.max(1, Math.min(maxByWidth, Math.ceil(rows / perColumn), rows));
}

/** 上の帯（タイトル・年月・購入数）の高さ。棒の欄はこの下から。縦長はタイトルと年月を 2 行に分けるので高い */
const headerHeight = (u: number, portrait: boolean): number => (portrait ? 150 : 112) * u;

const FONT = "'Yu Gothic UI', 'Meiryo', 'Noto Sans JP', sans-serif";

/** 見分けやすい色の並び（暗い背景で読める明るさにそろえる） */
const PALETTE = [
  '#4e9be6', '#f28e2b', '#59c46a', '#e15759', '#b07aa1', '#edc948', '#76b7b2', '#ff9da7', '#e0b36a', '#a0cbe8',
  '#ffbe7d', '#8cd17d', '#d4a6c8', '#86bcb6', '#f1ce63', '#d37295', '#5fd3f3', '#c6e377', '#ff7f50', '#9d8df1'
];

/** 系列の色。系列は元データの順（上位に入った順）なので、同じ条件ならいつも同じ色になる */
export function seriesColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** 名前を出す最小の文字の大きさ（px）。これより細い行では棒だけを描く */
const MIN_LABEL_PX = 7;

/**
 * 1 コマを描く。大きさは canvas に合わせ、文字や余白は短い辺を基準に縮める（縦長・正方形でもはみ出さない）。
 * - 上の帯: 左にタイトルと購入数、右に大きな年月。棒の欄とは重ねない（下位の行が隠れないように）
 * - 棒の欄: 段組み（列）に分け、順位は列の上から下へ、左の列から右の列へ並べる。棒の長さの基準は全部の列で同じ
 * - 本数が多くて行が細いときは、棒と文字を行の高さに合わせて縮め、読めないほど細ければ名前と件数を省く
 */
export function drawRace(ctx: Ctx, width: number, height: number, frame: RaceFrame | null, style: RaceStyle): void {
  const u = Math.min(width, height) / 720;
  ctx.fillStyle = '#16181d';
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'middle';

  // 横長: 1 行目の左にタイトル、右に大きな年月、2 行目に購入数（タイトルは年月の手前で切る）。
  // 縦長: 幅が足りないので、1 行目にタイトルを全幅で、2 行目の右に年月・左に購入数
  const portrait = width < height;
  const monthY = portrait ? 108 * u : 56 * u;
  let monthW = 0;
  if (frame) {
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(242, 243, 245, 0.9)';
    ctx.font = `700 ${Math.round(56 * u)}px ${FONT}`;
    const month = style.formatMonth(frame.month);
    monthW = ctx.measureText(month).width;
    ctx.fillText(month, width - 40 * u, monthY);
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = '#f2f3f5';
  ctx.font = `600 ${Math.round(30 * u)}px ${FONT}`;
  ctx.fillText(fit(ctx, style.title, width - 80 * u - (monthW && !portrait ? monthW + 24 * u : 0)), 40 * u, 40 * u);
  if (!frame) return;
  ctx.fillStyle = 'rgba(242, 243, 245, 0.6)';
  ctx.font = `${Math.round(20 * u)}px ${FONT}`;
  ctx.fillText(fit(ctx, style.formatPurchased(frame.purchased), width - 80 * u - (portrait ? monthW + 24 * u : 0)), 40 * u, portrait ? 114 * u : 82 * u);

  const rows = Math.max(1, Math.round(style.rankTo) - Math.max(0, Math.round(style.rankFrom) - 1));
  const columns = raceColumns(width, height, rows, style.columns ?? 1);
  const perColumn = Math.ceil(rows / columns);
  const gap = 32 * u;
  const columnW = (width - 80 * u - gap * (columns - 1)) / columns;
  const top = headerHeight(u, portrait);
  const bottom = height - 24 * u;
  const rowH = (bottom - top) / perColumn;
  const barH = rowH * 0.78;
  const labelPx = Math.min(20 * u, rowH * 0.62);
  const showText = labelPx >= MIN_LABEL_PX;
  const showRank = showText && (!!style.showRank || style.rankFrom > 1);
  const rankW = showRank ? labelPx * 2.4 : 0;
  const labelW = showText ? Math.min(columnW * 0.38, 340 * u) : 0;
  // 件数の文字の場所を棒の先に空けておく
  const valueW = showText ? labelPx * 4 : 0;
  const barMax = Math.max(1, columnW - rankW - labelW - valueW);
  const scale = barMax / frame.max;

  for (const bar of frame.bars) {
    // 列をまたぐ入れ替わりは、行き先の列へ移る（列の切れ目で途切れないよう、端の 1 行ぶんは前の列にはみ出してよい）
    const column = Math.min(columns - 1, Math.max(0, Math.floor(bar.position / perColumn)));
    const row = bar.position - column * perColumn;
    const x0 = 40 * u + column * (columnW + gap);
    const y = top + row * rowH;
    const left = x0 + rankW + labelW;
    ctx.globalAlpha = bar.opacity;
    ctx.fillStyle = bar.color;
    const w = Math.max(Math.min(2 * u, barH), bar.value * scale);
    ctx.fillRect(left, y, w, barH);
    if (!showText) continue;
    ctx.fillStyle = '#e8e9ec';
    if (showRank) {
      ctx.textAlign = 'left';
      ctx.font = `600 ${Math.round(labelPx * 0.9)}px ${FONT}`;
      ctx.fillText(String(bar.rank), x0, y + barH / 2);
    }
    // 名前（左）
    ctx.font = `${Math.round(labelPx)}px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(fit(ctx, bar.label, labelW - 12 * u), left - 10 * u, y + barH / 2);
    // 件数（棒の先）
    ctx.textAlign = 'left';
    ctx.font = `600 ${Math.round(labelPx * 0.95)}px ${FONT}`;
    ctx.fillText(String(Math.round(bar.value)), left + w + 8 * u, y + barH / 2);
  }
  ctx.globalAlpha = 1;
}

/** 入りきらない名前は末尾を … にする */
function fit(ctx: Ctx, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return `${s}…`;
}
