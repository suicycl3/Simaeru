/**
 * タスクトレイのメニューと、画面からの終了・再起動（src/main/tray.ts）。
 *   node tools/test-tray.mjs
 * Electron の app・Tray・Menu・dialog・ipcMain は偽物（呼ばれた内容を記録するだけ）。本物のアプリは止めない。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSync } = require('esbuild');
const root = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-test-'));
const stub = path.join(dir, 'electron.cjs');
fs.writeFileSync(
  stub,
  `const calls = globalThis.__tray = { handlers: {}, menus: [], quit: 0, relaunch: [], dialogs: [], answer: 1 };
class Tray {
  constructor() { calls.tray = this; }
  setToolTip() {}
  setContextMenu(menu) { calls.menus.push(menu); }
  on() {}
}
module.exports = {
  app: {
    on: () => undefined,
    quit: () => { calls.quit++; },
    relaunch: (o) => calls.relaunch.push(o),
    getAppPath: () => 'C:\\\\Simaeru',
    isPackaged: true
  },
  dialog: { showMessageBox: async (...args) => { calls.dialogs.push(args.at(-1)); return { response: calls.answer, checkboxChecked: false }; } },
  ipcMain: { handle: (name, fn) => { calls.handlers[name] = fn; } },
  Menu: { buildFromTemplate: (template) => template },
  nativeImage: { createFromPath: () => ({}) },
  Tray
};`
);
const outfile = path.join(dir, 'tray.cjs');
buildSync({ entryPoints: [path.join(root, 'src/main/tray.ts')], outfile, bundle: true, platform: 'node', format: 'cjs',
  alias: { '@shared': path.join(root, 'src/shared'), electron: stub }, logLevel: 'error' });
const { setupCloseToTray, relaunchArgs, OPEN_SETTINGS_ARG } = require(outfile);
const calls = globalThis.__tray;

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
};
const rows = { downloads: [], jobs: [] };
const repo = { getSetting: () => null, setSetting: () => undefined, listDownloads: () => rows.downloads, listJobs: () => rows.jobs };
const win = { isDestroyed: () => false, isMinimized: () => false, show: () => undefined, focus: () => undefined };
const opened = [];
const tray = setupCloseToTray({ repo, getWindow: () => win, openSettings: (section) => opened.push(section ?? 'default') });

let status = { enabled: false, running: false, port: 47615, url: 'http://127.0.0.1:47615/mcp', token: 'x', error: null };
const listeners = [];
const mcpCalls = [];
const mcp = {
  status: () => status,
  setEnabled: async (enabled) => { mcpCalls.push(`enabled:${enabled}`); status = { ...status, enabled, running: enabled }; listeners.forEach((l) => l(status)); return status; },
  restart: async () => { mcpCalls.push('restart'); return status; },
  onChange: (l) => { listeners.push(l); return () => undefined; }
};
const menu = () => calls.menus.at(-1);
const item = (label) => menu().find((m) => m.label === label);
const mcpItem = () => menu().find((m) => typeof m.label === 'string' && m.label.startsWith('MCP サーバー'));
const sub = (label) => mcpItem().submenu.find((m) => m.label === label);

try {
  await test('トレイのメニュー: 表示・設定・MCP サーバー・再起動・終了', async () => {
    tray.ensureTray();
    tray.connect({ mcp, isSyncing: () => false });
    assert.deepEqual(menu().filter((m) => m.label).map((m) => m.label), ['Simaeru を表示', '設定', 'MCP サーバー: 停止中', '再起動', '終了']);
    item('設定').click();
    sub('MCP の設定を開く').click();
    assert.deepEqual(opened, ['default', 'mcp']);
  });

  await test('MCP サーバーを起動・停止できて、状態が変わればメニューも変わる', async () => {
    assert.equal(sub('起動する').enabled, true); assert.equal(sub('停止する').enabled, false);
    sub('起動する').click();
    await new Promise((r) => setImmediate(r));
    assert.equal(mcpItem().label, 'MCP サーバー: 起動中');
    assert.equal(sub('起動する').enabled, false); assert.equal(sub('停止する').enabled, true);
    // 起動できなかった（ポートが使われていた）ときの「起動する」は、やり直し
    status = { ...status, running: false, error: 'port 47615 is in use' };
    listeners.forEach((l) => l(status));
    assert.equal(mcpItem().label, 'MCP サーバー: 起動できません');
    sub('起動する').click();
    sub('停止する').click();
    assert.deepEqual(mcpCalls, ['enabled:true', 'restart', 'enabled:false']);
  });

  await test('トレイの再起動・終了は確かめずに終わる（再起動はトレイで起動した印を引き継がない）', async () => {
    const argv = process.argv;
    process.argv = ['C:\\Simaeru\\Simaeru.exe', '--hidden', OPEN_SETTINGS_ARG, '--lang=ja'];
    try {
      item('再起動').click();
      assert.deepEqual(calls.relaunch.at(-1), { args: ['--lang=ja'] });
    } finally {
      process.argv = argv;
    }
    item('終了').click();
    assert.equal(calls.quit, 2); assert.equal(calls.dialogs.length, 0);
    assert.deepEqual(relaunchArgs(['electron.exe', '.', '--hidden']), ['.']);
  });

  await test('画面からの終了・再起動: 動いている処理があるときだけ確かめる', async () => {
    const before = calls.quit;
    assert.equal(await calls.handlers['app:quit'](null, false), true);
    assert.equal(calls.quit, before + 1); assert.equal(calls.dialogs.length, 0);
    rows.downloads = [{ state: 'running' }];
    rows.jobs = [{ state: 'queued' }];
    calls.answer = 1; // キャンセル
    assert.equal(await calls.handlers['app:quit'](null, true), false);
    assert.equal(calls.quit, before + 1, '取りやめたら終わらない');
    assert.match(calls.dialogs.at(-1).detail, /ダウンロード・展開・変換の途中です/);
    assert.equal(calls.dialogs.at(-1).message, 'Simaeru を再起動しますか？');
    calls.answer = 0; // 再起動
    const relaunches = calls.relaunch.length;
    assert.equal(await calls.handlers['app:quit'](null, true), true);
    assert.equal(calls.quit, before + 2); assert.equal(calls.relaunch.length, relaunches + 1);
  });
  console.log(`${passed} tray cases passed`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
