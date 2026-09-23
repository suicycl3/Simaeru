/**
 * 解凍するだけの exe（自己解凍書庫）の見分けの検証。
 *   node tools/test-sfx.mjs
 *
 * 7-Zip があれば、同梱の SFX モジュールでその場で自己解凍 exe を作って確かめる（exe は実行しない）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const root = path.join(import.meta.dirname, '..');
const outFile = path.join(os.tmpdir(), 'sevenZip.sfx.test.cjs');
esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'main', 'archive', 'sevenZip.ts')],
  alias: { '@shared': path.join(root, 'src', 'shared') },
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'error'
});
const { sfxTypeOf, detectSfx, isSfxCandidate, isArchiveFile, rememberSfx, extractFolderName } = require(outFile);

const failures = [];
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  console.log(`${ok ? '  ok ' : '  NG '} ${label}${ok ? '' : `\n        期待 ${e}\n        実際 ${a}`}`);
  if (!ok) failures.push(label);
};

console.log('== 7-Zip の見出しから形式を読む ==');
// 実物（RAR5 の自己解凍）の見出しと同じ形
const rar5 = ['--', 'Path = C:\\x\\RJ000001.exe', 'Type = Rar5', 'Offset = 324192', 'Physical Size = 3196041887', 'Encrypted = -', 'Solid = -'].join('\r\n');
check('RAR5 の自己解凍', sfxTypeOf(rar5), 'Rar5');
check('7z の自己解凍', sfxTypeOf('--\nPath = a.exe\nType = 7z\nOffset = 200000\n'), '7z');
check('ふつうの実行ファイル（PE）は対象外', sfxTypeOf('--\nPath = a.exe\nType = PE\nCPU = x64\n'), null);
check('NSIS のインストーラは対象外', sfxTypeOf('--\nPath = setup.exe\nType = Nsis\nMethod = LZMA\n'), null);
check('パスワード付きは対象外（開けない）', sfxTypeOf('--\nPath = a.exe\nType = Rar5\nEncrypted = +\n'), null);

console.log('\n== 調べる対象 ==');
check('単体の exe は調べる', isSfxCandidate('D:\\lib\\RJ000001.exe'), true);
check('分割の先頭（.part1.exe）は別の仕組みで扱う', isSfxCandidate('D:\\lib\\RJ000001.part1.exe'), false);
check('exe でなければ調べない', isSfxCandidate('D:\\lib\\RJ000001.zip'), false);
check('展開先の名前は exe を落としたもの', extractFolderName('D:\\lib\\RJ000001.exe'), 'RJ000001');

console.log('\n== 覚えた exe は書庫として扱う ==');
const known = path.join(os.tmpdir(), 'sfx-known', 'RJ000002.exe');
check('覚える前はただの exe', isArchiveFile(known), false);
rememberSfx(known);
check('覚えたあとは書庫', isArchiveFile(known), true);
check('大文字小文字の違いは同じファイル', isArchiveFile(known.toUpperCase()), true);

// ── 実物で確かめる（7-Zip と SFX モジュールがあるときだけ） ──
const sevenZip = ['C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe'].find((p) => fs.existsSync(p));
const sfxModule = sevenZip && path.join(path.dirname(sevenZip), '7z.sfx');
if (sevenZip && fs.existsSync(sfxModule)) {
  console.log('\n== 実物の自己解凍 exe ==');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-test-'));
  fs.mkdirSync(path.join(work, 'src', '作品'), { recursive: true });
  fs.writeFileSync(path.join(work, 'src', '作品', 'readme.txt'), 'はじめにお読みください');
  const sfx = path.join(work, 'RJ000003.exe');
  const made = spawnSync(sevenZip, ['a', `-sfx${sfxModule}`, sfx, '作品'], { cwd: path.join(work, 'src'), windowsHide: true });
  check('7-Zip で自己解凍 exe を作れる', made.status === 0 && fs.existsSync(sfx), true);
  check('自己解凍 exe を 7z 形式と見分ける', await detectSfx(sevenZip, sfx), '7z');
  check('ふつうの実行ファイル（7z.exe そのもの）は書庫ではない', await detectSfx(sevenZip, sevenZip), null);
  check('exe でないファイルは書庫ではない', await detectSfx(sevenZip, path.join(work, 'src', '作品', 'readme.txt')), null);
  fs.rmSync(work, { recursive: true, force: true });
} else {
  console.log('\n  -- 7-Zip の SFX モジュールが無いので、実物での確認は飛ばします');
}

if (failures.length) {
  console.error(`\nNG: ${failures.length} 件失敗 (${failures.join(' / ')})`);
  process.exit(1);
}
console.log('\nOK');
