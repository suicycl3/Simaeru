/**
 * 動画フロア調査 第3段。抽出した Mylibrary クエリを実際に投げて、
 * 変数の形とレスポンス構造を確定させる。
 *
 *   npx electron tools/probe-video3.js <出力先ディレクトリ>
 */
const fs = require('node:fs');
const { userDataDir } = require('./app-paths.cjs');
const path = require('node:path');
const { app, session } = require('electron');

const OUT = process.argv[2] || path.join(__dirname, 'probe-out');
const PARTITION = 'persist:dmm';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36';
const GQL = 'https://api.video.dmm.co.jp/graphql';

app.setPath('userData', userDataDir(app.getPath('appData')));

function save(name, data) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    path.join(OUT, name),
    typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    'utf8'
  );
}

async function postGraphql(body, extraHeaders) {
  const res = await session.fromPartition(PARTITION).fetch(GQL, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      Accept: '*/*',
      Referer: 'https://video.dmm.co.jp/mylibrary/',
      ...(extraHeaders || {})
    },
    body: JSON.stringify(body)
  });
  return { status: res.status, text: await res.text() };
}

async function main() {
  await session.fromPartition(PARTITION).cookies.get({});
  const doc = fs.readFileSync(path.join(OUT, 'gql-Mylibrary.graphql'), 'utf8');
  const report = [];

  const attempts = [
    { label: 'filter空', variables: { offset: 0, limit: 20, filter: {}, sort: 'VIEWING_RIGHTS_ACQUIRED_AT_DESC' } },
    {
      label: 'filter明示',
      variables: {
        offset: 0,
        limit: 20,
        filter: { isBookmarkedOnly: false, showExpired: true },
        sort: 'VIEWING_RIGHTS_ACQUIRED_AT_DESC'
      }
    }
  ];

  for (const attempt of attempts) {
    let res;
    try {
      res = await postGraphql({ operationName: 'Mylibrary', query: doc, variables: attempt.variables });
    } catch (err) {
      report.push(`${attempt.label}: 送信失敗 ${err.message}`);
      continue;
    }
    save(`gql-Mylibrary-${attempt.label}.json`, res.text);
    let summary = res.text.slice(0, 400);
    try {
      const json = JSON.parse(res.text);
      if (json.errors) {
        summary = 'errors: ' + JSON.stringify(json.errors.map((e) => e.message)).slice(0, 400);
      } else {
        const list = json.data?.user?.ppvLibrary?.mylibraryList;
        summary = `items=${list?.items?.length} totalCount=${list?.pageInfo?.totalCount} hasNext=${list?.pageInfo?.hasNext}`;
      }
    } catch {
      /* JSON でなければ生テキストのまま */
    }
    report.push(`${attempt.label}: HTTP ${res.status} ${summary}`);
  }

  save('report-video3.txt', report.join('\n'));
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
