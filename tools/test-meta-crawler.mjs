/**
 * メタの自動取得（裏の巡回）と店舗ページの取得を、通信せずに確かめる。
 *   node tools/test-meta-crawler.mjs
 *
 * - ログイン切れ・年齢確認で断られ続ける作品が 1 件あっても、ほかの作品は取れる（巡回が止まらない）
 * - 本当にログインが切れているときは、どの作品も回数を進めない
 * - 店舗ページが無い（404）ときは「無い」と分かる（取得済みにできる）
 * 待ち時間（30 秒・10 分）は仮の時計で進める。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'simaeru-meta-crawler-'));
const clientStub = path.join(work, 'client.cjs');
// 束ねた側と、このテストが読む側で同じクラスを使う（instanceof で見分けるため）
fs.writeFileSync(clientStub, `
if (!global.__clientStub) {
  class DmmAuthError extends Error { constructor(m = 'auth') { super(m); this.name = 'DmmAuthError'; } }
  class DmmAgeCheckError extends DmmAuthError { constructor() { super('age'); this.name = 'DmmAgeCheckError'; } }
  class DlsiteAuthError extends Error {}
  global.__clientStub = { DmmAuthError, DmmAgeCheckError, DlsiteAuthError, fetchText: (url) => global.__fetchText(url) };
}
module.exports = global.__clientStub;
`);

let n = 0;
function load(file, aliases) {
  const outfile = path.join(work, `${n++}.cjs`);
  let contents = fs.readFileSync(path.join(root, file), 'utf8');
  for (const [from, to] of Object.entries(aliases)) contents = contents.replaceAll(`'${from}'`, JSON.stringify(to));
  buildSync({ stdin: { contents, loader: 'ts', resolveDir: path.dirname(path.join(root, file)) }, outfile, bundle: true,
    platform: 'node', format: 'cjs', alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'error' });
  return require(outfile);
}

const { MetaCrawler } = load('src/main/meta/metaCrawler.ts', { '../sites/dmm/client': clientStub, '../sites/dlsite/client': clientStub });
const { DmmAuthError } = require(clientStub);

// 仮の時計。setTimeout は「その時刻になったら」呼ぶ。実時間では待たない
let now = 1_000_000;
const timers = [];
const realNow = Date.now;
Date.now = () => now;
globalThis.setTimeout = (fn, ms = 0) => { timers.push({ at: now + ms, fn }); return { unref() {} }; };
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function advance(untilMs) {
  const end = now + untilMs;
  for (;;) {
    await flush();
    timers.sort((a, b) => a.at - b.at);
    const next = timers[0];
    if (!next || next.at > end) break;
    timers.shift();
    now = Math.max(now, next.at);
    next.fn();
  }
  now = end;
}

/** 作品の並び（新しい順）と、取れた・断られた・回数の記録を持つ偽のライブラリ */
function makeRepo(ids) {
  const state = new Map(ids.map((id) => [id, { fetched: false, attempts: 0 }]));
  const settings = new Map([['meta.auto.concurrency', '1'], ['meta.auto.intervalMs', '100']]);
  return {
    state,
    getSetting: (k) => settings.get(k) ?? null,
    setSetting: (k, v) => settings.set(k, v),
    nextMetaTargets: (max, _sites, limit) =>
      ids.filter((id) => !state.get(id).fetched && state.get(id).attempts < max).slice(0, limit).map((id) => ({ id, title: `#${id}` })),
    metaPendingCount: (max) => ids.filter((id) => !state.get(id).fetched && state.get(id).attempts < max).length,
    bumpMetaAttempt: (id) => { state.get(id).attempts++; },
    markMetaFetched: (id) => { state.get(id).fetched = true; }
  };
}

function crawler(repo, fetchDetail) {
  return new MetaCrawler({
    repo, fetchDetail, isSyncRunning: () => false, loggedInSites: () => ['dmm'], onProgress: () => {}
  });
}

// ① 一番新しい作品だけが断られ続ける。ほかの作品は取れ、断られる作品はいずれ打ち切られる
{
  const repo = makeRepo([1, 2, 3, 4]);
  const calls = [];
  const c = crawler(repo, async (id) => {
    calls.push(id);
    if (id === 1) throw new DmmAuthError();
    repo.markMetaFetched(id);
    return { supported: true };
  });
  c.runNow();
  await advance(60 * 60_000);
  c.stop();
  assert.deepEqual([2, 3, 4].map((id) => repo.state.get(id).fetched), [true, true, true], 'ほかの作品は取れる');
  assert.equal(repo.state.get(1).fetched, false);
  assert.ok(repo.state.get(1).attempts >= 1, '作品側の問題と分かったら回数を進める');
  assert.ok(calls.filter((id) => id === 1).length < 10, `断られる作品を叩き続けない（${calls.filter((id) => id === 1).length} 回）`);
  console.log('OK: 断られ続ける 1 件があっても、ほかの作品は取れる（その作品は後回し→いずれ打ち切り）');
}

// ② 本当にログインが切れている（どの作品も断られる）ときは、回数を進めずに待つ
{
  const repo = makeRepo([1, 2, 3]);
  let calls = 0;
  const c = crawler(repo, async () => { calls++; throw new DmmAuthError(); });
  c.runNow();
  await advance(30 * 60_000);
  c.stop();
  assert.deepEqual([1, 2, 3].map((id) => repo.state.get(id).attempts), [0, 0, 0], 'ログイン切れでは回数を進めない');
  assert.ok(calls <= 30 * 2 + 3, `30 分で叩きすぎない（${calls} 回）`);
  assert.match(c.status().pausedReason ?? '', /ログイン/);
  console.log('OK: ログインが切れているときは、回数を進めずに間を置いて待つ');
}

// ③ 店舗ページが無い（404）なら gone。通信の失敗（500）はそうしない。ログイン切れは投げる
{
  const { fetchDlsoftStoreMeta, fetchDoujinStoreMeta } = load('src/main/sites/dmm/storeMeta.ts', { './client': clientStub });
  const warn = console.warn;
  console.warn = () => {};
  try {
    global.__fetchText = async (url) => { throw new Error(`GET ${url} failed: HTTP 404`); };
    assert.equal((await fetchDlsoftStoreMeta('pc_0001')).gone, true);
    assert.equal((await fetchDoujinStoreMeta('d_1')).gone, true);
    global.__fetchText = async (url) => { throw new Error(`GET ${url} failed: HTTP 500`); };
    assert.equal((await fetchDlsoftStoreMeta('pc_0001')).gone, undefined);
    global.__fetchText = async () => { throw new DmmAuthError(); };
    await assert.rejects(fetchDlsoftStoreMeta('pc_0001'), DmmAuthError);
  } finally {
    console.warn = warn;
  }
  console.log('OK: 店舗ページの 404 は「無い」と分かる（500 は取り直す・ログイン切れは上に伝える）');
}

Date.now = realNow;
try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 一時フォルダは OS が片付ける */ }
console.log('OK');
process.exit(0);
