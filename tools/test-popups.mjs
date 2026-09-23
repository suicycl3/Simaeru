/**
 * ビューアの別ウィンドウ（ポップアップ）の管理の検証。
 *   node tools/test-popups.mjs
 *
 * electron だけ差し替えて、窓を開く・数える・本体を閉じたらまとめて閉じる、を確かめる。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const root = path.join(import.meta.dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'popups-test-'));
const stub = path.join(work, 'electron.cjs');
fs.writeFileSync(stub, `
const { EventEmitter } = require('node:events');
let nextId = 1;
class BrowserWindow extends EventEmitter {
  constructor(opts) {
    super();
    this.id = nextId++;
    this.opts = opts;
    this.destroyed = false;
    this.loaded = null;
    this.webContents = { setWindowOpenHandler: (fn) => { this.openHandler = fn; } };
    global.__windows.push(this);
  }
  loadFile(file, options) { this.loaded = { file, hash: options && options.hash }; return Promise.resolve(); }
  loadURL(url) { this.loaded = { url }; return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  close() { this.destroyed = true; this.emit('closed'); }
  show() {}
}
module.exports = { BrowserWindow, shell: { openExternal: async () => {} } };
`);
global.__windows = [];
const outFile = path.join(work, 'popups.cjs');
esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'main', 'viewer', 'popups.ts')],
  alias: { '@shared': path.join(root, 'src', 'shared'), electron: stub },
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'error'
});
const { validatePopupSpec, openViewerPopup, popupCount, closeAllPopups } = require(outFile);

const failures = [];
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  console.log(`${ok ? '  ok ' : '  NG '} ${label}${ok ? '' : `\n        期待 ${e}\n        実際 ${a}`}`);
  if (!ok) failures.push(label);
};
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

console.log('== 画面から来た指定を確かめる ==');
check('知らない種類は断る', throws(() => validatePopupSpec({ kind: 'shell', productId: 1 })), true);
check('作品IDが数でなければ断る', throws(() => validatePopupSpec({ kind: 'pdf', productId: '1' })), true);
check('中身が無ければ断る', throws(() => validatePopupSpec(null)), true);
check('正しい指定は受け付ける', validatePopupSpec({ kind: 'voice', productId: 3 }), { kind: 'voice', productId: 3, entryUrl: null, title: null });
check('題名は長すぎれば切る', validatePopupSpec({ kind: 'pdf', productId: 3, title: 'あ'.repeat(500) }).title.length, 200);

console.log('\n== 窓を開く ==');
const a = openViewerPopup({ kind: 'pdf', productId: 7, entryUrl: 'mylib://x/台本.pdf', title: '作品' });
const b = openViewerPopup({ kind: 'voice', productId: 7 });
const c = openViewerPopup({ kind: 'text', productId: 8, entryUrl: 'mylib://y/a.txt' });
check('いくつでも同時に開ける', popupCount(), 3);
check('窓ごとに別のID', new Set([a, b, c]).size, 3);
const first = global.__windows[0];
check('同じ画面（index.html）を開く', path.basename(first.loaded.file), 'index.html');
check('何を出すかは #popup= で渡す',
  JSON.parse(decodeURIComponent(first.loaded.hash.replace(/^popup=/, ''))),
  { kind: 'pdf', productId: 7, entryUrl: 'mylib://x/台本.pdf', title: '作品' });
check('題名にアプリ名を添える', first.opts.title, '作品 - Simaeru');
check('画面は本体と同じ守り（contextIsolation）', first.opts.webPreferences.contextIsolation, true);
check('外部リンクは窓の中で開かない', first.openHandler({ url: 'https://example.com' }), { action: 'deny' });

console.log('\n== 閉じる ==');
global.__windows[1].close();
check('閉じた窓は数えない', popupCount(), 2);
closeAllPopups();
check('本体を閉じたらまとめて閉じる', popupCount(), 0);
check('すべての窓が閉じている', global.__windows.every((w) => w.destroyed), true);

fs.rmSync(work, { recursive: true, force: true });
if (failures.length) {
  console.error(`\nNG: ${failures.length} 件失敗 (${failures.join(' / ')})`);
  process.exit(1);
}
console.log('\nOK');
