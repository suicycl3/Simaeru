/**
 * アプリログ（動きの記録）の検証: 秘密になりうるものを落とすこと、書き出せること、太りすぎないこと。
 *   node tools/test-log.mjs
 *
 * 本物の userData には触らない。使い捨てフォルダで試す。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const root = path.join(import.meta.dirname, '..');
const outFile = path.join(os.tmpdir(), 'log.test.cjs');
esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'main', 'log.ts')],
  alias: { '@shared': path.join(root, 'src', 'shared') },
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'error'
});
const { installLogCapture, logFromRenderer, readLog, scrubForLog } = require(outFile);

const failures = [];
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  console.log(`${ok ? '  ok ' : '  NG '} ${label}${ok ? '' : `\n        期待 ${e}\n        実際 ${a}`}`);
  if (!ok) failures.push(label);
};
const ok = (label, cond, detail) => {
  console.log(`${cond ? '  ok ' : '  NG '} ${label}${cond ? '' : `  ${detail ?? ''}`}`);
  if (!cond) failures.push(label);
};

console.log('== 秘密になりうるものを落とす ==');
check('署名付きURLのクエリは残さない',
  scrubForLog('GET https://dl.example.com/file.rar?Expires=1&Signature=abcdef の取得'),
  'GET https://dl.example.com/file.rar?… の取得');
check('Cookie の値は残さない', scrubForLog('Cookie: sid=abcdef123'), 'Cookie: …');
check('パスワードらしき値は残さない', scrubForLog('password=hunter2'), 'password=…');
check('ふつうの文はそのまま', scrubForLog('[download] 開始: row=3 total=1024'), '[download] 開始: row=3 total=1024');
check('クエリの無いURLはそのまま',
  scrubForLog('https://www.dlsite.com/home/download/split/=/product_id/RJ400001.html'),
  'https://www.dlsite.com/home/download/split/=/product_id/RJ400001.html');

console.log('\n== 記録と書き出し ==');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'log-test-'));
const files = installLogCapture(work);
console.log('[test] ふつうの記録');
console.warn('[test] 注意 https://dl.example.com/a.zip?sig=xyz');
logFromRenderer('error', '画面側のエラー');
const body = readLog();
ok('console の出力が残る', body.includes('[test] ふつうの記録'), body.slice(0, 200));
ok('level が分かる', /\[warn\]/.test(body) && /\[renderer:error\]/.test(body), body.slice(0, 300));
ok('書き出しにも秘密は入らない', !body.includes('sig=xyz') && body.includes('a.zip?…'), body.slice(0, 300));
ok('ログの置き場所は userData の中', files.file.startsWith(work), files.file);

console.log('\n== 太りすぎない ==');
const big = 'x'.repeat(50_000);
for (let i = 0; i < 60; i++) console.log(big); // 3MB ぶん（上限 2MB）
const sizeOf = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);
ok('1本あたりは上限まで', sizeOf(files.file) <= 2 * 1024 * 1024, sizeOf(files.file));
ok('古い方は1世代だけ残る', sizeOf(files.previous) > 0 && sizeOf(files.previous) <= 2 * 1024 * 1024, sizeOf(files.previous));
ok('合わせても上限の2本ぶんに収まる', sizeOf(files.file) + sizeOf(files.previous) <= 4 * 1024 * 1024);
ok('書き出しは新旧をつなげる', readLog().length >= sizeOf(files.file));

fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
if (failures.length) {
  console.error(`\nNG: ${failures.length} 件失敗 (${failures.join(' / ')})`);
  process.exit(1);
}
console.log('\nOK');
