/**
 * 画像ビューアの読み込みまわり（NeeView にならった先読み・一覧用の縮小・zip の開き方）を確かめる。
 *   npx electron tools/test-viewer-images.js
 *
 * **本物のライブラリは触らない。** zip も画像も一時フォルダに作り、mylib:// は偽物の応答で置き換える。
 * - 先読み: 近い順・一度に 2 枚まで・読んだものは表示で読み直さない・範囲から外れたら手放す
 * - 一覧用の縮小: 高さ 360px（幅 480px まで）の WebP にする・小さい画像はそのまま・2 回目は作り直さない
 * - 縮めたものの置き場: 置いて取り出せる・元が変われば別物・画像でないものは置かない・上限で古いものから捨てる
 * - zip: 1 枚読むのに開くのは 1 回・ローカルヘッダの長さが違っても正しく読める・zip が変われば読み直す
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { app, BrowserWindow, protocol, nativeImage } = require('electron');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'out', 'test');
fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'simaeru-viewer-images-'));
app.setPath('userData', path.join(work, 'profile'));
protocol.registerSchemesAsPrivileged([
  { scheme: 'mylib', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
]);

let failed = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok ' : 'NG '} ${name}${ok ? '' : ` — ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`}`);
};
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');

/** zip を作る。deflate: 圧縮する / localExtra: ローカルヘッダにだけ付ける余分（中央ディレクトリと長さを変える） */
function makeZip(zipPath, files, { deflate = false, localExtra = 0 } = {}) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, body] of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(body);
    const stored = deflate ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data);
    const extra = Buffer.alloc(localExtra);
    if (localExtra >= 4) { extra.writeUInt16LE(0xcafe, 0); extra.writeUInt16LE(localExtra - 4, 2); }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(extra.length, 28);
    chunks.push(local, nameBytes, extra, stored);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x800, 8);
    head.writeUInt16LE(deflate ? 8 : 0, 10);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(stored.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBytes.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, nameBytes);
    offset += local.length + nameBytes.length + extra.length + stored.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(zipPath, Buffer.concat([...chunks, centralBuf, end]));
}

const bundle = (contents, name, opts) => {
  const outfile = path.join(outDir, name);
  buildSync({
    stdin: { contents, resolveDir: root, loader: 'ts' }, outfile, bundle: true, logLevel: 'error',
    alias: { '@shared': path.join(root, 'src/shared') }, ...opts
  });
  return outfile;
};

/** 縮める元になる画像（ノイズなので PNG でも小さくならない） */
function noisePng(width, height) {
  const raw = Buffer.alloc(width * height * 4);
  for (let i = 0; i < raw.length; i += 4) {
    raw[i] = (i * 7919) % 251; raw[i + 1] = (i * 104729) % 241; raw[i + 2] = (i * 1299709) % 239; raw[i + 3] = 255;
  }
  return nativeImage.createFromBitmap(raw, { width, height }).toPNG();
}

app.whenReady().then(async () => {
  let store;
  try {
    // ── zip の開き方 ──
    console.log('== zip を読む ==');
    const zipLib = require(bundle(
      "export { readZipIndex, openEntry } from './src/main/archive/zipReader';",
      'viewer-images-zip.cjs', { platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3'] }
    ));
    const fsp = require('node:fs/promises');
    const opened = [];
    const realOpen = fsp.open;
    fsp.open = (...args) => { opened.push(path.basename(String(args[0]))); return realOpen.apply(fsp, args); };
    const drain = async (stream) => { const parts = []; for await (const c of stream) parts.push(c); return Buffer.concat(parts).toString('utf8'); };
    for (const mode of [{ deflate: false }, { deflate: true }]) {
      const zip = path.join(work, `pages-${mode.deflate ? 'deflate' : 'stored'}.zip`);
      makeZip(zip, [['001.jpg', 'first page '.repeat(50)], ['002.jpg', 'second page '.repeat(50)]], { ...mode, localExtra: 12 });
      const label = mode.deflate ? 'deflate' : '無圧縮';
      const index = await zipLib.readZipIndex(zip);
      const entry = index.byName.get('002.jpg');
      check(`${label}: ローカルヘッダが長くても正しく読める`, await drain(await zipLib.openEntry(zip, entry)), 'second page '.repeat(50));
      opened.length = 0;
      const again = await zipLib.readZipIndex(zip);
      const body = await drain(await zipLib.openEntry(zip, again.byName.get('002.jpg')));
      check(`${label}: 2 枚目からは、目次の確認で開かず、1 枚読むのに 1 回だけ開く`, [opened.length, body.length], [1, 'second page '.repeat(50).length]);
      // 中身を入れ替えた zip（大きさが変わる）は目次を読み直し、覚えていた位置を使わない
      await new Promise((r) => setTimeout(r, 20));
      makeZip(zip, [['002.jpg', 'replaced']], mode);
      const changed = await zipLib.readZipIndex(zip);
      check(`${label}: zip が変わったら読み直す`, await drain(await zipLib.openEntry(zip, changed.byName.get('002.jpg'))), 'replaced');
    }
    fsp.open = realOpen;

    // ── 縮めたものの置き場（メインプロセス側） ──
    console.log('\n== 縮めたものの置き場 ==');
    const { ThumbStore } = require(bundle(
      "export { ThumbStore } from './src/main/content/thumbStore';",
      'viewer-images-store.cjs', { platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3'] }
    ));
    const dbFile = path.join(work, 'thumbs', 'thumbs.db');
    const source = path.join(work, 'source.png');
    fs.writeFileSync(source, 'original image');
    const fileUrl = `mylib://f/${b64(source)}`;
    const entryUrl = `mylib://a/${b64(source)}/${b64('CG/001.png')}`;
    const webp = (n, fill = 1) => { const b = Buffer.alloc(n, fill); b.write('RIFF', 0, 'ascii'); b.write('WEBP', 8, 'ascii'); return new Uint8Array(b); };
    store = new ThumbStore(dbFile);
    check('置いたものを取り出せる', [await store.put(fileUrl, webp(100, 7)), Buffer.from(await store.get(fileUrl)).equals(Buffer.from(webp(100, 7)))], [true, true]);
    check('アーカイブの中の名前ごとに別物', await store.get(entryUrl), null);
    check('画像でないものは置かない', await store.put(entryUrl, new Uint8Array(Buffer.from('<html>not an image</html>'))), false);
    check('mylib:// でないものは置かない', await store.put('https://example.com/a.png', webp(100)), false);
    store.close();
    store = new ThumbStore(dbFile);
    check('アプリを開き直しても残っている', !!(await store.get(fileUrl)), true);
    fs.writeFileSync(source, 'original image, edited');
    store.close();
    store = new ThumbStore(dbFile);
    check('元のファイルが変わったら使わない', await store.get(fileUrl), null);
    store.close();
    store = new ThumbStore(path.join(work, 'thumbs', 'small.db'), 3000);
    const urls = [1, 2, 3, 4].map((n) => `mylib://a/${b64(source)}/${b64(`${n}.png`)}`);
    for (const u of urls) { await store.put(u, webp(1000)); await new Promise((r) => setTimeout(r, 5)); }
    check('上限を超えたら古いものから捨てる', await Promise.all(urls.map(async (u) => !!(await store.get(u)))), [false, false, true, true]);
    fs.writeFileSync(path.join(work, 'thumbs', 'broken.db'), 'this is not a database');
    const broken = new ThumbStore(path.join(work, 'thumbs', 'broken.db'));
    check('壊れた置き場は作り直す', await broken.put(fileUrl, webp(50)), true);
    broken.close();

    // ── 画面側: 先読みと一覧用の縮小 ──
    console.log('\n== 先読み ==');
    const big = noisePng(1200, 1600);
    const wide = noisePng(2400, 900);
    const small = nativeImage.createFromBitmap(Buffer.alloc(64 * 64 * 4, 200), { width: 64, height: 64 }).toPNG();
    const requests = [];
    let live = 0;
    let peak = 0;
    protocol.handle('mylib', async (req) => {
      const name = new URL(req.url).pathname.slice(1);
      requests.push(name);
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 80));
      live--;
      const body = name.startsWith('big') ? big : name.startsWith('wide') ? wide : small;
      return new Response(body, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' } });
    });
    const libFile = bundle(
      "export * as prefetch from './src/renderer/src/lib/imagePrefetch'; export * as thumbs from './src/renderer/src/lib/thumbnails';",
      'viewer-images-renderer.js', { platform: 'browser', format: 'iife', globalName: '__lib' }
    );
    const page = path.join(work, 'page.html');
    fs.writeFileSync(page, '<!doctype html><html><body></body></html>');
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, sandbox: false } });
    await win.loadFile(page);
    await win.webContents.executeJavaScript(fs.readFileSync(libFile, 'utf8') + ';0');
    const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);

    check('先読みの順番: 次 → 前 → その先', await js('return __lib.prefetch.prefetchOrder(10, 1, 100, 1)'), [11, 9, 12, 13, 14, 15, 8]);
    check('見開きで戻っているとき: 前の見開き → 次の見開き → さらに前', await js('return __lib.prefetch.prefetchOrder(10, 2, 100, -1)'), [9, 8, 12, 13, 7, 6, 5]);
    check('端では範囲の外を読まない', await js('return __lib.prefetch.prefetchOrder(0, 1, 3, 1)'), [1, 2]);
    check('大きさの上限まで（いちばん近い 1 枚は必ず）', await js('return __lib.prefetch.prefetchOrder(0, 1, 10, 1, () => 150 * 1024 * 1024)'), [1]);

    peak = 0;
    requests.length = 0;
    await js(`
      window.p = new __lib.prefetch.ImagePrefetcher();
      p.want(['mylib://a/s1', 'mylib://a/s2', 'mylib://a/s3', 'mylib://a/s4', 'mylib://a/s5']);
      for (let i = 0; i < 100 && !['s1','s2','s3','s4','s5'].every((n) => p.has('mylib://a/' + n)); i++) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 600));
    `);
    check('近い順に、一度に 2 枚まで読む', [requests.join(','), peak <= 2], ['s1,s2,s3,s4,s5', true]);
    await js(`
      const img = document.createElement('img'); img.src = 'mylib://a/s3'; document.body.append(img);
      await new Promise((r) => { img.onload = r; img.onerror = r; });
    `);
    check('先読みしたものは、表示するときに読み直さない', requests.filter((n) => n === 's3').length, 1);
    check('範囲から外れたものは手放す', await js(`p.want(['mylib://a/s5', 'mylib://a/s6']); return [p.has('mylib://a/s1'), p.has('mylib://a/s5'), p.has('mylib://a/s6')]`), [false, true, true]);

    console.log('\n== 一覧用の縮小 ==');
    requests.length = 0;
    const result = await js(`
      window.__puts = [];
      window.api = { thumbs: { get: async () => null, put: async (url, data) => { __puts.push({ url, size: data.length, head: String.fromCharCode(...data.subarray(8, 12)) }); return true; } } };
      const size = async (u) => { const img = new Image(); img.src = u; await img.decode(); return [img.naturalWidth, img.naturalHeight]; };
      const tall = await __lib.thumbs.thumbnailUrl('mylib://a/big1', 8e6);
      const wide = await __lib.thumbs.thumbnailUrl('mylib://a/wide1', 8e6);
      const again = await __lib.thumbs.thumbnailUrl('mylib://a/big1', 8e6);
      const tiny = await __lib.thumbs.thumbnailUrl('mylib://a/s9', 5000);
      return { tall: [tall.startsWith('blob:'), await size(tall)], wide: await size(wide), same: again === tall, tiny, puts: __puts };
    `);
    check('縦長は高さ 360px に縮める', result.tall, [true, [270, 360]]);
    check('横長は幅 480px までに縮める', result.wide, [480, 180]);
    check('2 回目は作り直さない', [result.same, requests.filter((n) => n === 'big1').length], [true, 1]);
    check('小さい画像はそのまま使う', result.tiny, 'mylib://a/s9');
    check('縮めたものは WebP で置き場へ渡す', result.puts.map((p) => [p.url, p.head, p.size < 512 * 1024]), [['mylib://a/big1', 'WEBP', true], ['mylib://a/wide1', 'WEBP', true]]);
    // 置き場にあるときは、それを使う。置き場の中身はここで縮めて用意する（そのために元の画像を 1 回だけ取る）
    requests.length = 0;
    const fromStore = await js(`
      window.api.thumbs.get = async (url) => url === 'mylib://a/big2' ? new Uint8Array(await (await __lib.thumbs.shrink(await (await fetch('mylib://a/big2')).blob())).arrayBuffer()) : null;
      return { blob: (await __lib.thumbs.thumbnailUrl('mylib://a/big2', 8e6)).startsWith('blob:'), puts: __puts.length };
    `);
    check('置き場にあればそれを使い、取り直さず・置き直さない', [fromStore, requests.filter((n) => n === 'big2').length], [{ blob: true, puts: 2 }, 1]);
    win.destroy();
  } catch (error) {
    console.error(error);
    failed++;
  }
  try { store?.close(); } catch { /* 閉じてある */ }
  console.log(failed === 0 ? '\nOK' : `\nNG ${failed} 件`);
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 一時フォルダは OS が片付ける */ }
  app.exit(failed === 0 ? 0 : 1);
});

