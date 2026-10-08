/**
 * 件数の移り変わりの書き出し（ffmpeg への受け渡し）を、本物の ffmpeg で確かめる。
 *   node tools/test-stats-export.mjs
 * ffmpeg はアプリと同じ探し方（設定の「ツール」で入れた場所・PATH・WinGet など）で見つける。
 * 見つからなければ飛ばす（SKIP と出す）。作るのは単色のコマだけで、作品のデータは使わない。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'simaeru-stats-export-'));
const build = (entry, name) => {
  const outfile = path.join(work, name);
  buildSync({ entryPoints: [path.join(root, entry)], outfile, bundle: true, platform: 'node', format: 'cjs',
    external: ['electron'], alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'error' });
  return require(outfile);
};
const { findFfmpeg } = build('src/main/tools/externalTools.ts', 'tools.cjs');
const { VideoExporter } = build('src/main/stats/videoExport.ts', 'export.cjs');

// アプリが設定の「ツール」で入れる場所も見る（読むだけ）
const appTools = process.env.APPDATA ? path.join(process.env.APPDATA, 'simaeru', 'tools') : undefined;
const ffmpeg = findFfmpeg(process.env.SIMAERU_TEST_FFMPEG ?? null, appTools);
if (!ffmpeg) {
  console.log('SKIP: ffmpeg が見つからないので書き出しの確認を飛ばしました');
  process.exit(0);
}
console.log(`ffmpeg: ${ffmpeg}`);

const exporter = new VideoExporter({ ffmpeg: () => ffmpeg, workDir: path.join(work, 'work') });
const W = 320, H = 180;
/** 赤 → 青に変わっていく単色のコマ */
const frame = (i, n) => {
  const buf = new Uint8Array(W * H * 4);
  for (let p = 0; p < W * H; p++) buf.set([Math.round(255 * (1 - i / n)), 40, Math.round(255 * (i / n)), 255], p * 4);
  return buf;
};
const head = (file, n) => fs.readFileSync(file).subarray(0, n);
const signatures = {
  mp4: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
  gif: (b) => b.subarray(0, 6).toString('latin1') === 'GIF89a',
  webm: (b) => b.readUInt32BE(0) === 0x1a45dfa3,
  webp: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'
};

let passed = 0;
try {
  for (const format of ['mp4', 'gif', 'webm', 'webp']) {
    const dest = path.join(work, 'out', `移り変わり.${format}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const id = exporter.begin({ format, width: W, height: H, fps: 10 }, dest);
    for (let i = 0; i < 12; i++) await exporter.frame(id, frame(i, 12));
    assert.equal(await exporter.end(id), dest);
    assert(fs.statSync(dest).size > 100, `${format} が小さすぎる`);
    assert(signatures[format](head(dest, 16)), `${format} の形になっていない`);
    console.log(`PASS ${format}: ${fs.statSync(dest).size} バイト`);
    passed++;
  }
  // 作業フォルダは片付いている
  assert.deepEqual(fs.readdirSync(path.join(work, 'work')), []);

  // 大きさの違うコマは受け取らない。取り消すと作業フォルダも消える
  const id = exporter.begin({ format: 'mp4', width: W, height: H, fps: 10 }, path.join(work, 'out', 'x.mp4'));
  await assert.rejects(exporter.frame(id, new Uint8Array(10)), /大きさ|size/);
  exporter.cancel(id);
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(fs.readdirSync(path.join(work, 'work')), []);
  assert(!fs.existsSync(path.join(work, 'out', 'x.mp4')));
  await assert.rejects(exporter.end(id), /取り消|cancel/i);
  console.log('PASS 大きさの違うコマを断り、取り消すと作業フォルダも残さない');
  passed++;

  // 縦長も書き出せる。4K の画素数を超える大きさは断る
  const portrait = exporter.begin({ format: 'mp4', width: 180, height: 320, fps: 10 }, path.join(work, 'out', 'portrait.mp4'));
  for (let i = 0; i < 5; i++) await exporter.frame(portrait, new Uint8Array(180 * 320 * 4));
  await exporter.end(portrait);
  assert(signatures.mp4(head(path.join(work, 'out', 'portrait.mp4'), 16)));
  assert.throws(() => exporter.begin({ format: 'mp4', width: 3840, height: 3840, fps: 10 }, path.join(work, 'out', 'big.mp4')), /大きすぎ|Too large/);
  console.log('PASS 縦長（180×320）を書き出し、4K を超える大きさは断る');
  passed++;

  // 奇数の大きさは偶数にそろえる（H.264 の都合）
  const odd = exporter.begin({ format: 'mp4', width: 321, height: 181, fps: 10 }, path.join(work, 'out', 'odd.mp4'));
  await exporter.frame(odd, new Uint8Array(322 * 182 * 4));
  await exporter.end(odd);
  console.log('PASS 奇数の大きさは偶数にそろえる');
  passed++;
} finally {
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 一時フォルダは OS が片付ける */ }
}
console.log(`OK ${passed}`);
