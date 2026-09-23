import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mylibrary-ipc-'));
const require = createRequire(import.meta.url);
const handlers = new Map();
const listeners = new Map();
const rendererLogs = [];
let saveDialogResult = { canceled: true };
const invoke = (name, ...args) => handlers.get(name)(null, ...args);
/** adapter が返す三状態（@shared/auth の AuthResult）。 */
const authenticated = { state: 'authenticated', message: null };
const unauthenticated = { state: 'unauthenticated', message: null };
const unknown = (message) => ({ state: 'unknown', message });
let probe = authenticated, serviceProbe = authenticated, loginCallback;
const authEvents = [];
const site = { siteId: 'dmm', label: 'DMM', probeLogin: async () => probe };
global.__ipcTest = {
  ipcMain: {
    handle: (name, callback) => { assert(!handlers.has(name), `duplicate ${name}`); handlers.set(name, callback); },
    on: (name, callback) => { assert(!listeners.has(name), `duplicate ${name}`); listeners.set(name, callback); }
  },
  dialog: { showSaveDialog: async () => saveDialogResult, showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  app: { getVersion: () => '0.0.0-test', getPath: () => work, getAppPath: () => root },
  // アプリログ（src/main/log.ts）の差し替え
  readLog: () => '記録の中身\n', logFromRenderer: (level, message) => rendererLogs.push([level, message]),
  shell: { openExternal: async () => {}, trashItem: async () => {} },
  SITES: [site], getSite: () => site,
  listFloors: sites => [{ enabled: sites.has('dmm') }],
  openLoginWindow: (_site, callback) => { loginCallback = callback; },
  clearSiteSession: async () => {}, isSecureStorageAvailable: () => true,
  recordAuth: event => authEvents.push(event), authDiagnostics: () => '{}',
  DMM_LOGIN_TARGETS: {}, probeVideoLogin: async () => serviceProbe, probeBookComLogin: async () => serviceProbe,
  // 総集編の組み立ては通信・DBを伴うので、登録の契約だけを見る
  refreshCompilations: async () => ({ count: 0, needed: [] }), updateCatalog: async () => 0,
  catalogKeyOf: () => null, compilationCandidates: () => [], COMPILATION_GUESS_SETTING: 'compilation.guess',
  htmlToText: text => text ?? '', openExternalWeb: async () => {}
};
const stub = path.join(work, 'stub.cjs');
fs.writeFileSync(stub, 'module.exports=global.__ipcTest');
/** ipc モジュール以外の依存はすべて差し替え、登録と委譲だけを見る。 */
function load(name) {
  let contents = fs.readFileSync(path.join(root, `src/main/ipc/${name}.ts`), 'utf8');
  contents = contents.replace(/from '(\.\.\/[^']+)'/g, `from ${JSON.stringify(stub)}`);
  const outfile = path.join(work, `${name}.cjs`);
  buildSync({ stdin: { contents, loader: 'ts', resolveDir: path.join(root, 'src/main/ipc') }, outfile,
    bundle: true, platform: 'node', format: 'cjs', alias: { electron: stub, '@shared': path.join(root, 'src/shared') }, logLevel: 'error' });
  return require(outfile);
}
const channels = prefix => [...handlers.keys()].filter(k => k.startsWith(prefix)).sort();
try {
  const sent = [], resets = [];
  const repo = { countGeneralBooks: () => 1, floorCounts: () => [{ floorKey: 'dmm:book', count: 3 }],
    resetMetaAttempts: id => resets.push(id), syncHistory: () => ['history'], lastSuccessfulSyncAt: () => 'last' };
  const credentials = { list: () => [], get: id => ({ siteId: id }), reveal: () => null, save: () => {}, clear: () => {} };
  const auth = load('auth').registerAuthIpc({ repo, credentials, send: (...args) => sent.push(args) });
  assert.deepEqual([...handlers.keys()].sort(), ['app:info', 'auth:status', 'auth:diagnostics', 'auth:login', 'auth:logout',
    'credentials:list', 'credentials:get', 'credentials:reveal', 'credentials:save', 'credentials:clear', 'library:floors'].sort());
  assert.equal((await invoke('library:floors')).floors[0].enabled, true);
  assert.deepEqual(auth.loggedInSites(), ['dmm']);
  const copy = auth.loggedInSites(); copy.length = 0;
  assert.deepEqual(auth.loggedInSites(), ['dmm']);
  // 確定結果には文言を付けず、サービス側も三状態のまま境界で変換する
  const [okStatus] = await invoke('auth:status');
  assert.equal(okStatus.message, null); assert.equal(okStatus.uncertain, false);
  assert.deepEqual(okStatus.services, { video: true, bookCom: true });

  // 判定できなかったときは前回値を保ち、理由は説明文にして返す
  probe = unknown('offline'); serviceProbe = unknown('offline');
  authEvents.length = 0;
  const [status] = await invoke('auth:status');
  assert.equal(status.uncertain, true); assert.equal(status.loggedIn, true);
  assert.deepEqual(status.services, { video: null, bookCom: null });
  assert.notEqual(status.message, null);
  assert.match(status.message, /DMM/); assert.match(status.message, /offline/);
  assert.deepEqual(authEvents.map(e => `${e.service}:${e.state}`), ['dmm:unknown', 'video:unknown', 'bookCom:unknown']);
  assert.deepEqual(auth.loggedInSites(), ['dmm']);

  // 確定した未ログインだけがログイン済みを解除する
  probe = unauthenticated; serviceProbe = unauthenticated;
  const [loggedOut] = await invoke('auth:status');
  assert.equal(loggedOut.loggedIn, false); assert.equal(loggedOut.uncertain, false); assert.equal(loggedOut.message, null);
  assert.deepEqual(loggedOut.services, { bookCom: false });
  assert.deepEqual(auth.loggedInSites(), []);
  // 未ログインを覚えているので、次に判定できなくても未ログインのまま
  probe = unknown('offline');
  const [stillOut] = await invoke('auth:status');
  assert.equal(stillOut.loggedIn, false); assert.equal(stillOut.uncertain, true);

  assert.equal(await invoke('auth:diagnostics'), null);
  await invoke('auth:logout', 'dmm'); assert.deepEqual(auth.loggedInSites(), []);
  await invoke('auth:login', 'dmm'); loginCallback(authenticated);
  assert.deepEqual(auth.loggedInSites(), ['dmm']); assert.deepEqual(resets, ['dmm']);
  assert.deepEqual(sent.at(-1), ['auth:changed', { siteId: 'dmm', loggedIn: true, service: null, uncertain: false }]);
  // ログイン窓が判定できずに閉じたときは、覚えている値を変えない
  await invoke('auth:login', 'dmm'); loginCallback(unknown('offline'));
  assert.deepEqual(auth.loggedInSites(), ['dmm']);
  assert.deepEqual(sent.at(-1), ['auth:changed', { siteId: 'dmm', loggedIn: true, service: null, uncertain: true }]);
  assert.deepEqual(invoke('credentials:get', 'dmm'), { siteId: 'dmm' });
  console.log('PASS auth IPC channels, three-state result, boundary message, floor gating, login/logout and crawler state');

  let after = 0, cancelled = 0, called;
  const summary = { status: 'partial', floors: [] };
  const sync = { isRunning: false, run: async (...args) => { called = args; return summary; }, cancel: () => cancelled++ };
  load('sync').registerSyncIpc({ repo, sync, afterSync: () => after++ });
  assert.deepEqual(channels('sync:'), ['sync:history', 'sync:start', 'sync:cancel', 'sync:lastAt'].sort());
  assert.equal(await invoke('sync:start', ['dmm:book'], { full: true }), summary);
  assert.deepEqual(called, [['dmm:book'], { full: true }]); assert.equal(after, 1);
  sync.isRunning = true; await assert.rejects(invoke('sync:start', [])); assert.equal(after, 1);
  assert.equal(invoke('sync:cancel'), true); assert.equal(cancelled, 1);
  assert.deepEqual(invoke('sync:history'), ['history']); assert.equal(invoke('sync:lastAt'), 'last');
  console.log('PASS sync IPC channels, arguments, result, busy rejection and post-sync hook');

  // ── ライブラリ・ダウンロード・ジョブ ──
  const queries = [];
  const libraryRepo = {
    queryLibrary: q => { queries.push(q); return { items: [], total: 0 }; },
    queryLibraryIds: q => { queries.push(q); return [7]; },
    makers: () => ['maker'], tags: () => ['tag'], workTypeCounts: () => ['workType'],
    categoryCounts: () => ['category'], siteCounts: () => ['site'], favoriteCount: () => 2, usedCount: () => 3, localCounts: () => ({ have: 1 }),
    getProduct: id => ({ id }), markViewed: () => {}, setFavorite: () => ({ id: 1, favoriteAt: 1 }),
    setUsed: (id, used) => { queries.push(['setUsed', id, used]); },
    getSetting: () => '0', setSetting: () => {}, autoUsed: () => true, setAutoUsed: on => { queries.push(['setAutoUsed', on]); }, compilationOf: () => ({ entries: [], containedIn: [], catalog: null })
  };
  const library = load('library').registerLibraryIpc({ repo: libraryRepo, send: (...args) => sent.push(args) });
  assert.deepEqual(channels('library:').filter(k => k !== 'library:floors'), ['library:query', 'library:queryIds', 'library:makers',
    'library:tags', 'library:workTypes', 'library:facets', 'library:product', 'library:compilation', 'library:compilationGuess',
    'library:setCompilationGuess', 'library:compilationCandidates', 'library:setCompilationOverride', 'library:refreshCatalog',
    'library:openCompilationItem', 'library:markViewed', 'library:setFavorite', 'library:setUsed', 'library:autoUsed', 'library:setAutoUsed',
    'library:detail', 'library:files'].sort());
  assert.deepEqual(typeof library.fetchDetail, 'function');
  assert.deepEqual(typeof library.scheduleCompilations, 'function');
  assert.deepEqual(typeof library.runCompilations, 'function');
  // 引数が無い呼び出しでも空条件として扱う（rendererの既定）
  assert.deepEqual(invoke('library:query'), { items: [], total: 0 });
  assert.deepEqual(invoke('library:queryIds'), [7]);
  assert.deepEqual(queries, [{}, {}]);
  assert.deepEqual(invoke('library:facets'), { categories: ['category'], sites: ['site'], favorites: 2, used: 3, local: { have: 1 } });
  assert.deepEqual(invoke('library:product', 5), { id: 5 });
  // ♡「使った」は、付け外ししたあとの作品を返す（一覧のカードをその場で差し替えるため）
  assert.deepEqual(invoke('library:setUsed', 5, true), { id: 5 });
  assert.deepEqual(queries.at(-1), ['setUsed', 5, true]);
  // 閲覧で自動的に「使った」にするかの設定（既定はオン）
  assert.equal(invoke('library:autoUsed'), true);
  assert.equal(invoke('library:setAutoUsed', false), true); // 偽の repo は常に true を返す
  assert.deepEqual(queries.at(-1), ['setAutoUsed', false]);
  console.log('PASS library IPC channels, default arguments and repository delegation');

  // ── プレイリスト ──
  const playlistCalls = [];
  const lists = [{ id: 1, name: 'あとで', count: 0, createdAt: 1, updatedAt: 1 }];
  const playlistRepo = {
    listPlaylists: () => lists,
    getPlaylist: id => lists.find(p => p.id === id) ?? null,
    createPlaylist: name => { playlistCalls.push(['create', name]); return lists[0]; },
    renamePlaylist: (id, name) => { playlistCalls.push(['rename', id, name]); },
    deletePlaylist: id => { playlistCalls.push(['delete', id]); },
    addToPlaylist: (id, refs) => { playlistCalls.push(['add', id, refs]); return refs.length; },
    removeFromPlaylist: (id, refs) => { playlistCalls.push(['remove', id, refs]); return refs.length; },
    playlistsOf: ref => { playlistCalls.push(['of', ref]); return lists; }
  };
  load('playlists').registerPlaylistsIpc({ repo: playlistRepo, send: (...args) => sent.push(args) });
  assert.deepEqual(channels('playlists:'), ['playlists:list', 'playlists:create', 'playlists:rename', 'playlists:delete',
    'playlists:add', 'playlists:remove', 'playlists:of'].sort());
  assert.deepEqual(invoke('playlists:list'), lists);
  // 作るときに作品を渡したら、そのまま入れる
  assert.deepEqual(invoke('playlists:create', ' あとで ', [3, 4]), lists[0]);
  assert.deepEqual(playlistCalls, [['create', 'あとで'], ['add', 1, [3, 4]]]);
  // 名前が空なら作らない
  assert.throws(() => invoke('playlists:create', '  '));
  assert.equal(invoke('playlists:add', 1, [5]), 1);
  assert.equal(invoke('playlists:remove', 1, [5]), 1);
  // 変わったことは一覧つきで知らせる（サイドバーと小窓がすぐ揃う）
  assert.deepEqual(sent.at(-1), ['playlists:changed', { playlists: lists }]);
  invoke('playlists:rename', 1, '後で見る'); invoke('playlists:delete', 1);
  assert.deepEqual(playlistCalls.slice(-4), [['add', 1, [5]], ['remove', 1, [5]], ['rename', 1, '後で見る'], ['delete', 1]]);
  console.log('PASS playlist IPC channels, 作成時の同時追加、空名の拒否と変更通知');

  const downloadCalls = [];
  const settings = { root: 'D:/lib', concurrency: 1 };
  const downloads = {
    enqueue: ids => { downloadCalls.push(['enqueue', ids]); return 2; },
    enqueueVideo: (id, quality) => { downloadCalls.push(['enqueueVideo', id, quality]); return 1; },
    redownload: () => 1, list: () => ['row'], estimate: () => ({ products: 1 }),
    pause: () => {}, resume: () => {}, cancel: () => {}, retry: () => {}, remove: () => {},
    resumeAll: () => 3, pauseAll: () => 4, clearFinished: () => 5,
    settings: () => settings, saveSettings: next => { downloadCalls.push(['saveSettings', next]); }
  };
  load('downloads').registerDownloadsIpc({ downloads, getWindow: () => null });
  assert.deepEqual(channels('download:'), ['download:enqueue', 'download:enqueueVideo', 'download:redownload', 'download:list',
    'download:estimate', 'download:pause', 'download:resume', 'download:cancel', 'download:retry', 'download:remove',
    'download:resumeAll', 'download:pauseAll', 'download:clearFinished', 'download:settings', 'download:saveSettings',
    'download:pickRoot'].sort());
  assert.equal(invoke('download:enqueue', [1, 2]), 2);
  assert.equal(invoke('download:enqueueVideo', 3, 'q:6000'), 1);
  assert.deepEqual(invoke('download:saveSettings', { concurrency: 2 }), settings);
  // 保存先の選択を取り消したら、設定は変えずに現在値を返す
  assert.equal(await invoke('download:pickRoot'), settings);
  assert.deepEqual(downloadCalls, [['enqueue', [1, 2]], ['enqueueVideo', 3, 'q:6000'], ['saveSettings', { concurrency: 2 }]]);
  console.log('PASS download IPC channels, delegation and cancelled folder choice');

  const jobCalls = [];
  const jobSettings = { autoExtract: true }, jobTools = { sevenZip: '7z.exe' };
  const jobs = {
    list: () => ['job'], settings: () => jobSettings, tools: () => jobTools,
    saveSettings: next => { jobCalls.push(['saveSettings', next]); },
    cancel: id => jobCalls.push(['cancel', id]), retry: id => jobCalls.push(['retry', id]), remove: id => jobCalls.push(['remove', id]),
    forProduct: id => [id]
  };
  load('jobs').registerJobsIpc({ repo: libraryRepo, jobs, getWindow: () => null, filesChanged: () => {} });
  assert.deepEqual(channels('jobs:'), ['jobs:list', 'jobs:settings', 'jobs:saveSettings', 'jobs:pickTool', 'jobs:extract',
    'jobs:flacEstimate', 'jobs:flac', 'jobs:lossyOnly', 'jobs:stripPdf', 'jobs:cancel', 'jobs:retry', 'jobs:remove',
    'jobs:forProduct', 'jobs:removeExtracted'].sort());
  assert.deepEqual(invoke('jobs:list'), ['job']);
  assert.deepEqual(invoke('jobs:settings'), { settings: jobSettings, tools: jobTools });
  assert.deepEqual(invoke('jobs:saveSettings', { autoFlac: false }), { settings: jobSettings, tools: jobTools });
  // ツールの選択を取り消したら保存しない
  assert.deepEqual(await invoke('jobs:pickTool', 'sevenZip'), { settings: jobSettings, tools: jobTools });
  assert.deepEqual(jobCalls, [['saveSettings', { autoFlac: false }]]);
  console.log('PASS job IPC channels, settings round trip and cancelled tool choice');

  // ── 分割後の登録漏れ・二重登録を、ソース全体で確かめる ──
  // ── アプリログの書き出し ─────────────────────────────
  load('app').registerAppIpc({ repo: { setSetting: () => {} }, getWindow: () => null });
  // app:info は認証モジュールが登録している（先に読み込んでいる）
  assert.deepEqual(channels('app:').sort(), ['app:about', 'app:info', 'app:saveLog', 'app:setLanguage'].sort());

  // 取り消したらファイルを作らない
  saveDialogResult = { canceled: true };
  assert.equal(await invoke('app:saveLog'), null);

  // 保存先を選んだら、版・環境の見出しつきで書き出す
  const logFile = path.join(work, 'app-log.txt');
  saveDialogResult = { canceled: false, filePath: logFile };
  assert.equal(await invoke('app:saveLog'), logFile);
  const written = fs.readFileSync(logFile, 'utf8');
  assert.match(written, /0\.0\.0-test/, 'アプリの版を書き出しに含める');
  assert.match(written, /userData:/, '置き場所を書き出しに含める');
  assert.match(written, /記録の中身/, '記録そのものを書き出しに含める');

  // 画面側の記録も同じ記録に残す
  listeners.get('app:log')(null, 'warn', '画面のエラー');
  assert.deepEqual(rendererLogs, [['warn', '画面のエラー']]);

  const sources = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) sources.push(full);
    }
  };
  walk(path.join(root, 'src/main'));
  const owner = new Map();
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)) {
      const previous = owner.get(match[1]);
      assert.equal(previous, undefined, `duplicate handler ${match[1]} in ${path.relative(root, file)} and ${previous}`);
      owner.set(match[1], path.relative(root, file));
    }
  }
  const preload = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8');
  const invoked = [...preload.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map(m => m[1]);
  const missing = [...new Set(invoked)].filter(channel => !owner.has(channel));
  assert.deepEqual(missing, [], `preload invokes channels with no handler: ${missing.join(', ')}`);
  assert(owner.size >= invoked.length, 'every invoked channel must be registered once');
  console.log(`PASS ${owner.size} channels registered once across ${sources.length} main sources, all preload channels handled`);
} finally {
  delete global.__ipcTest;
  fs.rmSync(work, { recursive: true, force: true });
}
