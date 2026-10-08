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

try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 一時フォルダは OS が片付ける */ }
console.log(`OK ${passed}`);
