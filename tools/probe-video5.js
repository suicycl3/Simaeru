/**
 * 動画フロア調査 第5段。filter の必須項目をサーバの検証エラーで詰めていき、
 * 通ったらレスポンス構造と件数を保存する。
 *
 *   npx electron tools/probe-video5.js <出力先ディレクトリ>
 *
 * 到達条件のメモ: session.fetch で POST するとき、User-Agent / Referer / Origin を
 * 手で足すと ERR_BLOCKED_BY_CLIENT になる。Content-Type だけ付けるのが正解。
 */
const fs = require('node:fs');
const { userDataDir } = require('./app-paths.cjs');
const path = require('node:path');
const { app, session } = require('electron');

const OUT = process.argv[2] || path.join(__dirname, 'probe-out');
const PARTITION = 'persist:dmm';
const GQL = 'https://api.video.dmm.co.jp/graphql';

app.setPath('userData', userDataDir(app.getPath('appData')));

function save(name, data) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8');
}

async function call(doc, variables) {
  const res = await session.fromPartition(PARTITION).fetch(GQL, {
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
  await session.fromPartition(PARTITION).cookies.get({});
  const doc = fs.readFileSync(path.join(OUT, 'gql-Mylibrary.graphql'), 'utf8');
  const report = [];

  const candidates = [
    { label: 'VISIBLE', filter: { displayStatus: 'VISIBLE' } },
    { label: 'VISIBLE+isLikedOnly', filter: { displayStatus: 'VISIBLE', isLikedOnly: false } },
    {
      label: 'VISIBLE+全項目',
      filter: {
        displayStatus: 'VISIBLE',
        isLikedOnly: false,
        showExpired: true,
        contentType: null,
        deliveryFormat: null,
        keyword: null
      }
    },
    { label: 'HIDDEN', filter: { displayStatus: 'HIDDEN' } }
  ];

  let good = null;
  for (const c of candidates) {
    const res = await call(doc, {
      offset: 0,
      limit: 20,
      filter: c.filter,
      sort: 'VIEWING_RIGHTS_ACQUIRED_AT_DESC'
    });
    if (res.json?.errors) {
      report.push(`${c.label}: HTTP ${res.status} errors=${JSON.stringify(res.json.errors.map((e) => ({ m: e.message, p: e.path })))}`);
      continue;
    }
    const list = res.json?.data?.user?.ppvLibrary?.mylibraryList;
    report.push(
      `${c.label}: HTTP ${res.status} items=${list?.items?.length} totalCount=${list?.pageInfo?.totalCount} hasNext=${list?.pageInfo?.hasNext}`
    );
    if (list && !good) {
      good = c;
      save('gql-Mylibrary-ok.json', res.text);
      save('gql-Mylibrary-firstitem.json', list.items?.[0] ?? null);
      const years = list.facet?.viewingRightsAcquiredYears?.items?.map((y) => y.year);
      report.push(`  購入年ファセット: ${JSON.stringify(years)}`);
    }
  }

  // limit の上限を確認
  if (good) {
    for (const limit of [100, 200]) {
      const res = await call(doc, {
        offset: 0,
        limit,
        filter: good.filter,
        sort: 'VIEWING_RIGHTS_ACQUIRED_AT_DESC'
      });
      const list = res.json?.data?.user?.ppvLibrary?.mylibraryList;
      report.push(
        `limit=${limit}: ${res.json?.errors ? JSON.stringify(res.json.errors.map((e) => e.message)) : `items=${list?.items?.length}`}`
      );
    }
  }

  save('report-video5.txt', report.join('\n'));
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
