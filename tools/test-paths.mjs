/**
 * 保存先のフォルダ構成（テンプレート展開・禁止文字・パス長）の検証。
 *   node tools/test-paths.mjs
 */
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const outFile = path.join(os.tmpdir(), 'paths.test.cjs');
esbuild.buildSync({
  entryPoints: [path.join(import.meta.dirname, '..', 'src', 'main', 'download', 'paths.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'error',
  // @shared/types のエイリアスを解決する
  alias: { '@shared': path.join(import.meta.dirname, '..', 'src', 'shared') }
});
const { productFolder, sanitizeSegment, uniqueFileName, DEFAULT_TEMPLATE } = require(outFile);

const failures = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? '  ok ' : '  NG '} ${label}`);
  if (!ok) {
    console.log(`        期待 ${JSON.stringify(expected)}`);
    console.log(`        実際 ${JSON.stringify(actual)}`);
    failures.push(label);
  }
};

const product = {
  siteId: 'dlsite',
  category: 'doujin',
  workType: 'voice',
  maker: 'まるねこ工房',
  title: 'まじめ後輩ちゃんとひみつの図書室',
  productId: 'RJ01000002',
  floorId: 'library',
  purchasedAt: '2024-06-02 10:00',
  releasedAt: null
};

console.log('== 禁止文字の処理 ==');
check('禁止文字を落とす', sanitizeSegment('a/b:c*d?e"f<g>h|i'), 'abcdefghi');
check('末尾のドットと空白を落とす', sanitizeSegment('フォルダ名. '), 'フォルダ名');
check('予約名は避ける', sanitizeSegment('CON'), 'CON_');
check('空になったら _', sanitizeSegment('///'), '_');

console.log('\n== テンプレート展開 ==');
const root = 'D:\\Simaeru';
// テストの作品はボイス。既定ではサークルの下に種別（ボイス・ASMR）のフォルダが入る
const WORK_TYPE_DIR = 'ボイス・ASMR';
check(
  '既定のテンプレート（サークルの下を種別で分ける）',
  productFolder(root, DEFAULT_TEMPLATE, product),
  path.join(root, 'DLsite', '同人', 'まるねこ工房', WORK_TYPE_DIR, '[まるねこ工房] まじめ後輩ちゃんとひみつの図書室')
);
check(
  '種別と購入年でも組める',
  productFolder(root, '{site}/{workType}/{year}/{productId}', product),
  path.join(root, 'DLsite', 'ボイス・ASMR', '2024', 'RJ01000002')
);
check(
  'ブランド未設定は「不明」',
  productFolder(root, '{maker}', { ...product, maker: null }),
  path.join(root, '不明')
);
check(
  'タイトルが空なら作品IDを使う',
  productFolder(root, '{title}', { ...product, title: '' }),
  path.join(root, 'RJ01000002')
);
check(
  'トークンの中の / は階層にしない',
  productFolder(root, '{maker}', { ...product, maker: 'A/B' }),
  path.join(root, 'AB')
);

console.log('\n== パス長 ==');
const longTitle = 'あ'.repeat(200);
const longPath = productFolder(root, DEFAULT_TEMPLATE, { ...product, title: longTitle }, 'RJ01000002.zip');
check('240文字以内に収める', path.join(longPath, 'RJ01000002.zip').length <= 240, true);
check('作品IDは残る（親フォルダは削られても一意性が残る）', longPath.includes('まるねこ工房'), true);

console.log('\n== 同名ファイル ==');
const existing = new Set([path.join('D:\\dir', 'a.zip'), path.join('D:\\dir', 'a (2).zip')]);
check(
  '重複したら連番を付ける',
  uniqueFileName((p) => existing.has(p), 'D:\\dir', 'a.zip'),
  path.join('D:\\dir', 'a (3).zip')
);
check(
  '重複しなければそのまま',
  uniqueFileName((p) => existing.has(p), 'D:\\dir', 'b.zip'),
  path.join('D:\\dir', 'b.zip')
);

if (failures.length) {
  console.error(`\nNG: ${failures.length} 件失敗`);
  process.exit(1);
}
console.log('\nOK');
