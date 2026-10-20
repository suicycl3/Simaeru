/**
 * MCP サーバー（src/main/mcp/mcpServer.ts）を、公式 SDK のクライアントから呼んで確かめる。
 *   node tools/test-mcp.mjs
 * ライブラリは偽物（メモリの中）。待ち受けはこの PC の中（127.0.0.1）だけ。外へは通信しない。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { testBuild } from './test-support.mjs';

const build = testBuild();
let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
};

const work = (id, productId, extra = {}) => ({
  id, productId, title: `作品 ${id}`, siteId: 'dlsite', floorId: 'library', category: 'doujin', workType: 'voice', maker: 'サークルA',
  creators: [{ role: '声優', name: '声優A', id: null }], tags: ['癒し', '旧作'], purchasedAt: '2026-01-02', releasedAt: '2025-12-01',
  favoriteAt: null, viewedAt: null, hasLocalFile: false, description: '説明', priceText: '1,100円', fileSizeText: '100MB', ...extra
});
const works = [work(1, 'RJ00000001'), work(2, 'RJ00000002', { hasLocalFile: true })];

/** 今日から n 日前の購入日（この PC の時刻） */
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 12:00`;
};
const statsRow = (purchasedAt, tags) => ({ siteId: 'dlsite', workType: 'voice', purchasedAt, maker: 'サークルA', creators: [], tags });
const statsRows = [statsRow(daysAgo(0), ['癒し']), statsRow(daysAgo(13), ['癒し']), statsRow(daysAgo(14), ['耳かき']), statsRow(daysAgo(40), ['耳かき'])];

function fakeDeps() {
  const settings = new Map();
  const calls = { sent: [], favorite: [], used: [], enqueue: [], playlistAdd: [] };
  const playlists = [{ id: 7, name: '夜に聴く', count: 0, createdAt: 0, updatedAt: 0 }];
  const repo = {
    getSetting: (k) => settings.get(k) ?? null,
    setSetting: (k, v) => settings.set(k, v),
    getProduct: (id) => works.find((w) => w.id === id) ?? null,
    queryLibrary: (q) => {
      let items = works;
      if (q.searchFields?.includes('productId')) items = items.filter((w) => w.productId.toLowerCase().includes(q.search.toLowerCase()));
      else if (q.search) items = items.filter((w) => w.title.includes(q.search));
      if (q.localState === 'have') items = items.filter((w) => w.hasLocalFile);
      return { items, total: items.length };
    },
    playlistsOf: () => [],
    localFiles: () => [{ path: 'C:\\Lib\\RJ00000002.zip', kind: 'archive', sizeBytes: 123, missingAt: null }],
    tags: () => [{ tag: '癒し', count: 2 }, { tag: '旧作', count: 2 }],
    makers: () => [{ maker: 'サークルA', count: 2 }],
    creatorCounts: () => [{ role: '声優', name: '声優A', count: 2 }, { role: '作者', name: '作者B', count: 1 }],
    listPlaylists: () => playlists,
    getPlaylist: (id) => playlists.find((p) => p.id === id) ?? null,
    createPlaylist: (name) => { const p = { id: 8, name, count: 0, createdAt: 0, updatedAt: 0 }; playlists.push(p); return p; },
    addToPlaylist: (id, refs) => { calls.playlistAdd.push([id, refs]); return refs.length; },
    statsRows: () => statsRows,
    setFavorite: (id, on) => calls.favorite.push([id, on]),
    setUsed: (id, on) => calls.used.push([id, on])
  };
  const deps = {
    repo,
    downloads: { enqueue: async (ids) => { calls.enqueue.push(ids); return ids.length; }, list: () => [] },
    send: (channel, payload) => calls.sent.push([channel, payload]),
    hasWindow: () => true,
    focusWindow: () => {},
    isSyncRunning: () => false,
    metaStatus: () => ({ enabled: true, running: false, pending: 0, pausedReason: null })
  };
  return { deps, calls, settings };
}

const { McpService } = build.load('src/main/mcp/mcpServer.ts');
const { MCP_TOOLS } = build.load('src/shared/mcpTools.ts');
const port = 47000 + Math.floor(Math.random() * 1000);
const { deps, calls, settings } = fakeDeps();
settings.set('mcp.port', String(port));
const service = new McpService(deps);

/** SDK のクライアントで、鍵を付けてつなぐ */
async function connect(token = service.token) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  }));
  return client;
}
const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { error: !!r.isError, value: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
};
/** 生の HTTP で問い合わせる（見出しを自由に付けるため） */
const raw = (headers) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', reject);
  req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
});

try {
  await test('既定はオフ。オンにすると、この PC の中だけで待ち受ける', async () => {
    assert.equal(service.status().enabled, false);
    const s = await service.setEnabled(true);
    assert.equal(s.running, true);
    assert.equal(s.url, `http://127.0.0.1:${port}/mcp`);
    assert.ok(s.token.length >= 24, '鍵がある');
  });

  await test('鍵の無い・違う問い合わせ、ブラウザのページから（Origin 付き）、ほかの名前（Host）は断る', async () => {
    assert.equal(await raw({}), 401);
    assert.equal(await raw({ Authorization: 'Bearer wrong' }), 401);
    assert.equal(await raw({ Authorization: `Bearer ${service.token}`, Origin: 'https://example.com' }), 403);
    assert.equal(await raw({ Authorization: `Bearer ${service.token}`, Host: `evil.example:${port}` }), 403);
    await assert.rejects(connect('wrong'));
  });

  await test('道具の一覧', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['add_to_playlist', 'download_works', 'get_status', 'get_work', 'list_brands', 'list_people', 'list_playlists', 'list_tags',
      'purchase_stats', 'search_works', 'set_favorite', 'set_used', 'show_work', 'start_sync'].sort());
    // 設定の「MCP」タブに出す一覧（src/shared/mcpTools.ts）と同じ
    assert.deepEqual(MCP_TOOLS().map((t) => t.name).sort(), names);
    await client.close();
  });

  await test('検索・詳細: 属性のタグだけ・手元のファイルは名前だけ（場所は返さない）', async () => {
    const client = await connect();
    const found = await call(client, 'search_works', { downloaded: true });
    assert.equal(found.value.total, 1);
    assert.deepEqual(found.value.items[0].tags, ['癒し'], '旧作は属性ではないので出さない');
    assert.deepEqual(found.value.items[0].voiceActors, ['声優A']);
    const detail = await call(client, 'get_work', { work: 'rj00000002' });
    assert.equal(detail.value.id, 2);
    assert.deepEqual(detail.value.localFiles, [{ name: 'RJ00000002.zip', kind: 'archive', bytes: 123 }]);
    assert.ok(!JSON.stringify(detail.value).includes('C:\\\\Lib'), '場所は返さない');
    assert.equal((await call(client, 'get_work', { work: 'RJ99999999' })).error, true);
    assert.deepEqual((await call(client, 'list_tags')).value, [{ tag: '癒し', count: 2 }]);
    assert.deepEqual((await call(client, 'list_people', { role: '声優' })).value, [{ role: '声優', name: '声優A', count: 2 }]);
    await client.close();
  });

  await test('購入の統計: 直近の日数・日付の範囲で絞れる（今日を含む）', async () => {
    const client = await connect();
    const recent = await call(client, 'purchase_stats', { days: 14 });
    assert.equal(recent.value.total, 2, '14 日前は入らない');
    assert.equal(recent.value.period.to, daysAgo(0).slice(0, 10));
    assert.equal(recent.value.period.from, daysAgo(13).slice(0, 10));
    assert.deepEqual(recent.value.tags.map((t) => t.name), ['癒し']);
    assert.equal('risingTags' in recent.value, false, '比べる前の 12 か月に作品が無いので、割合が増えたタグは返さない');
    const ranged = await call(client, 'purchase_stats', { from: daysAgo(14).slice(0, 10), to: daysAgo(13).slice(0, 10) });
    assert.equal(ranged.value.total, 2);
    assert.equal((await call(client, 'purchase_stats', {})).value.total, 4);
    await client.close();
  });

  await test('操作: お気に入り・使った・プレイリストは画面にも知らせる。ダウンロードは積む・同期は画面に頼む', async () => {
    const client = await connect();
    await call(client, 'set_favorite', { work: 1, favorite: true });
    await call(client, 'set_used', { work: 'RJ00000001', used: true });
    assert.deepEqual(calls.favorite, [[1, true]]);
    assert.deepEqual(calls.used, [[1, true]]);
    assert.ok(calls.sent.some(([c, p]) => c === 'library:changed' && p.productRef === 1));
    const added = await call(client, 'add_to_playlist', { works: [1, 'RJ00000002', 'RJ404'], playlistName: '新しいリスト' });
    assert.equal(added.value.playlist.name, '新しいリスト');
    assert.deepEqual(added.value.notFound, ['RJ404']);
    assert.deepEqual(calls.playlistAdd, [[8, [1, 2]]]);
    const queued = await call(client, 'download_works', { works: [1, 2] });
    assert.equal(queued.value.queued, 2);
    assert.deepEqual(calls.enqueue, [[1, 2]]);
    const sync = await call(client, 'start_sync', {});
    assert.equal(sync.value.started, true);
    assert.ok(calls.sent.some(([c]) => c === 'mcp:startSync'));
    await call(client, 'show_work', { work: 2 });
    assert.ok(calls.sent.some(([c, p]) => c === 'mcp:showWork' && p.productRef === 2));
    await client.close();
  });

  await test('鍵を作り直すと、前の鍵は使えない。オフにすると待ち受けをやめる', async () => {
    const old = service.token;
    service.regenerateToken();
    assert.notEqual(service.token, old);
    assert.equal(await raw({ Authorization: `Bearer ${old}` }), 401);
    const s = await service.setEnabled(false);
    assert.equal(s.running, false);
    await assert.rejects(raw({ Authorization: `Bearer ${service.token}` }));
  });
} finally {
  await service.stop();
  build.close();
}
console.log(`OK ${passed}`);
