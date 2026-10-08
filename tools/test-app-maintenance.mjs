/**
 * 新しい版の確認と、「ユーザーデータを削除して終了」の後始末を確かめる。
 *   node tools/test-app-maintenance.mjs
 * 版の確認は通信せず、偽の応答で見る。削除は使い捨ての一時フォルダだけを、本物の PowerShell で消す。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'simaeru-maintenance-'));
const build = (entry, name) => {
  const outfile = path.join(work, name);
  buildSync({ entryPoints: [path.join(root, entry)], outfile, bundle: true, platform: 'node', format: 'cjs',
    alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'error' });
  return require(outfile);
};
const { compareVersions, checkLatestRelease } = build('src/main/maintenance/versionCheck.ts', 'version.cjs');
const { isRemovableUserData, scheduleUserDataRemoval } = build('src/main/maintenance/userDataRemoval.ts', 'removal.cjs');
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await test('版の比較', () => {
    assert(compareVersions('0.4.0', '0.3.9') > 0);
    assert(compareVersions('v0.3.10', '0.3.9') > 0); // 数として比べる
    assert.equal(compareVersions('0.3.0', 'v0.3.0'), 0);
    assert(compareVersions('0.3', '0.3.1') < 0);
    assert(compareVersions('1.0.0-beta', '0.9.0') > 0);
  });

  await test('新しい版の確認: 新しい・同じ・失敗・知らない URL', async () => {
    const calls = [];
    const reply = (status, body) => async (url, init) => {
      calls.push([url, init.headers['User-Agent']]);
      return { ok: status === 200, status, json: async () => body };
    };
    const newer = await checkLatestRelease('0.3.0', reply(200, {
      tag_name: 'v0.4.0', html_url: 'https://github.com/suicycl3/Simaeru/releases/tag/v0.4.0', published_at: '2026-10-08T00:00:00Z'
    }));
    assert.deepEqual(newer, { current: '0.3.0', latest: '0.4.0', newer: true, url: 'https://github.com/suicycl3/Simaeru/releases/tag/v0.4.0', publishedAt: '2026-10-08T00:00:00Z' });
    // 問い合わせ先は配布元の最新のリリース。送るのはアプリの名前と版だけ
    assert.deepEqual(calls[0], ['https://api.github.com/repos/suicycl3/Simaeru/releases/latest', 'Simaeru/0.3.0']);
    const same = await checkLatestRelease('0.4.0', reply(200, { tag_name: 'v0.4.0', html_url: 'https://github.com/suicycl3/Simaeru/releases/tag/v0.4.0' }));
    assert.equal(same.newer, false);
    // 配布元のリリースのページ以外は開かせない
    assert.equal((await checkLatestRelease('0.3.0', reply(200, { tag_name: 'v9', html_url: 'https://example.com/x' }))).url, null);
    await assert.rejects(checkLatestRelease('0.3.0', reply(404, {})), /HTTP 404/);
    await assert.rejects(checkLatestRelease('0.3.0', reply(200, {})), /応答|response/i);
    await assert.rejects(checkLatestRelease('0.3.0', async () => { throw new Error('offline'); }), /つながりません|connection/);
  });

  await test('消してよいデータのフォルダか', () => {
    const data = path.join(work, 'data');
    fs.mkdirSync(data);
    assert.equal(isRemovableUserData(data), false); // 台帳が無い
    fs.writeFileSync(path.join(data, 'library.db'), '');
    assert.equal(isRemovableUserData(data), true);
    assert.equal(isRemovableUserData(os.homedir()), false);
    assert.equal(isRemovableUserData(path.join(os.homedir(), 'Documents')), false);
    assert.equal(isRemovableUserData(path.parse(work).root), false);
  });

  await test('アプリが終わるのを待ってから、データのフォルダを消す', async () => {
    const data = path.join(work, 'データ（削除の試験）');
    fs.mkdirSync(path.join(data, 'Partitions', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(data, 'library.db'), 'x');
    fs.writeFileSync(path.join(data, 'Partitions', 'sub', 'Cookies'), 'x');
    // アプリの代わりに 2 秒だけ動くプロセス
    const app = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { stdio: 'ignore' });
    scheduleUserDataRemoval(data, app.pid);
    await sleep(1000);
    assert(fs.existsSync(data), 'アプリが動いているあいだは消さない');
    const until = Date.now() + 20000;
    while (fs.existsSync(data) && Date.now() < until) await sleep(250);
    assert(!fs.existsSync(data), '終わったら消える');
    assert(fs.existsSync(work), '親のフォルダは消さない');
  });
  await test('予約したアプリ自身が先に終わっても、あとで消える（本番と同じ流れ）', async () => {
    const data = path.join(work, 'data-self');
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'library.db'), 'x');
    // アプリの代わり: 自分の pid で予約して、すぐ終わる
    const app = spawn(process.execPath, ['-e', `require(${JSON.stringify(path.join(work, 'removal.cjs'))}).scheduleUserDataRemoval(${JSON.stringify(data)}); setTimeout(() => process.exit(0), 100);`], { stdio: 'ignore' });
    await new Promise((r) => app.on('exit', r));
    const until = Date.now() + 20000;
    while (fs.existsSync(data) && Date.now() < until) await sleep(250);
    assert(!fs.existsSync(data), 'アプリが終わったあとに消える');
  });
} finally {
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 一時フォルダは OS が片付ける */ }
}
console.log(`OK ${passed}`);
