/**
 * 表紙が出ないのが libcover スキームのせいなのかを、本番ビルドと同じ条件で確かめる。
 *   npx electron tools/probe-cover-scheme.js
 * ※ アプリを終了してから実行すること（userData を共有するため）
 *
 * 本番は file:// でレンダラを読む。dev は http://localhost:5173 なので、
 * 「dev では出るのに本番では出ない」ならこの差が原因になる。
 */
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, net, protocol } = require('electron');

const { userDataDir } = require('./app-paths.cjs');
app.setPath('userData', userDataDir(app.getPath('appData')));

const COVER_SCHEME = 'libcover';
protocol.registerSchemesAsPrivileged([
  {
    scheme: COVER_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
]);

function coversDir() {
  return path.join(app.getPath('userData'), 'covers');
}

app.whenReady().then(async () => {
  protocol.handle(COVER_SCHEME, (request) => {
    const name = path.basename(decodeURIComponent(new URL(request.url).hostname || ''));
    const file = path.join(coversDir(), name);
    console.log('  [handler] url=', request.url, '-> name=', name, 'exists=', fs.existsSync(file));
    if (!name || !fs.existsSync(file)) return new Response('not found', { status: 404 });
    return net.fetch(`file://${file.replace(/\\/g, '/')}`);
  });

  const sample = fs.readdirSync(coversDir()).filter((f) => /\.(jpg|webp)$/.test(f)).slice(0, 2);
  console.log('サンプル:', sample.join(', '));

  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  const indexHtml = path.join(__dirname, '..', 'out', 'renderer', 'index.html');
  await win.loadFile(indexHtml);
  console.log('読み込み:', win.webContents.getURL());

  const results = [];
  for (const name of sample) {
    const url = `${COVER_SCHEME}://${name}`;
    // <img> と同じ経路（サブリソース読み込み）
    const imgResult = await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve('load ' + img.naturalWidth + 'x' + img.naturalHeight);
        img.onerror = (e) => resolve('error');
        img.src = ${JSON.stringify(url)};
        setTimeout(() => resolve('timeout'), 4000);
      })
    `);
    // fetch 経路（CSPの connect-src に引っかかるかどうかで挙動が変わる）
    const fetchResult = await win.webContents
      .executeJavaScript(
        `fetch(${JSON.stringify(url)}).then(r => 'HTTP ' + r.status).catch(e => 'throw: ' + e.message)`
      )
      .catch((e) => `exec error: ${e.message}`);
    results.push({ url, img: imgResult, fetch: fetchResult });
  }
  console.log('\n== file:// のページから ==');
  for (const r of results) console.log(' ', r.url, '\n    img  :', r.img, '\n    fetch:', r.fetch);

  // CSP を無視した場合との比較（原因の切り分け）
  const meta = await win.webContents.executeJavaScript(
    `document.querySelector('meta[http-equiv]')?.getAttribute('content') || '(CSPメタなし)'`
  );
  console.log('\nCSP:', meta);

  app.quit();
});
