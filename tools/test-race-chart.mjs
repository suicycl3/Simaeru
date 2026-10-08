/**
 * 件数の移り変わり（バーチャートレース）の時間割とコマの計算を確かめる。
 *   node tools/test-race-chart.mjs
 * 描画（Canvas）は UI テストで見る。ここでは「時刻 → 棒の並び」の純関数だけ。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'simaeru-race-'));
const outfile = path.join(work, 'race.cjs');
buildSync({
  entryPoints: [path.join(root, 'src/renderer/src/lib/raceChart.ts')], outfile, bundle: true, platform: 'node', format: 'cjs',
  alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'error'
});
const r = require(outfile);
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
const close = (a, b) => Math.abs(a - b) < 1e-9;

test('時間割: どの月も同じ長さ / 購入の多い月ほど長く（全体の長さは同じ）', () => {
  const even = r.buildTimeline([0, 10, 0, 30], 0.5, 'even', 2);
  assert.deepEqual(even.lengths, [0.5, 0.5, 0.5, 0.5]);
  assert.deepEqual(even.starts, [0, 0.5, 1, 1.5]);
  assert.equal(even.duration, 4);
  const volume = r.buildTimeline([0, 10, 0, 30], 0.5, 'volume', 2);
  assert(close(volume.lengths.reduce((a, b) => a + b, 0), 2));
  assert(volume.lengths[3] > volume.lengths[1] && volume.lengths[1] > volume.lengths[0]);
  assert.equal(volume.lengths[0], volume.lengths[2]); // 買っていない月は短いがゼロにはしない
  assert(volume.lengths[0] > 0);
  assert.equal(r.buildTimeline([], 1, 'even').duration, 0);
});

const data = {
  months: ['2024-01', '2024-02', '2024-03'],
  monthTotals: [3, 2, 4],
  series: [
    { key: 'a', label: 'A', values: [3, 3, 3] },
    { key: 'b', label: 'B', values: [1, 2, 6] },
    { key: 'c', label: 'C', values: [0, 1, 1] }
  ]
};
const timeline = r.buildTimeline(data.monthTotals, 1, 'even', 2);

test('コマ: 月の頭は値そのまま、月の途中は補間、順位の入れ替わりは滑らか', () => {
  const start = r.raceFrameAt(data, timeline, 0, 2);
  assert.equal(start.month, '2024-01');
  assert.deepEqual(start.bars.map((b) => [b.label, b.value, b.position]), [['A', 3, 0], ['B', 1, 1]]); // 0 件の C は出さない
  assert.equal(start.purchased, 3);
  const mid = r.raceFrameAt(data, timeline, 1.5, 2); // 2 月の半ば: B が 2 → 6 の途中で A を抜きつつある
  assert.equal(mid.month, '2024-02');
  const b = mid.bars.find((x) => x.label === 'B');
  assert.equal(b.value, 4);
  assert(b.position > 0 && b.position < 1, `入れ替わりの途中: ${b.position}`);
  // 上位 2 本の外（C）は出さないか、出ていても薄い
  for (const bar of mid.bars) assert(bar.position <= 2 && bar.opacity <= 1);
});

test('コマ: 最後の月を過ぎたら止まる・データが無ければ null', () => {
  const end = r.raceFrameAt(data, timeline, 99, 3);
  assert.equal(end.month, '2024-03');
  assert.deepEqual(end.bars.map((x) => [x.label, x.value]), [['B', 6], ['A', 3], ['C', 1]]);
  assert.equal(end.purchased, 9);
  assert.equal(r.raceFrameAt({ months: [], monthTotals: [], series: [] }, r.buildTimeline([], 1, 'even'), 0, 5), null);
});

test('色は系列ごとに決まり、隣り合う系列は違う色', () => {
  const frame = r.raceFrameAt(data, timeline, 99, 3);
  const colors = Object.fromEntries(frame.bars.map((b) => [b.label, b.color]));
  assert.equal(colors.A, r.seriesColor(0));
  assert.equal(colors.B, r.seriesColor(1));
  assert.equal(new Set(Array.from({ length: 20 }, (_, i) => r.seriesColor(i))).size, 20);
});

test('順位の範囲: 途中の順位から出し、範囲の端は薄くする', () => {
  // 3 月の終わり: B 6, A 3, C 1 の順
  const end = r.raceFrameAt(data, timeline, 99, 3, 2); // 2〜3 位
  const shown = Object.fromEntries(end.bars.map((b) => [b.label, [b.position, b.rank, b.opacity]]));
  assert.deepEqual(shown.A, [0, 2, 1]); // 2 位が範囲の一番上
  assert.deepEqual(shown.C, [1, 3, 1]);
  assert(!shown.B || shown.B[2] === 0); // 範囲の上の外（1 位）は見えない
  assert.equal(end.max, 3); // 棒の長さの基準は範囲の中の棒
});

test('上位 100 位: 100 本まで出せる', () => {
  const months = ['2024-01', '2024-02'];
  const many = {
    months,
    monthTotals: [100, 100],
    series: Array.from({ length: 120 }, (_, k) => ({ key: `k${k}`, label: `L${k}`, values: [120 - k, 240 - 2 * k] })),
    missing: { total: 0, recent: 0 }
  };
  const frame = r.raceFrameAt(many, r.buildTimeline(many.monthTotals, 1, 'even'), 99, 100);
  assert.equal(frame.bars.filter((b) => b.opacity === 1).length, 100);
  assert.equal(frame.bars.at(-1).rank <= 101, true);
});

test('描画: 縦長でもタイトルを幅に収め、細すぎる行では名前を省く', () => {
  const calls = [];
  const ctx = {
    fillStyle: '', font: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    fillRect: () => {},
    fillText: (text, x) => calls.push({ text, x, font: ctx.font }),
    // 1 文字 = 文字の大きさ（px）の幅として測る
    measureText: (text) => ({ width: [...text].length * Number(/(\d+)px/.exec(ctx.font)[1]) })
  };
  const frame = r.raceFrameAt(data, timeline, 99, 3);
  const style = (rankFrom, rankTo) => ({ title: 'とても長いタイトル'.repeat(10), formatMonth: (m) => m, formatPurchased: (n) => `${n}`, rankFrom, rankTo });
  // 縦長 1080×1920: タイトルは幅（1080 - 余白）に収まる
  r.drawRace(ctx, 1080, 1920, frame, style(1, 3));
  const title = calls.find((c) => c.text.startsWith('とても'));
  const titlePx = Number(/(\d+)px/.exec(title.font)[1]); // 短い辺（1080）が基準: 30 × 1.5 = 45px
  assert.equal(titlePx, 45);
  assert([...title.text].length * titlePx <= 1080 - 80 * 1.5, 'タイトルは幅に収まる');
  assert(title.text.endsWith('…'), '長いタイトルは末尾を … にする');
  assert(calls.some((c) => c.text === 'B'), '名前を描く');
  // 640×360 に 100 行: 行が細すぎるので名前・件数は描かない（タイトルと年月・購入数だけ）
  calls.length = 0;
  r.drawRace(ctx, 640, 360, frame, style(1, 100));
  assert(!calls.some((c) => ['A', 'B', 'C'].includes(c.text)), JSON.stringify(calls.map((c) => c.text)));
  // 途中の順位から出すときは、順位の数字を添える
  calls.length = 0;
  r.drawRace(ctx, 1280, 720, r.raceFrameAt(data, timeline, 99, 3, 2), style(2, 3));
  assert(calls.some((c) => c.text === '2') && calls.some((c) => c.text === '3'));
});

test('段組み: 横長は行が細くなりすぎるときに列を増やし、縦長は 1 列。手で選んだ数はそのとおり', () => {
  assert.equal(r.raceColumns(1280, 720, 10, 'auto'), 1); // 10 行なら 1 列で足りる
  assert(r.raceColumns(1280, 720, 100, 'auto') >= 2, '横長で 100 行なら 2 列以上');
  assert(r.raceColumns(1920, 1080, 100, 'auto') >= 2);
  assert.equal(r.raceColumns(1080, 1920, 100, 'auto'), 1); // 縦長は 1 列
  assert.equal(r.raceColumns(1280, 720, 100, 2), 2); // 指定どおり
  assert.equal(r.raceColumns(1920, 1080, 100, 4), 4); // 手で選んだ数は、自動の上限（1 列の最小の幅）より多くてもそのとおり
  assert.equal(r.raceColumns(640, 360, 100, 6), 6);
  assert(r.raceColumns(1920, 1080, 100, 'auto') <= 3); // 自動は 1 列の最小の幅を守る
  assert.equal(r.raceColumns(1280, 720, 2, 3), 2); // 行より多くはしない
});

test('描画: 段組み・順位の表示・年月は上の帯（棒の欄と重ねない）', () => {
  const texts = [];
  const rects = [];
  const ctx = {
    fillStyle: '', font: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    fillRect: (x, y, w, h) => rects.push({ x, y, w, h }),
    fillText: (text, x, y) => texts.push({ text: String(text), x, y }),
    measureText: (text) => ({ width: [...text].length * Number(/(\d+)px/.exec(ctx.font)[1]) })
  };
  const months = ['2024-01'];
  const many = {
    months,
    monthTotals: [100],
    series: Array.from({ length: 100 }, (_, k) => ({ key: `k${k}`, label: `L${k}`, values: [200 - k] })),
    missing: { total: 0, recent: 0 },
    totalKeys: 100
  };
  const frame = r.raceFrameAt(many, r.buildTimeline([100], 1, 'even'), 0, 100);
  const style = { title: 'T', formatMonth: () => '2024年1月', formatPurchased: (n) => `購入 ${n} 件`, rankFrom: 1, rankTo: 100, showRank: true, columns: 'auto' };
  r.drawRace(ctx, 1920, 1080, frame, style);
  const bars = rects.slice(1); // 先頭は背景
  const lefts = [...new Set(bars.map((b) => Math.round(b.x)))];
  assert(lefts.length >= 2, `2 列以上に分ける: ${lefts}`);
  // 順位の数字が出る（1 位と 100 位）
  assert(texts.some((x) => x.text === '1') && texts.some((x) => x.text === '100'));
  // 年月・購入数は上の帯にあり、棒はその下から
  const month = texts.find((x) => x.text === '2024年1月');
  const header = Math.min(...bars.map((b) => b.y));
  assert(month.y < header && texts.find((x) => x.text.startsWith('購入')).y < header);
  // 縦長 1080×1920 に 100 行: 1 列で、一番下の行も画面の中に収まる
  rects.length = 0;
  texts.length = 0;
  r.drawRace(ctx, 1080, 1920, frame, style);
  const tall = rects.slice(1);
  assert.equal(new Set(tall.map((b) => Math.round(b.x))).size, 1);
  assert(Math.max(...tall.map((b) => b.y + b.h)) <= 1920);
  assert(texts.some((x) => x.text === 'L99'), '100 位の名前も描く');
});

try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 一時フォルダは OS が片付ける */ }
console.log(`OK ${passed}`);
