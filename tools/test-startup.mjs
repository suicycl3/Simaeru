/**
 * Windows の起動時に起動する設定（src/main/startup.ts）。
 *   node tools/test-startup.mjs
 * Electron の app・ipcMain は偽物（呼ばれた内容を記録するだけ）。本物の「スタートアップ」には登録しない。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSync } = require('esbuild');
const root = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-test-'));
const stub = path.join(dir, 'electron.cjs');
fs.writeFileSync(
  stub,
  `const calls = globalThis.__startup = { set: [], handlers: {}, login: { openAtLogin: true, executableWillLaunchAtLogin: true } };
module.exports = {
  app: {
    isPackaged: true,
    getAppPath: () => 'C:\\\\Simaeru\\\\resources\\\\app',
    setLoginItemSettings: (o) => calls.set.push(o),
    getLoginItemSettings: () => calls.login
  },
  ipcMain: { handle: (name, fn) => { calls.handlers[name] = fn; } }
};`
);
const outfile = path.join(dir, 'startup.cjs');
buildSync({ entryPoints: [path.join(root, 'src/main/startup.ts')], outfile, bundle: true, platform: 'node', format: 'cjs',
  alias: { '@shared': path.join(root, 'src/shared'), electron: stub }, logLevel: 'error' });
const { setupStartup, loginArgs, launchedHidden } = require(outfile);
const calls = globalThis.__startup;

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`PASS ${name}`);
};
const fakeRepo = (initial = {}) => {
  const m = new Map(Object.entries(initial));
  return { getSetting: (k) => m.get(k) ?? null, setSetting: (k, v) => m.set(k, v) };
};

test('引数: 配布版は --hidden だけ。開発中はアプリのフォルダも渡す', () => {
  assert.deepEqual(loginArgs(true, 'C:\\app', true), ['--hidden']);
  assert.deepEqual(loginArgs(true, 'C:\\app', false), []);
  assert.deepEqual(loginArgs(false, 'C:\\app', true), ['C:\\app', '--hidden']);
  assert.equal(launchedHidden(['Simaeru.exe', '--hidden']), true);
  assert.equal(launchedHidden(['Simaeru.exe']), false);
});

test('既定はオフ。起動しても登録に触らない', () => {
  calls.set.length = 0;
  setupStartup(fakeRepo());
  assert.equal(calls.set.length, 0);
  const s = calls.handlers['app:startup']();
  assert.deepEqual(s, { openAtLogin: false, startInTray: true, disabledByWindows: false });
});

test('設定でオンにすると、窓を出さない引数で登録し、スタートアップの有効も付ける', () => {
  calls.set.length = 0;
  const repo = fakeRepo();
  setupStartup(repo);
  const s = calls.handlers['app:setStartup'](null, { openAtLogin: true });
  assert.equal(s.openAtLogin, true);
  const on = calls.set.find((o) => o.openAtLogin);
  assert.deepEqual(on.args, ['--hidden']);
  assert.equal(on.path, process.execPath);
  assert.equal(on.enabled, true);
  assert.equal(on.name, 'Simaeru');
  // 窓を出す起動に変えると、引数なしで登録し直す
  calls.set.length = 0;
  calls.handlers['app:setStartup'](null, { startInTray: false });
  assert.deepEqual(calls.set.find((o) => o.openAtLogin).args, []);
  // オフにすると外す
  calls.set.length = 0;
  calls.handlers['app:setStartup'](null, { openAtLogin: false });
  assert.ok(calls.set.length > 0 && calls.set.every((o) => o.openAtLogin === false));
});

test('オンのまま起動すると、今の場所で登録し直す（タスクマネージャーで無効にした選択は打ち消さない）', () => {
  calls.set.length = 0;
  setupStartup(fakeRepo({ 'app.openAtLogin': '1' }));
  const on = calls.set.find((o) => o.openAtLogin);
  assert.ok(on, '登録し直す');
  assert.equal('enabled' in on, false);
});

test('タスクマネージャーで無効にされていたら知らせる', () => {
  setupStartup(fakeRepo({ 'app.openAtLogin': '1' }));
  calls.login = { openAtLogin: true, executableWillLaunchAtLogin: false };
  assert.equal(calls.handlers['app:startup']().disabledByWindows, true);
  calls.login = { openAtLogin: true, executableWillLaunchAtLogin: true };
  assert.equal(calls.handlers['app:startup']().disabledByWindows, false);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`OK ${passed}`);
