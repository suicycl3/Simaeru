/**
 * データの置き場所の決め方（古い名前のフォルダからの引き継ぎ）の検証。
 *   node tools/test-userdata.mjs
 *
 * 本物の %APPDATA% には触らない。使い捨てフォルダで試す。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const root = path.join(import.meta.dirname, '..');
const outFile = path.join(os.tmpdir(), 'userData.test.cjs');
esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'main', 'userData.ts')],
  alias: { '@shared': path.join(root, 'src', 'shared') },
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'error'
});
const { resolveUserDataDir } = require(outFile);

const failures = [];
/** 実際と期待を比べる */
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  console.log(`${ok ? '  ok ' : '  NG '} ${label}${ok ? '' : `\n        期待 ${e}\n        実際 ${a}`}`);
  if (!ok) failures.push(label);
};

const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'userdata-test-'));
const seed = (dir, name, content) => {
  const full = path.join(dir, name);
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(path.join(full, 'library.db'), content);
  return full;
};
const clean = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });

console.log('== 置き場所の決め方 ==');
{
  const appData = fresh();
  check('どちらも無ければ新しい名前', resolveUserDataDir(appData), path.join(appData, 'simaeru'));
  clean(appData);
}
{
  const appData = fresh();
  seed(appData, 'dmm-library', '古い中身');
  const got = resolveUserDataDir(appData);
  check('古い名前だけなら、引き継いで新しい名前になる', got, path.join(appData, 'simaeru'));
  check('中身がそのまま移る', fs.readFileSync(path.join(got, 'library.db'), 'utf8'), '古い中身');
  check('古いフォルダは残らない', fs.existsSync(path.join(appData, 'dmm-library')), false);
  clean(appData);
}
{
  const appData = fresh();
  seed(appData, 'dmm-library', '古い中身');
  seed(appData, 'simaeru', '新しい中身');
  const got = resolveUserDataDir(appData);
  check('どちらもあるときは新しい方を使う', got, path.join(appData, 'simaeru'));
  check('古い方には手を出さない', fs.readFileSync(path.join(appData, 'dmm-library', 'library.db'), 'utf8'), '古い中身');
  clean(appData);
}
{
  const appData = fresh();
  const old = seed(appData, 'dmm-library', '古い中身');
  // 中のファイルを開いたままだと、Windows ではフォルダを改名できない
  const held = fs.openSync(path.join(old, 'library.db'), 'r+');
  const got = resolveUserDataDir(appData);
  fs.closeSync(held);
  check('引き継げないときは、これまでの置き場所を使う', got, path.join(appData, 'dmm-library'));
  check('中身は失われない', fs.readFileSync(path.join(got, 'library.db'), 'utf8'), '古い中身');
  clean(appData);
}
{
  const appData = fresh();
  seed(appData, 'dmm-library', '古い中身');
  const override = path.join(appData, '写し');
  check('環境変数で指定したら、そちらを使う', resolveUserDataDir(appData, override), override);
  check('指定があるときは古いフォルダを触らない', fs.existsSync(path.join(appData, 'dmm-library')), true);
  clean(appData);
}

if (failures.length) {
  console.error(`\nNG: ${failures.length} 件失敗 (${failures.join(' / ')})`);
  process.exit(1);
}
console.log('\nOK');
