import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dlsite-split-test-'));
const root = path.resolve(import.meta.dirname, '..');
try {
  const outfile = path.join(temp, 'parse.cjs');
  buildSync({ entryPoints: [path.join(root, 'src/main/sites/dlsite/purchaseParse.ts')], outfile,
    bundle: true, platform: 'node', format: 'cjs',
    alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'error' });
  const { parseSplitPage } = require(outfile);
  // 実ページで確認した4パートのアンカー構造（アカウント情報なし）。
  const anchor = (n, id = 'RJ400001') => `<a href="https://www.dlsite.com/home/download/=/number/${n}/product_id/${id}.html" class="btn_dl split" title="ダウンロード">ダウンロード</a>`;
  const parts = parseSplitPage([1, 2, 3, 4].map(n => anchor(n)).join('\n'), 'RJ400001');
  assert.equal(parts.length, 4);
  assert.ok(parts.every(p => p.kind === 'download'));
  assert.deepEqual(parts.map(p => p.label), [1, 2, 3, 4].map(n => `分割ダウンロード ${n}`));
  assert.deepEqual(parseSplitPage(anchor(4) + anchor(2) + anchor(1) + anchor(3) + anchor(2), 'RJ400001'), parts);
  assert.deepEqual(parseSplitPage(anchor(1, 'RJ999999') + '<a href="/home/download/split/=/product_id/RJ400001.html">案内</a><a href="https://example.com/home/download/=/number/1/product_id/RJ400001.html">広告</a>', 'RJ400001'), []);
  const relative = parseSplitPage("<a class='btn_dl split' href='/home/download/=/number/10/product_id/RJ400001.html?a=1&amp;b=2'>DL</a>" + anchor(2), 'RJ400001');
  assert.equal(relative[0].label, '分割ダウンロード 2');
  assert.ok(relative[1].url.endsWith('?a=1&b=2'));
  assert.deepEqual(parseSplitPage('<html>ログイン</html>', 'RJ400001'), []);
  // 取得済みの実ページを MYLIBRARY_SPLIT_CAPTURE で渡せば、同じ4本になることも確認する。
  const captured = process.env.MYLIBRARY_SPLIT_CAPTURE ?? '';
  if (fs.existsSync(captured)) assert.deepEqual(parseSplitPage(fs.readFileSync(captured, 'utf8'), 'RJ400001'), parts);
  const stub = path.join(temp, 'electron.cjs');
  fs.writeFileSync(stub, 'module.exports = { app: {}, BrowserWindow: class {}, session: {}, shell: {} };');
  const managerFile = path.join(temp, 'manager.cjs');
  buildSync({ entryPoints: [path.join(root, 'src/main/download/downloadManager.ts')], outfile: managerFile,
    bundle: true, platform: 'node', format: 'cjs',
    alias: { electron: stub, '@shared': path.join(root, 'src/shared') }, logLevel: 'error' });
  const { DownloadManager } = require(managerFile);
  const product = { id: 1, floorId: 'library', hasLocalFile: false, links: [
    { kind: 'page', label: '分割ダウンロード', url: 'https://www.dlsite.com/home/download/split/=/product_id/RJ400001.html' }
  ] };
  let rows = [{ id: 1, productRef: 1, label: 'ダウンロード導線が見つかりません', state: 'error', linkKind: 'main', linkIndex: 0 }];
  let nextId = 2;
  const manager = new DownloadManager({ repo: {
    setChildIds: () => [], getProduct: () => product, listDownloads: () => rows,
    deleteDownload: id => { rows = rows.filter(row => row.id !== id); },
    upsertDownload: row => {
      const old = rows.find(r => r.productRef === row.productRef && r.linkKind === row.linkKind && r.linkIndex === row.linkIndex);
      if (old) Object.assign(old, row); else rows.push({ id: nextId++, ...row });
    }
  }, fetchDetail: async () => { product.links.push(...parts); }, onProgress: () => {} });
  manager.pump = () => {}; // 通信せずキューへの登録だけを検証する。
  manager.notify = () => {};
  assert.equal(await manager.enqueue([1]), 4);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(row => row.linkIndex), [0, 1, 2, 3]);
  assert.ok(rows.every(row => row.state === 'queued' && row.linkKind === 'split'));
  console.log('OK: DLsite split links (4 parts, ordering, duplicates, relative URLs, unrelated links)');
  console.log('OK: failed placeholder replaced by all 4 queued downloads');

  // 実際の library IPC の DLsite 分岐を通す（詳細取得を差し替えずに、案内リンクから分割パートが保存されるか）
  const handlers = new Map();
  let splitRequested = null;
  global.__splitIpc = {
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    fetchSplitLinks: async workno => { splitRequested = workno; return parts; },
    fetchSerialInfo: async () => null,
    fetchDlsiteStoreMeta: async () => null,
    refreshCompilations: async () => ({ count: 0, needed: [] }),
    htmlToText: text => text ?? '', openExternalWeb: async () => {}
  };
  const ipcStub = path.join(temp, 'ipc-stub.cjs');
  fs.writeFileSync(ipcStub, 'module.exports=global.__splitIpc');
  const librarySource = fs.readFileSync(path.join(root, 'src/main/ipc/library.ts'), 'utf8')
    .replace(/from '(\.\.\/[^']+)'/g, `from ${JSON.stringify(ipcStub)}`);
  const libraryFile = path.join(temp, 'library.cjs');
  buildSync({ stdin: { contents: librarySource, loader: 'ts', resolveDir: path.join(root, 'src/main/ipc') }, outfile: libraryFile,
    bundle: true, platform: 'node', format: 'cjs', alias: { electron: ipcStub, '@shared': path.join(root, 'src/shared') }, logLevel: 'error' });
  const stored = {
    id: 2, siteId: 'dlsite', floorId: 'library', category: 'doujin', productId: 'RJ400001', contentId: null,
    title: '分割作品', maker: null, makerId: null, authors: [], creators: [], genre: null, productType: null,
    purchasedAt: null, purchasedAtSource: null, releasedAt: null, description: null, coverUrl: null,
    detailUrl: 'https://www.dlsite.com/home/work/=/product_id/RJ400001.html', fileSizeText: null, fileSizeBytes: null,
    isDownloadable: false, isStreaming: false, isUnavailable: false, hasDrm: false, tags: [], serialKey: null,
    metaFetchedAt: null, hasLocalFile: false,
    links: [{ kind: 'page', label: '分割ダウンロード', url: 'https://www.dlsite.com/home/download/split/=/product_id/RJ400001.html' }]
  };
  let marked = 0;
  require(libraryFile).registerLibraryIpc({
    repo: {
      getProduct: () => stored,
      upsertProduct: input => Object.assign(stored, input),
      markMetaFetched: () => { marked++; },
      getSetting: () => '0'
    },
    send: () => {}
  });
  const result = await handlers.get('library:detail')(null, 2, { force: true });
  assert.equal(result.kind, 'dlsite');
  assert.equal(result.detailError, null);
  assert.equal(splitRequested, 'RJ400001');
  assert.equal(marked, 1);
  // 案内（page）は再取得用に残し、パート4本が download として保存される
  assert.deepEqual(stored.links.filter(l => l.kind === 'download'), parts);
  assert.ok(stored.links.some(l => l.kind === 'page' && l.url.includes('/home/download/split/')));
  assert.equal(stored.isDownloadable, true);
  const { downloadableLinks } = require(managerFile);
  assert.deepEqual(downloadableLinks(stored).map(l => l.url), parts.map(l => l.url));
  // 未ログインだと DLsite は案内ページを 404 で返す。作品が消えたと読めない文言にする
  const purchasesStub = path.join(temp, 'purchases-stub.cjs');
  global.__splitClient = { getWwwHtml: async () => { throw new Error('GET https://www.dlsite.com/home/download/split/=/product_id/RJ400001.html failed: HTTP 404'); }, politeDelay: async () => {} };
  fs.writeFileSync(purchasesStub, 'module.exports=global.__splitClient');
  const purchasesSource = fs.readFileSync(path.join(root, 'src/main/sites/dlsite/purchases.ts'), 'utf8')
    .replace(/from '\.\/client'/g, `from ${JSON.stringify(purchasesStub)}`);
  const purchasesFile = path.join(temp, 'purchases.cjs');
  buildSync({ stdin: { contents: purchasesSource, loader: 'ts', resolveDir: path.join(root, 'src/main/sites/dlsite') }, outfile: purchasesFile,
    bundle: true, platform: 'node', format: 'cjs', alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'error' });
  await assert.rejects(require(purchasesFile).fetchSplitLinks('RJ400001'), err => {
    assert.match(err.message, /RJ400001/);
    assert.doesNotMatch(err.message, /HTTP 404/);
    return true;
  });
  console.log('OK: unauthenticated 404 on the split page reports sign-in or withdrawal, not a bare 404');

  console.log('OK: library IPC turns the split guide page into four downloadable parts');
} finally {
  delete global.__splitIpc;
  delete global.__splitClient;
  fs.rmSync(temp, { recursive: true, force: true });
}
