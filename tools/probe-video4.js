/**
 * ERR_BLOCKED_BY_CLIENT の切り分け。GraphQL エンドポイントへの到達方法を4通り試す。
 *
 *   npx electron tools/probe-video4.js <出力先ディレクトリ>
 */
const fs = require('node:fs');
const { userDataDir } = require('./app-paths.cjs');
const path = require('node:path');
const { app, session, BrowserWindow } = require('electron');

const OUT = process.argv[2] || path.join(__dirname, 'probe-out');
const PARTITION = 'persist:dmm';
const GQL = 'https://api.video.dmm.co.jp/graphql';
const LIB = 'https://video.dmm.co.jp/mylibrary/';

app.setPath('userData', userDataDir(app.getPath('appData')));

function save(name, data) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8');
}

async function main() {
  const report = [];
  const s = session.fromPartition(PARTITION);
  await s.cookies.get({});
  const doc = fs.readFileSync(path.join(OUT, 'gql-Mylibrary.graphql'), 'utf8');
  const variables = { offset: 0, limit: 20, filter: {}, sort: 'VIEWING_RIGHTS_ACQUIRED_AT_DESC' };
  const payload = { operationName: 'Mylibrary', query: doc, variables };

  // 1) session.fetch で GET（到達性だけ確認）
  try {
    const r = await s.fetch(GQL, { credentials: 'include' });
    report.push(`1 session.fetch GET : HTTP ${r.status}`);
  } catch (e) {
    report.push(`1 session.fetch GET : ${e.message}`);
  }

  // 2) session.fetch で POST
  try {
    const r = await s.fetch(GQL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    report.push(`2 session.fetch POST: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  } catch (e) {
    report.push(`2 session.fetch POST: ${e.message}`);
  }

  // 3) 実ページを読み込んだ BrowserWindow の中から fetch（＝ブラウザと同じ文脈）
  const win = new BrowserWindow({
    show: false,
    webPreferences: { session: s, nodeIntegration: false, contextIsolation: true }
  });
  try {
    await win.loadURL(LIB);
    const result = await win.webContents.executeJavaScript(
      `fetch(${JSON.stringify(GQL)}, {
         method: 'POST',
         credentials: 'include',
         headers: { 'Content-Type': 'application/json' },
         body: ${JSON.stringify(JSON.stringify(payload))}
       }).then(async r => ({ status: r.status, text: (await r.text()).slice(0, 4000) }))
        .catch(e => ({ status: -1, text: String(e) }))`,
      true
    );
    save('gql-Mylibrary-fromwindow.json', result.text);
    let summary = result.text.slice(0, 300);
    try {
      const json = JSON.parse(result.text);
      if (json.errors) summary = 'errors: ' + JSON.stringify(json.errors.map((e) => e.message)).slice(0, 400);
      else {
        const list = json.data?.user?.ppvLibrary?.mylibraryList;
        summary = `items=${list?.items?.length} totalCount=${list?.pageInfo?.totalCount} hasNext=${list?.pageInfo?.hasNext}`;
      }
    } catch {
      /* そのまま */
    }
    report.push(`3 window fetch POST : HTTP ${result.status} ${summary}`);
  } catch (e) {
    report.push(`3 window fetch POST : ${e.message}`);
  } finally {
    win.destroy();
  }

  save('report-video4.txt', report.join('\n'));
  console.log(report.join('\n'));
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
