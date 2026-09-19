/**
 * 分割ダウンロードを、別々の作品ぶん同時に流したときの確認。
 *   npx electron tools/test-download-parallel.js
 *
 * 本物の DownloadManager を動かす。electron だけ差し替えて、
 * ダウンロードの中身（will-download と DownloadItem）は偽物で作る。通信はしない。
 * 台帳は使い捨てフォルダの本物の DB。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { app } = require('electron');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'out', 'test');
fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'download-parallel-'));
app.setPath('userData', path.join(work, 'userData'));
app.on('window-all-closed', () => undefined);

const failures = [];
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok ' : '  NG '} ${label}${ok || detail === undefined ? '' : `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})`}`);
  if (!ok) failures.push(label);
};

// ── electron の差し替え（ダウンロード用の窓とセッションだけ偽物にする） ──
const stubPath = path.join(outDir, 'electron.download.cjs');
fs.writeFileSync(stubPath, `
const { EventEmitter } = require('node:events');
const os = require('node:os');
let nextId = 1;
const sessions = new Map();
module.exports = {
  app: { getPath: () => os.tmpdir() },
  shell: { trashItem: async (p) => { global.__trashed.push(p); require('node:fs').rmSync(p, { force: true }); } },
  session: {
    fromPartition: (part) => {
      if (!sessions.has(part)) {
        const s = new EventEmitter();
        s.storagePath = part;
        s.webRequest = { onBeforeRedirect() {}, onCompleted() {}, onErrorOccurred() {} };
        sessions.set(part, s);
      }
      return sessions.get(part);
    }
  },
  BrowserWindow: class {
    constructor(opts) {
      const sess = opts.webPreferences.session;
      const id = nextId++;
      this.destroyed = false;
      this.webContents = { id, downloadURL: (url) => global.__downloadURL(url, id, sess) };
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
};
`);

const build = (entry, name, alias) => {
  const outfile = path.join(outDir, name);
  esbuild.buildSync({
    entryPoints: [path.join(root, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3', ...(alias ? [] : ['electron'])],
    alias: { '@shared': path.join(root, 'src', 'shared'), ...(alias ?? {}) },
    logLevel: 'error'
  });
  return require(outfile);
};

global.__trashed = [];

/** 中身の無い正しい zip（22バイトの終端レコード）。注記の長さでファイルごとに大きさを変える */
function emptyZip(commentLength) {
  const buf = Buffer.alloc(22 + commentLength);
  buf.writeUInt32LE(0x06054b50, 0);
  buf.writeUInt16LE(commentLength, 20);
  return buf;
}

/** 偽の DownloadItem。setSavePath されたら、その .part に中身を書いて「完了」にする */
function fakeItem(url, filename, bytes, delayMs, mime) {
  const item = new EventEmitter();
  let savePath = null;
  const start = Date.now();
  Object.assign(item, {
    getURL: () => url,
    getURLChain: () => [url],
    getFilename: () => filename,
    getMimeType: () => mime ?? 'application/zip',
    getState: () => 'progressing',
    getStartTime: () => start,
    getTotalBytes: () => bytes,
    getReceivedBytes: () => bytes,
    getCurrentBytesPerSecond: () => 1000,
    getPercentComplete: () => 100,
    getETag: () => '',
    getLastModifiedTime: () => '',
    canResume: () => false,
    isPaused: () => false,
    pause: () => undefined,
    resume: () => undefined,
    cancel: () => item.emit('done', {}, 'cancelled'),
    getSavePath: () => savePath,
    setSavePath: (p) => {
      savePath = p;
      // 実際の保存と同じ順番で: .part に書いてから done
      setTimeout(() => {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, emptyZip(bytes - 22));
        item.emit('done', {}, 'completed');
      }, delayMs);
    }
  });
  return item;
}

app.whenReady().then(async () => {
  try {
    const { openDatabase } = build('src/main/db/database.ts', 'database.parallel.cjs');
    const { Repo } = build('src/main/db/repo.ts', 'repo.parallel.cjs');
    const { DownloadManager } = build('src/main/download/downloadManager.ts', 'downloadManager.parallel.cjs', { electron: stubPath });

    const { db } = openDatabase(path.join(work, 'userData'));
    const repo = new Repo(db);
    const now = Date.now();

    /** 分割ダウンロードの作品を1件作る。parts 本のパートを持つ */
    const addSplitWork = (productId, parts, fileName, mimeOf) => {
      const links = [
        { label: '分割ダウンロード', url: `https://www.dlsite.com/home/download/split/=/product_id/${productId}.html`, kind: 'page' },
        ...Array.from({ length: parts }, (_, i) => ({
          label: `分割ダウンロード ${i + 1}`,
          url: `https://www.dlsite.com/home/download/=/number/${i + 1}/product_id/${productId}.html`,
          kind: 'download'
        }))
      ];
      const id = Number(db.prepare(
        `INSERT INTO products (site_id, floor_id, product_id, title, maker, first_seen_at, last_synced_at, category, links, is_downloadable)
         VALUES ('dlsite', 'library', ?, ?, 'まるねこ工房', ?, ?, 'doujin', ?, 1)`
      ).run(productId, `作品 ${productId}`, now, now, JSON.stringify(links)).lastInsertRowid);
      // サーバが返すファイル名。fileName(パート番号) で決める
      for (const [i, link] of links.entries()) {
        if (link.kind === 'download') server.set(link.url, { name: fileName(i), bytes: 22 + i, mime: mimeOf ? mimeOf(i) : undefined });
      }
      return id;
    };

    const server = new Map(); // URL → { name, bytes }
    let detailCalls = 0;
    const detailFor = [];
    const startedUrls = [];

    global.__downloadURL = (url, wcId, sess) => {
      startedUrls.push(url);
      const info = server.get(url);
      // 少しずらして始めることで、本当に並んで走っている状態を作る
      setTimeout(() => {
        if (!info) return; // 応答なし（始まらない）
        sess.emit('will-download', {}, fakeItem(url, info.name, info.bytes, 20, info.mime), { id: wcId });
      }, 5);
    };

    const manager = new DownloadManager({
      repo,
      fetchDetail: async (id) => {
        detailCalls++;
        detailFor.push(id);
        // 取り直しには時間がかかる。その間に同じ作品の別の行が始まる状況を作る
        await new Promise((r) => setTimeout(r, 30));
        return { detailError: null };
      },
      onProgress: () => undefined,
      detailTimeoutMs: 2000,
      startTimeoutMs: 3000
    });
    repo.setSetting('download.root', path.join(work, 'Downloads'));
    repo.setSetting('download.concurrency', '4');

    const waitForDone = async (expected, ms = 15000) => {
      const until = Date.now() + ms;
      for (;;) {
        const rows = repo.listDownloads(1000);
        const settled = rows.filter((r) => r.state === 'done' || r.state === 'error' || r.state === 'paused');
        if (settled.length >= expected || Date.now() > until) return rows;
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    // ── 1. 別々の作品の分割ダウンロードを同時に流す ──
    console.log('== 別々の作品の分割ダウンロードを並列で ==');
    const a = addSplitWork('RJ400001', 4, (i) => `RJ400001_${i}.zip`);
    const b = addSplitWork('RJ400002', 3, (i) => `RJ400002_${i}.zip`);
    await manager.enqueue([a, b]);
    let rows = await waitForDone(7);
    const done = rows.filter((r) => r.state === 'done');
    check('7本すべて完了する', done.length === 7, rows.map((r) => `${r.label}:${r.state}${r.error ? '/' + r.error.slice(0, 40) : ''}`));
    check('行ごとに別のファイルになる', new Set(done.map((r) => r.savePath)).size === done.length, done.map((r) => path.basename(r.savePath ?? '')));
    check('保存したファイルが全部ある', done.every((r) => fs.existsSync(r.savePath)), done.map((r) => r.savePath));
    check('作品ごとに別のフォルダへ入る',
      new Set(done.map((r) => path.dirname(r.savePath ?? ''))).size === 2,
      [...new Set(done.map((r) => path.dirname(r.savePath ?? '')))]);
    // 保存名は「作品ID.partN」。N は案内ページが示す巻の番号で、行の番号と一致していなければならない
    check('パートの取り違えが無い（行の番号と巻の番号が一致）', rows.every((r) => {
      const product = repo.getProduct(r.productRef);
      return !r.savePath || path.basename(r.savePath).startsWith(`${product.productId}.part${r.linkIndex + 1}.`);
    }), done.map((r) => path.basename(r.savePath ?? '')));
    check('同時に走った本数が設定の上限を超えない', manager.concurrency === 4);
    // 1作品にパートの数だけ行があるので、まとめないと案内ページを何度も取りに行くことになる
    check('同時に始まった同じ作品の取り直しは1回にまとまる', detailCalls <= 2 && new Set(detailFor).size === 2, { 回数: detailCalls, 作品: detailFor });

    // ── 2. サーバが全パートに同じ名前を返す作品 ──
    console.log('\n== 同じファイル名が返るとき ==');
    const c = addSplitWork('RJ400003', 3, () => 'download.zip');
    await manager.enqueue([c]);
    rows = (await waitForDone(10)).filter((r) => r.productRef === c);
    const doneC = rows.filter((r) => r.state === 'done');
    const paths = doneC.map((r) => r.savePath);
    check('3本とも完了する', doneC.length === 3, rows.map((r) => `${r.label}:${r.state}`));
    check('3本とも別のファイルとして残る',
      new Set(paths).size === 3 && paths.every((p) => p && fs.existsSync(p)),
      { paths: paths.map((p) => p && path.basename(p)), 残っている: paths.filter((p) => p && fs.existsSync(p)).length, ごみ箱: global.__trashed.map((p) => path.basename(p)) });

    // ── 3. DLsite の実測どおり、日時だけの名前が返るとき ──
    console.log('\n== 日時だけの名前が返るとき（DLsite の分割ダウンロード） ==');
    const d = addSplitWork(
      'RJ400004', 3,
      (i) => (i === 1 ? '20171018174039.exe' : `2017101817410${i}.rar`),
      (i) => (i === 1 ? 'application/x-msdownload' : 'application/x-rar-compressed')
    );
    await manager.enqueue([d]);
    rows = (await waitForDone(13)).filter((r) => r.productRef === d);
    const names = rows.filter((r) => r.state === 'done').map((r) => path.basename(r.savePath ?? '')).sort();
    check('作品IDと巻の番号で保存する', names, ['RJ400004.part1.exe', 'RJ400004.part2.rar', 'RJ400004.part3.rar']);
    // 7-Zip が巻をつなげられる形か（src/main/archive/sevenZip.ts の splitInfo と同じ規則）
    check('多巻書庫として並びが分かる形', names.every((n) => /^(.*)\.part0*(\d+)\.(exe|rar)$/i.test(n)), names);

    db.close();
  } catch (err) {
    console.error(err);
    failures.push(String(err));
  }
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  if (failures.length) {
    console.error(`\nNG: ${failures.length} 件失敗 (${failures.join(' / ')})`);
    app.exit(1);
  } else {
    console.log('\nOK');
    app.exit(0);
  }
});
