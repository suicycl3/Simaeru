/**
 * ダウンロードの保存名を決める・直す部品（main/download/fileNames.ts）を確かめる。
 *   node tools/test-download-names.mjs
 * d_657954 が「download」（拡張子なし）のまま完了した件（2026-10-12）の再発防止。作品 ID は架空。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'simaeru-names-'));
const outfile = path.join(work, 'names.cjs');
buildSync({ entryPoints: [path.join(root, 'src/main/download/fileNames.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' });
const n = require(outfile);
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };

const chain = ['https://www.dmm.co.jp/dc/-/proxy/=/transfer_type=download/shop=doujin/product_id=d_000001/', 'https://doujin03.contents.doujin.dmm.co.jp/bb/voice/d_000001.zip?sig=xxx'];

await test('Chromium の名前に拡張子があれば、それを使う', () => {
  assert.equal(n.downloadFileName('d_000001.zip', chain, 'application/zip', 'd_000001'), 'd_000001.zip');
  assert.equal(n.downloadFileName('作品.part1.exe', chain, '', 'd_000001'), '作品.part1.exe');
});

await test('「download」（拡張子なし）なら、行き先の URL の最後の部分。無ければ種類、それも無ければ .bin', () => {
  assert.equal(n.downloadFileName('download', chain, '', 'd_000001'), 'd_000001.zip');
  assert.equal(n.downloadFileName('download', ['https://example.dmm.co.jp/get/12345'], 'application/x-zip-compressed', 'd_000001'), 'd_000001.zip');
  assert.equal(n.downloadFileName('download', ['https://example.dmm.co.jp/get/12345'], 'application/octet-stream', 'd_000001'), 'd_000001.bin');
  assert.equal(n.downloadFileName('', [], '', 'd_000001'), 'd_000001.bin');
});

await test('先頭のバイトで種類を見分ける', async () => {
  assert.equal(n.extensionFromMagic(Buffer.from('504b030414000008', 'hex')), '.zip');
  assert.equal(n.extensionFromMagic(Buffer.from('Rar!\u001a\u0007', 'latin1')), '.rar');
  assert.equal(n.extensionFromMagic(Buffer.from('377abcaf271c0004', 'hex')), '.7z');
  assert.equal(n.extensionFromMagic(Buffer.from('%PDF-1.7', 'latin1')), '.pdf');
  assert.equal(n.extensionFromMagic(Buffer.from('MZ\u0090\u0000', 'latin1')), '.exe');
  assert.equal(n.extensionFromMagic(Buffer.from('<html>', 'latin1')), null);
  const file = path.join(work, 'download');
  fs.writeFileSync(file, Buffer.from('504b0304140000080800', 'hex'));
  assert.equal(await n.sniffExtension(file), '.zip');
  assert.equal(await n.sniffExtension(path.join(work, 'missing')), null);
  assert.equal(n.hasExtension('download'), false);
  assert.equal(n.hasExtension('d_000001.zip'), true);
});

try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 一時フォルダは OS が片付ける */ }
console.log(`OK ${passed}`);
