/**
 * 動画フロア調査 第6段。video.dmm.co.jp 用のセッションをトークン交換で張ってから
 * GraphQL を叩き直す。生レスポンスも必ず保存する。
 *
 *   npx electron tools/probe-video6.js <出力先ディレクトリ>
 */
const fs = require('node:fs');
const { userDataDir } = require('./app-paths.cjs');
const path = require('node:path');
const { app, session } = require('electron');

const OUT = process.argv[2] || path.join(__dirname, 'probe-out');
const PARTITION = 'persist:dmm';
const GQL = 'https://api.video.dmm.co.jp/graphql';
const LIB = 'https://video.dmm.co.jp/mylibrary/';
const TOKEN = 'https://accounts.dmm.co.jp/service/login/token/=/path=' + encodeURIComponent(LIB);

app.setPath('userData', userDataDir(app.getPath('appData')));

function save(name, data) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8');
}

async function cookieSummary(s) {
  const all = await s.cookies.get({});
  const video = all.filter((c) => /video\.dmm|dmm\.co\.jp$/.test(c.domain) && /session|token|sid|auth/i.test(c.name));
  return {
    total: all.length,
    videoDomain: all.filter((c) => c.domain.includes('video.dmm')).map((c) => `${c.domain}|${c.name}`),
    authish: video.map((c) => `${c.domain}|${c.name}`)
  };
}

async function call(s, doc, variables) {
  const res = await s.fetch(GQL, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operationName: 'Mylibrary', query: doc, variables })
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, text, json };
}

async function main() {
  const s = session.fromPartition(PARTITION);
  const report = [];
  const doc = fs.readFileSync(path.join(OUT, 'gql-Mylibrary.graphql'), 'utf8');
  const variables = {
    offset: 0,
    limit: 20,
    filter: { displayStatus: 'VISIBLE' },
    sort: 'VIEWING_RIGHTS_ACQUIRED_AT_DESC'
  };

  report.push('■ トークン交換前');
  report.push(JSON.stringify(await cookieSummary(s)));
  const before = await call(s, doc, variables);
  save('gql-before-token.json', before.text);
  report.push(`  GraphQL: HTTP ${before.status} body=${before.text.slice(0, 200)}`);

  report.push('■ トークン交換');
  const tok = await s.fetch(TOKEN, { credentials: 'include' });
  const tokText = await tok.text();
  save('token-exchange.html', tokText);
  report.push(`  GET token -> HTTP ${tok.status} final=${tok.url} ${tokText.length} bytes`);

  const lib = await s.fetch(LIB, { credentials: 'include' });
  report.push(`  GET mylibrary -> HTTP ${lib.status} final=${lib.url}`);
  await lib.text();

  report.push('■ トークン交換後');
  report.push(JSON.stringify(await cookieSummary(s)));
  const after = await call(s, doc, variables);
  save('gql-after-token.json', after.text);
  const list = after.json?.data?.user?.ppvLibrary?.mylibraryList;
  report.push(
    `  GraphQL: HTTP ${after.status} items=${list?.items?.length} totalCount=${list?.pageInfo?.totalCount} body=${after.text.slice(0, 200)}`
  );
  if (list?.items?.[0]) save('gql-firstitem.json', list.items[0]);

  save('report-video6.txt', report.join('\n'));
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
