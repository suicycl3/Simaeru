/**
 * 動画フロア調査 第7段。実際のページを BrowserWindow で開き、
 * api.video.dmm.co.jp へ飛ぶリクエストのヘッダと本文をそのまま捕捉する。
 * 認証方法（Cookie なのか Authorization ヘッダなのか）を確定させるのが目的。
 *
 *   npx electron tools/probe-video7.js <出力先ディレクトリ>
 */
const fs = require('node:fs');
const { userDataDir } = require('./app-paths.cjs');
const path = require('node:path');
const { app, session, BrowserWindow } = require('electron');

const OUT = process.argv[2] || path.join(__dirname, 'probe-out');
const PARTITION = 'persist:dmm';
const LIB = 'https://video.dmm.co.jp/mylibrary/';

app.setPath('userData', userDataDir(app.getPath('appData')));

function save(name, data) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8');
}

async function main() {
  const s = session.fromPartition(PARTITION);
  await s.cookies.get({});

  const captured = [];
  const bodies = new Map();

  s.webRequest.onBeforeRequest({ urls: ['https://api.video.dmm.co.jp/*'] }, (details, cb) => {
    const raw = (details.uploadData || [])
      .map((d) => (d.bytes ? Buffer.from(d.bytes).toString('utf8') : ''))
      .join('');
    bodies.set(details.id, raw);
    cb({});
  });

  s.webRequest.onBeforeSendHeaders({ urls: ['https://api.video.dmm.co.jp/*'] }, (details, cb) => {
    const headers = { ...details.requestHeaders };
    // Cookie は名前だけ残す（値は保存しない）
    if (headers.Cookie) headers.Cookie = headers.Cookie.split(';').map((c) => c.split('=')[0].trim()).join(', ');
    let parsed = null;
    try {
      parsed = JSON.parse(bodies.get(details.id) || 'null');
    } catch {
      /* ignore */
    }
    captured.push({
      method: details.method,
      url: details.url,
      headerNames: Object.keys(headers),
      headers,
      operationName: parsed?.operationName ?? null,
      variables: parsed?.variables ?? null
    });
    cb({ requestHeaders: details.requestHeaders });
  });

  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    show: true,
    webPreferences: { session: s, contextIsolation: true, nodeIntegration: false }
  });

  await win.loadURL(LIB).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 12000));

  // ライブラリの中身がページに出ているかも見る
  let pageHasItems = null;
  try {
    pageHasItems = await win.webContents.executeJavaScript(
      `({ url: location.href, title: document.title,
          imgs: document.querySelectorAll('img[src*="pics.dmm"], img[src*="assets"]').length,
          text: document.body.innerText.slice(0, 400) })`,
      true
    );
  } catch {
    /* ignore */
  }

  save('video-requests.json', captured);
  save('video-page-state.json', pageHasItems);

  const report = [];
  report.push(`捕捉した api.video.dmm.co.jp リクエスト: ${captured.length}`);
  const ops = [...new Set(captured.map((c) => c.operationName).filter(Boolean))];
  report.push(`オペレーション: ${ops.join(', ') || '(なし)'}`);
  if (captured[0]) {
    report.push(`ヘッダ名: ${captured[0].headerNames.join(', ')}`);
    report.push(`Cookie名: ${captured[0].headers.Cookie ?? '(なし)'}`);
    const auth = captured.find((c) => c.headers.Authorization || c.headers.authorization);
    report.push(`Authorization: ${auth ? '(あり)' : '(なし)'}`);
  }
  const mylib = captured.find((c) => c.operationName === 'Mylibrary');
  if (mylib) report.push(`Mylibrary variables: ${JSON.stringify(mylib.variables)}`);
  report.push(`ページ: ${JSON.stringify(pageHasItems).slice(0, 500)}`);

  save('report-video7.txt', report.join('\n'));
  console.log(report.join('\n'));
  win.destroy();
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (err) {
    console.error('PROBE_ERROR', err && err.stack ? err.stack : err);
  } finally {
    app.quit();
  }
});
