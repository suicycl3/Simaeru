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
  /** 表示上の順位（0 が一番上）。月の境目のあいだは小数で、入れ替わりが滑らかに動く */
  position: number;
  /** 0〜1。上位から外れていくときに薄くする */
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

/** 時刻 t（秒）のコマ */
export function raceFrameAt(data: RaceData, timeline: Timeline, t: number, topN: number): RaceFrame | null {
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
  for (const [index, s] of data.series.entries()) {
    const value = s.values[i] + (s.values[next] - s.values[i]) * frac;
    if (value <= 0) continue;
    const position = (rankNow.get(s.key) ?? n) * (1 - ease) + (rankNext.get(s.key) ?? n) * ease;
    if (position > topN) continue;
    bars.push({ key: s.key, label: s.label, value, position, opacity: Math.max(0, Math.min(1, topN - position)), color: seriesColor(index) });
  }
  bars.sort((a, b) => a.position - b.position);
  let purchased = 0;
  for (let m = 0; m <= i; m++) purchased += data.monthTotals[m];
  purchased += Math.round(data.monthTotals[next] * frac * (next > i ? 1 : 0));
  return { monthIndex: i, month: data.months[i], purchased, bars, max: Math.max(1, ...bars.map((b) => b.value)) };
}

export interface RaceStyle {
  title: string;
  /** 右下の大きな年月の書き方 */
  formatMonth: (month: string) => string;
  /** 「購入 123 件」のような添え書き */
  formatPurchased: (count: number) => string;
  topN: number;
}

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

/** 1 コマを描く。大きさは canvas に合わせ、文字や余白は高さを基準に縮める */
export function drawRace(ctx: Ctx, width: number, height: number, frame: RaceFrame | null, style: RaceStyle): void {
  const u = height / 720;
  ctx.fillStyle = '#16181d';
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'middle';

  ctx.fillStyle = '#f2f3f5';
  ctx.font = `600 ${Math.round(30 * u)}px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(style.title, 40 * u, 44 * u);
  if (!frame) return;

  const top = 92 * u;
  const bottom = height - 40 * u;
  const rowH = (bottom - top) / style.topN;
  const barH = rowH * 0.78;
  const labelW = Math.min(width * 0.32, 340 * u);
  const left = 40 * u + labelW;
  const right = width - 120 * u;
  const scale = (right - left) / frame.max;

  for (const bar of frame.bars) {
    const y = top + bar.position * rowH;
    ctx.globalAlpha = bar.opacity;
    ctx.fillStyle = bar.color;
    const w = Math.max(2 * u, bar.value * scale);
    ctx.fillRect(left, y, w, barH);
    // 名前（左）
    ctx.fillStyle = '#e8e9ec';
    ctx.font = `${Math.round(20 * u)}px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(fit(ctx, bar.label, labelW - 14 * u), left - 12 * u, y + barH / 2);
    // 件数（棒の先）
    ctx.textAlign = 'left';
    ctx.font = `600 ${Math.round(19 * u)}px ${FONT}`;
    ctx.fillText(String(Math.round(bar.value)), left + w + 10 * u, y + barH / 2);
  }
  ctx.globalAlpha = 1;

  // 右下の年月と、そこまでの購入数
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(242, 243, 245, 0.85)';
  ctx.font = `700 ${Math.round(64 * u)}px ${FONT}`;
  ctx.fillText(style.formatMonth(frame.month), width - 40 * u, bottom - 70 * u);
  ctx.fillStyle = 'rgba(242, 243, 245, 0.6)';
  ctx.font = `${Math.round(22 * u)}px ${FONT}`;
  ctx.fillText(style.formatPurchased(frame.purchased), width - 40 * u, bottom - 22 * u);
}

/** 入りきらない名前は末尾を … にする */
function fit(ctx: Ctx, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return `${s}…`;
}
