import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mylibrary-review-'));
const stub = path.join(work, 'electron.cjs');
fs.writeFileSync(stub, 'exports.session = { fromPartition: () => global.__reviewSession };');
let n = 0;
function load(file, aliases = {}) {
  const outfile = path.join(work, `${n++}.cjs`);
  let contents = fs.readFileSync(path.join(root, file), 'utf8');
  for (const [from, to] of Object.entries(aliases)) contents = contents.replaceAll(`'${from}'`, JSON.stringify(to));
  buildSync({ stdin: { contents, loader: 'ts', resolveDir: path.dirname(path.join(root, file)) }, outfile, bundle: true, platform: 'node', format: 'cjs', alias: { electron: stub, '@shared': path.join(root, 'src/shared') }, logLevel: 'error' });
  return Object.assign(require(outfile), { __file: outfile });
}
function client(fetch, cookies = []) {
  const removed = [];
  global.__reviewSession = { fetch, cookies: {
    get: async ({ name }) => name === 'age_check_done' ? [{ name }] : cookies.filter(c => c.name === name),
    set: async () => {}, remove: async (url, name) => removed.push({ url, name })
  }};
  return { api: load('src/main/sites/dmm/client.ts'), removed };
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
try {
  await test('R2: domain, host and path isolation', async () => {
    const { api, removed } = client(async () => new Response('ok'), [
      { name: 'ec_session', domain: '.dmm.co.jp', path: '/', secure: true },
      { name: 'ec_session', domain: '.dmm.com', path: '/', secure: true },
      { name: 'ec_session', domain: 'book.dmm.com', path: '/other/', secure: true },
      { name: 'ec_session', domain: 'book.dmm.com', path: '/', secure: true }
    ]);
    await api.reviveDmmSession('https://book.dmm.com/library/');
    assert.deepEqual(removed, [{ url: 'https://book.dmm.com/', name: 'ec_session' }]);
  });
  for (const scenario of ['offline', '403', '503', 'html']) await test(`R3: ${scenario} leaves cookies untouched`, async () => {
    let requests = 0;
    const { api, removed } = client(async () => {
      requests++;
      if (scenario === 'offline') throw new Error('offline');
      return new Response(scenario === 'html' ? '<html>maintenance</html>' : '{}', { status: Number(scenario) || 200 });
    }, [{ name: 'ec_session', domain: 'www.dmm.co.jp', path: '/' }]);
    const result = await api.probeDmmLogin();
    assert(result.message); assert.equal(requests, 1); assert.equal(removed.length, 0);
  });
  await test('R4: concurrent callers wait for recovery and share failure', async () => {
    let release;
    const wait = new Promise(r => { release = r; });
    let calls = 0, secondDone = false;
    const { api } = client(async () => { calls++; await wait; return new Response('failure', { status: 503 }); });
    const first = api.reviveDmmSession();
    const second = api.reviveDmmSession().then(v => { secondDone = true; return v; });
    await new Promise(r => setImmediate(r));
    assert.equal(secondDone, false); assert.equal(calls, 1);
    release(); assert.equal(await first, false); assert.equal(await second, false);
    assert.equal(await api.reviveDmmSession(), false); assert.equal(calls, 1);
  });
  await test('R4: general and adult recovery have independent waits', async () => {
    const urls = [];
    const { api } = client(async url => { urls.push(url); return new Response('ok'); });
    await Promise.all([api.reviveDmmSession(), api.reviveDmmSession('https://book.dmm.com/library/')]);
    assert.equal(urls.length, 2);
  });
  await test('R8: retry reconstructs the CSRF header', async () => {
    let token = 0;
    const seen = [];
    const { api } = client(async (url, opts) => {
      if (url.endsWith('/csrf')) return new Response(`<meta name="csrf-token" content="token-${++token}">`);
      if (url.endsWith('/api')) {
        seen.push(opts.headers['X-CSRF-TOKEN']);
        return seen.length === 1 ? new Response('', { status: 401 }) : new Response('{"ok":true}');
      }
      return new Response('ok');
    });
    assert.deepEqual(await api.fetchJson('https://www.dmm.co.jp/api', { csrfPage: 'https://www.dmm.co.jp/csrf' }), { ok: true });
    assert.deepEqual(seen, ['token-1', 'token-2']);
  });
  await test('R7: exact HTTPS credential origins', async () => {
    const { credentialOriginAllowed: allowed } = load('src/main/auth/credentialOrigin.ts');
    assert(allowed('dmm', 'https://accounts.dmm.co.jp/service/login/password'));
    assert(allowed('dmm', 'https://accounts.dmm.com/service/login/password'));
    assert(allowed('dlsite', 'https://login.dlsite.com/login'));
    for (const url of ['http://accounts.dmm.com', 'https://accounts.dmm.com.evil.example', 'https://evil.example/?accounts.dmm.com', 'https://accounts.dmm.com:8443', 'https://u:p@accounts.dmm.com']) assert.equal(allowed('dmm', url), false, url);
  });
  await test('R1: failed trash preserves old and new bytes plus journal', async () => {
    const { safeReplace, ReplacementCleanupError } = load('src/main/safeReplace.ts');
    const old = path.join(work, 'original.bin'), incoming = path.join(work, 'incoming.bin');
    fs.writeFileSync(old, 'old bytes'); fs.writeFileSync(incoming, 'new bytes');
    let error;
    try { await safeReplace(incoming, old, [old], async () => { throw new Error('trash offline'); }); } catch (e) { error = e; }
    assert(error instanceof ReplacementCleanupError);
    assert.equal(fs.readFileSync(old, 'utf8'), 'new bytes');
    const journal = JSON.parse(fs.readFileSync(error.journal));
    assert.equal(fs.readFileSync(journal.entries[0].backup, 'utf8'), 'old bytes');
  });
  await test('R1: failed final rename rolls original back without disposing', async () => {
    const { safeReplace } = load('src/main/safeReplace.ts');
    const old = path.join(work, 'rollback.bin'); fs.writeFileSync(old, 'intact');
    let disposed = false;
    await assert.rejects(safeReplace(path.join(work, 'missing'), old, [old], async () => { disposed = true; }));
    assert.equal(fs.readFileSync(old, 'utf8'), 'intact'); assert.equal(disposed, false);
  });
  await test('R1: unrelated destination cannot be overwritten', async () => {
    const { safeReplace } = load('src/main/safeReplace.ts');
    const existing = path.join(work, 'unrelated.bin'), incoming = path.join(work, 'new.bin');
    fs.writeFileSync(existing, 'keep'); fs.writeFileSync(incoming, 'new');
    await assert.rejects(safeReplace(incoming, existing, [], async () => {}));
    assert.equal(fs.readFileSync(existing, 'utf8'), 'keep'); assert(fs.existsSync(incoming));
  });
  await test('R1: process interruption leaves recoverable original and journal', async () => {
    const api = load('src/main/safeReplace.ts');
    const old = path.join(work, 'crash.bin'), incoming = path.join(work, 'crash-new.bin');
    fs.writeFileSync(old, 'old durable bytes'); fs.writeFileSync(incoming, 'new durable bytes');
    const child = spawnSync(process.execPath, ['-e', 'const api=require(process.argv[1]); api.safeReplace(process.argv[2],process.argv[3],[process.argv[3]],async()=>process.exit(17)).catch(()=>process.exit(18));', api.__file, incoming, old], { windowsHide: true });
    assert.equal(child.status, 17);
    const journalName = fs.readdirSync(work).find(name => name.startsWith('crash.bin.replacement-'));
    const journal = JSON.parse(fs.readFileSync(path.join(work, journalName)));
    assert.equal(fs.readFileSync(journal.entries[0].backup, 'utf8'), 'old durable bytes');
    assert.equal(fs.readFileSync(old, 'utf8'), 'new durable bytes');
  });
  await test('R6: partial, oversized, empty and truncated ZIP files are rejected', async () => {
    const { verifyTransfer } = load('src/main/download/verifyTransfer.ts');
    const file = path.join(work, 'transfer.part');
    for (const size of [0, 99, 101]) {
      fs.writeFileSync(file, Buffer.alloc(size));
      await assert.rejects(verifyTransfer(file, 100, 'file.bin'));
      assert.equal(fs.statSync(file).size, size);
    }
    fs.writeFileSync(file, Buffer.alloc(100));
    assert.equal(await verifyTransfer(file, 100, 'file.bin'), 100);
    await assert.rejects(verifyTransfer(file, 100, 'file.zip'));
    // 分割一本のサイズは作品総容量と比較しない。
    assert.equal(await verifyTransfer(file, 100, 'file.zip.001'), 100);
  });
  for (const [file, method] of [['book', 'probeBookComLogin'], ['video', 'probeVideoLogin']]) {
    await test(`R9: ${file} transport failures are unknown, not logged out`, async () => {
      client(async () => { throw new Error('offline'); });
      const service = load(`src/main/sites/dmm/${file}.ts`);
      // 三状態（@shared/auth）。通信・権限の失敗は unknown のままで、未ログインへ倒さない
      const offline = await service[method]();
      assert.equal(offline.state, 'unknown'); assert.match(offline.message, /offline/);
      global.__reviewSession.fetch = async () => new Response('{}', { status: 403 });
      assert.equal((await service[method]()).state, 'unknown');
      global.__reviewSession.fetch = async () => new Response('{}', { status: 401 });
      assert.deepEqual(await service[method](), { state: 'unauthenticated', message: null });
    });
  }
  const registry = path.join(work, 'registry.cjs');
  fs.writeFileSync(registry, 'exports.getFloor = key => global.__reviewFloor(key);');
  for (const failures of [0, 1, 2]) await test(`R10: sync final status with ${failures}/2 failed floors`, async () => {
    const { SyncService } = load('src/main/sync/syncService.ts', { '../sites/registry': registry });
    global.__reviewFloor = key => ({ site: { siteId: 'test' }, floor: { floorId: key, label: key, fetchAll: async () => { if (Number(key) < failures) throw new Error('test error'); return []; } } });
    let saved;
    const sync = new SyncService({ startSyncRun: () => 1, syncState: () => ({ ids: new Set(), withLinks: new Set(), withSerial: new Set() }), upsertMany: () => ({ added: 0, updated: 0 }), finishSyncRun: (_id, status) => { saved = status; } });
    const events = []; sync.on('progress', p => events.push(p));
    const result = await sync.run(['0', '1']);
    assert.equal(saved, ['done', 'partial', 'error'][failures]); assert.equal(result.status, saved);
    assert.equal(Boolean(events.at(-1).error), failures > 0);
    assert.equal(sync.isRunning, false);
  });
  await test('R10: cancellation remains cancellation and the next run can succeed', async () => {
    const { SyncService } = load('src/main/sync/syncService.ts', { '../sites/registry': registry });
    const sync = new SyncService({ startSyncRun: () => 1, syncState: () => ({ ids: new Set(), withLinks: new Set(), withSerial: new Set() }), upsertMany: () => ({ added: 0, updated: 0 }), finishSyncRun: () => {} });
    let cancel = true;
    global.__reviewFloor = key => ({ site: { siteId: 'test' }, floor: { floorId: key, label: key, fetchAll: async () => { if (cancel) sync.cancel(); return []; } } });
    assert.equal((await sync.run(['0', '1'])).status, 'cancelled');
    cancel = false;
    assert.equal((await sync.run(['0', '1'])).status, 'done');
  });
  await test('R10: unknown floor and database read failure finish history and allow later floors', async () => {
    const { SyncService } = load('src/main/sync/syncService.ts', { '../sites/registry': registry });
    global.__reviewFloor = key => {
      if (key === 'unknown') throw new Error('unknown floor');
      return { site: { siteId: 'test' }, floor: { floorId: key, label: key, fetchAll: async () => [] } };
    };
    let saved;
    const sync = new SyncService({ startSyncRun: () => 1, syncState: (_site, floor) => {
      if (floor === 'db-error') throw new Error('database read failure');
      return { ids: new Set(), withLinks: new Set(), withSerial: new Set() };
    }, upsertMany: () => ({ added: 0, updated: 0 }), finishSyncRun: (_id, status) => { saved = status; } });
    const result = await sync.run(['unknown', 'db-error', 'valid']);
    assert.equal(saved, 'partial'); assert.equal(result.floors.length, 3);
    assert.match(result.floors[0].error, /unknown floor/);
    assert.match(result.floors[1].error, /database read failure/);
    assert.equal(result.floors[2].error, null); assert.equal(sync.isRunning, false);
    assert.equal((await sync.run(['valid'])).status, 'done');
  });
  console.log(`${passed} review regression cases passed`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
