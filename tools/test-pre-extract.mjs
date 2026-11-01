/**
 * ソリッド形式の 7z の事前展開を、本物の 7-Zip で確かめる（7-Zip が無ければ飛ばします）。
 *   node tools/test-pre-extract.mjs
 *
 * **本物のライブラリは触らない。** アーカイブも展開先も一時フォルダに作る。
 * - ソリッドかどうかを一覧の見出しから読む
 * - ソリッドなら丸ごと展開して、そこから返す（中身が正しい・展開し終えたら目印が残る）
 * - 展開が届く前に頼んだファイルも、書き終わってから正しい中身で返る
 * - ソリッドでないものは事前展開しない
 * - アプリを開き直しても、展開し終えたものを使い直す（展開し直さない）
 * - 起動時に、展開し終えていないものを片付ける
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const SEVEN = ['C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe'].find((p) => fs.existsSync(p));
if (!SEVEN) {
  console.log('7-Zip が見つからないので飛ばします');
  process.exit(0);
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'simaeru-pre-extract-'));
let n = 0;
const load = () => {
  const outfile = path.join(work, `lib-${n++}.cjs`);
  buildSync({
    stdin: { contents: "export * from './src/main/archive/preExtract'; export { entryResponse } from './src/main/archive/archiveAccess'; export { archiveListing } from './src/main/archive/sevenZip';", resolveDir: root, loader: 'ts' },
    outfile, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'error'
  });
  return require(outfile);
};

/** 縮みにくい中身（どのページも違う） */
const page = (i, bytes) => {
  const b = Buffer.alloc(bytes);
  let x = (i + 1) * 2654435761 >>> 0;
  for (let j = 0; j < bytes; j += 4) { x = (x * 1664525 + 1013904223) >>> 0; b.writeUInt32LE(x, j); }
  return b;
};
const src = path.join(work, 'src');
const names = Array.from({ length: 40 }, (_, i) => `CG/${String(i).padStart(3, '0')}.jpg`);
for (const [i, name] of names.entries()) {
  fs.mkdirSync(path.join(src, path.dirname(name)), { recursive: true });
  fs.writeFileSync(path.join(src, name), page(i, 1024 * 1024));
}
const pack = (out, solid) => {
  const r = spawnSync(SEVEN, ['a', '-t7z', `-ms=${solid ? 'on' : 'off'}`, '-mx=1', out, './CG'], { cwd: src, windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
};
const solid7z = path.join(work, 'solid.7z');
const plain7z = path.join(work, 'plain.7z');
pack(solid7z, true);
pack(plain7z, false);
const extractRoot = path.join(work, 'extract');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const read = async (lib, archive, entry) => {
  const res = await lib.entryResponse({ archive, entry, rangeHeader: null, mime: 'image/jpeg', sevenZip: SEVEN });
  assert.equal(res.status, 200, `${entry}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};
const keyDir = () => fs.readdirSync(extractRoot).find((d) => !d.endsWith('.done'));

try {
  let lib = load();
  lib.configurePreExtract(extractRoot);

  await test('ソリッドかどうかを一覧の見出しから読む', async () => {
    const solid = await lib.archiveListing(SEVEN, solid7z);
    const plain = await lib.archiveListing(SEVEN, plain7z);
    assert.equal(solid.solid, true); assert.equal(plain.solid, false);
    assert.deepEqual(solid.entries.filter((e) => !e.isDir).map((e) => e.path), names);
    assert(!solid.entries.some((e) => e.path === 'solid.7z'), 'アーカイブそのものの行を中身として数えない');
  });

  await test('ソリッドでないものは事前展開しない', async () => {
    assert.equal(await lib.preExtractedPath(SEVEN, plain7z, names[3]), null);
    assert.deepEqual((await read(lib, plain7z, names[3])).equals(page(3, 1024 * 1024)), true);
    assert(!fs.existsSync(extractRoot) || fs.readdirSync(extractRoot).length === 0);
  });

  await test('ソリッドなら丸ごと展開し、展開が届く前に頼んだものも正しい中身で返る', async () => {
    // 頭・途中・最後を同時に頼む（一覧を開いたときと同じ）。同時に頼んでも 7-Zip は 1 本だけ（2 本走ると同じ展開先を奪い合って失敗した）。
    // 事前展開が失敗すると 1 枚ずつ取り出す方へ回って中身は合ってしまうので、事前展開の場所が返ることを直接確かめる
    const picks = [1, 20, 39];
    const paths = await Promise.all(picks.map((i) => lib.preExtractedPath(SEVEN, solid7z, names[i])));
    picks.forEach((i, k) => {
      assert(paths[k], `${names[i]} が事前展開から返る`);
      assert(fs.readFileSync(paths[k]).equals(page(i, 1024 * 1024)), `${names[i]} の中身`);
    });
    assert((await read(lib, solid7z, names[5])).equals(page(5, 1024 * 1024)));
    for (let i = 0; i < 100 && !fs.readdirSync(extractRoot).some((d) => d.endsWith('.done')); i++) await new Promise((r) => setTimeout(r, 50));
    const dir = keyDir();
    assert(dir && fs.existsSync(path.join(extractRoot, `${dir}.done`)), '展開し終えた目印');
    assert.equal(fs.readdirSync(path.join(extractRoot, dir, 'CG')).length, names.length);
    const p = await lib.preExtractedPath(SEVEN, solid7z, names[39]);
    assert.equal(p, path.join(extractRoot, dir, 'CG', '039.jpg'));
  });

  await test('アプリを開き直しても、展開し終えたものを使い直す', async () => {
    const dir = path.join(extractRoot, keyDir());
    fs.writeFileSync(path.join(dir, 'sentinel'), 'kept'); // 展開し直すと消える
    lib = load(); // 覚えていたものが無い状態（開き直し）
    lib.configurePreExtract(extractRoot);
    await lib.cleanPreExtract();
    assert((await read(lib, solid7z, names[10])).equals(page(10, 1024 * 1024)));
    assert(fs.existsSync(path.join(dir, 'sentinel')), '展開し直していない');
  });

  await test('起動時に、展開し終えていないものと目印だけのものを片付ける', async () => {
    fs.mkdirSync(path.join(extractRoot, 'half-done'));
    fs.writeFileSync(path.join(extractRoot, 'half-done', 'a.jpg'), 'x');
    fs.writeFileSync(path.join(extractRoot, 'orphan.done'), '');
    await lib.cleanPreExtract();
    assert(!fs.existsSync(path.join(extractRoot, 'half-done')));
    assert(!fs.existsSync(path.join(extractRoot, 'orphan.done')));
    assert(fs.existsSync(path.join(extractRoot, keyDir())), '展開し終えたものは残す');
  });

  await test('アーカイブが変わったら別物として展開し直す', async () => {
    fs.writeFileSync(path.join(src, 'CG', '000.jpg'), page(99, 1024 * 1024));
    fs.rmSync(solid7z);
    pack(solid7z, true);
    assert((await read(lib, solid7z, names[0])).equals(page(99, 1024 * 1024)));
  });

  console.log(`${passed} pre-extract cases passed`);
} finally {
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 一時フォルダは OS が片付ける */ }
}
