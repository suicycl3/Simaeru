/**
 * 取り込みの走査（フォルダごとのまとめ・索引の使い回し）の検証。
 *   node tools/test-import-scan.mjs
 *
 * 実ファイルを読むので一時フォルダに木を作る。台帳（Repo）は偽物を渡し、書き込みは記録するだけ。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const root = path.join(import.meta.dirname, '..');
const outFile = path.join(os.tmpdir(), 'importScan.test.cjs');
esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'main', 'import', 'scanner.ts')],
  alias: { '@shared': path.join(root, 'src', 'shared') },
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'error'
});
const { scanFolders } = require(outFile);

const matchFile = path.join(os.tmpdir(), 'importScanMatch.test.cjs');
esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'main', 'import', 'matcher.ts')],
  alias: { '@shared': path.join(root, 'src', 'shared') },
  outfile: matchFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'error'
});
const { buildMatchIndex, matchFile: match } = require(matchFile);

const failures = [];
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  console.log(`${ok ? '  ok ' : '  NG '} ${label}${ok ? '' : `\n        期待 ${e}\n        実際 ${a}`}`);
  if (!ok) failures.push(label);
};
const ok = (label, cond, note) => {
  console.log(`${cond ? '  ok ' : '  NG '} ${label}${cond ? '' : `  ${note ?? ''}`}`);
  if (!cond) failures.push(label);
};

const products = [
  { id: 1, productId: 'RJ01000002', contentId: 'RJ01000002', title: 'まじめ後輩ちゃんとひみつの図書室', siteId: 'dlsite', category: 'doujin' },
  { id: 2, productId: 'd_100004', contentId: 'd_100004', title: 'おてんばお嬢様がひみつのレッスンでわんつー', siteId: 'dmm', category: 'doujin' },
  { id: 3, productId: 'VJ000001', contentId: 'VJ000001', title: 'ひだまりの向こうがわ', siteId: 'dlsite', category: 'game' },
  { id: 4, productId: 'VJ000002', contentId: 'VJ000002', title: 'ひだまりの向こうがわ 完全版', siteId: 'dlsite', category: 'game' }
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mylib-scan-'));
const write = (rel, size = 16) => {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(size));
  return full;
};

// 同じフォルダに分割書庫と付属ファイル（まとめて1件になるはず）
write('本棚/まじめ後輩ちゃんとひみつの図書室/disc.part1.zip', 100);
write('本棚/まじめ後輩ちゃんとひみつの図書室/disc.part2.zip', 200);
write('本棚/まじめ後輩ちゃんとひみつの図書室/readme.txt', 10);
// 同じフォルダだが別の作品を指すファイル（分けたままのはず）
write('まとめ/ひだまりの向こうがわ.zip', 50);
write('まとめ/まじめ後輩ちゃんとひみつの図書室.zip', 60);
// ゲーム同梱のランタイム（走査に出てこないはず）
write('本棚/まじめ後輩ちゃんとひみつの図書室/DirectX/directx_Jun2010_redist.exe', 40);
write('本棚/まじめ後輩ちゃんとひみつの図書室/dxwebsetup.exe', 20);
// 作品IDが1件だけ一致（自動で紐付くはず）
write('ゲーム/VJ000002/setup.exe', 30);

let productsRead = 0;
const added = [];
const repo = {
  allProductsForMatching: () => { productsRead++; return products; },
  knownLocalPaths: () => new Set(),
  allLocalFiles: () => [],
  addLocalFile: (row) => added.push(row)
};

const result = await scanFolders(repo, [path.join(tmp, '本棚'), path.join(tmp, 'まとめ'), path.join(tmp, 'ゲーム')], () => {});

console.log('== 走査の結果 ==');
check('走査したファイル数（同梱ランタイムは数えない）', result.scanned, 6);
check('作品IDで自動確定', [result.linked, added.map((a) => a.productRef)], [1, [4]]);

console.log('\n== フォルダごとのまとめ ==');
const byLabel = Object.fromEntries(result.pending.map((g) => [`${g.label}#${g.candidates.map((c) => c.productId).join('/')}`, g]));
const bundle = result.pending.find((g) => g.label === 'まじめ後輩ちゃんとひみつの図書室');
ok('同じフォルダ・同じ候補は1件にまとまる', bundle && bundle.files.length === 3, JSON.stringify(bundle?.files));
check('まとめた合計バイト数', bundle?.sizeBytes, 310);
check('候補はまとまりに1組だけ', bundle?.candidates.map((c) => c.productId), [1]);
ok('候補が無いファイル（readme）もフォルダの読みに合流する',
  bundle?.files.some((f) => f.path.endsWith('readme.txt')), JSON.stringify(bundle?.files));

const mixed = result.pending.filter((g) => g.label === 'まとめ');
check('候補が食い違うファイルは分けたまま', mixed.map((g) => g.candidates.map((c) => c.productId).sort()), [[3, 4], [1]]);
ok('分けた行はそれぞれ1ファイル', mixed.every((g) => g.files.length === 1));
ok('同じフォルダでも行の鍵は重ならない', Object.keys(byLabel).length === result.pending.length);

ok('DirectX のフォルダは候補に出ない',
  !result.pending.some((g) => g.dir.includes('DirectX') || g.files.some((f) => /directx|dxwebsetup/i.test(f.path))),
  JSON.stringify(result.pending.map((g) => g.files.map((f) => f.path))));

console.log('\n== 作品リストの読み直し ==');
check('フォルダが3つでも作品リストは1回だけ読む', productsRead, 1);

console.log('\n== 索引の使い回し ==');
const many = [];
for (let i = 0; i < 2000; i++) {
  many.push({ id: 100 + i, productId: `d_${200000 + i}`, contentId: null, title: `テスト作品 第${i}話 ながいタイトルの見本`, siteId: 'dmm', category: 'doujin' });
}
const names = [];
for (let i = 0; i < 200; i++) names.push([`sample_${i}.zip`, `フォルダ${i}`, '手元']);
const index = buildMatchIndex(many);
const t0 = process.hrtime.bigint();
for (const parts of names) match(parts, index);
const withIndex = Number(process.hrtime.bigint() - t0) / 1e6;
const t1 = process.hrtime.bigint();
for (const parts of names) match(parts, many);
const withoutIndex = Number(process.hrtime.bigint() - t1) / 1e6;
ok(`索引を使い回すと速い（索引 ${withIndex.toFixed(0)}ms / 毎回作り直し ${withoutIndex.toFixed(0)}ms）`,
  withIndex * 5 < withoutIndex);

const cached = match(['sample_0.zip', 'フォルダ0', '手元'], index);
ok('同じ名前の並びは記憶から返る', match(['sample_0.zip', 'フォルダ0', '手元'], index) === cached);

fs.rmSync(tmp, { recursive: true, force: true });

if (failures.length) {
  console.error(`\nNG: ${failures.length} 件失敗 (${failures.join(' / ')})`);
  process.exit(1);
}
console.log('\nOK');
