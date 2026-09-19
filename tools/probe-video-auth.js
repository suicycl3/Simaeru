/**
 * 動画のログインが本体ログインと独立して必要かを確かめる。
 * アプリと同じ Cookie パーティションで、本体API・動画APIの両方を叩いて比べる。
 *
 *   npx electron tools/probe-video-auth.js
 * ※ アプリを終了してから実行すること（userData を共有するため）
 */
const path = require('node:path');
const { userDataDir } = require('./app-paths.cjs');
const { app, session } = require('electron');

const PARTITION = 'persist:dmm';
app.setPath('userData', userDataDir(app.getPath('appData')));

const MYLIB_QUERY = `query Mylibrary($offset: Int!, $limit: Int!, $filter: PPVContentViewingRightsItemSummaryListFilterInput!, $sort: PPVContentViewingRightsItemSummaryListSort!) {
  user { ... on Member { ppvLibrary { contentViewingRightsSummaryList(filter: $filter, offset: $offset, limit: $limit, sort: $sort) { pageInfo { totalCount } } } } }
}`;

app.whenReady().then(async () => {
  const s = session.fromPartition(PARTITION);
  const cookies = await s.cookies.get({});
  console.log('cookies:', cookies.length);
  for (const domain of ['.dmm.co.jp', '.fanza.jp', 'video.dmm.co.jp']) {
    const names = cookies.filter((c) => c.domain === domain).map((c) => c.name);
    console.log(`  ${domain}: ${names.length} 個`, names.includes('login_secure_id') ? '(login_secure_id あり)' : '');
  }

  // 1) 本体（同人ライブラリAPI）
  const doujin = await s.fetch(
    'https://www.dmm.co.jp/dc/doujin/api/mylibraries/?page=1&sort=purchasedate_desc&genre=all&limit=1',
    {
      credentials: 'include',
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://www.dmm.co.jp/dc/-/mylibrary/' }
    }
  );
  const dtext = await doujin.text();
  console.log('\n本体(同人API):', doujin.status, dtext.slice(0, 80));

  // 2) 動画 GraphQL
  const gql = await s.fetch('https://api.video.dmm.co.jp/graphql', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operationName: 'Mylibrary',
      query: MYLIB_QUERY,
      variables: { offset: 0, limit: 1, filter: { displayStatus: 'VISIBLE' }, sort: 'VIEWING_RIGHTS_ACQUIRED_AT_DESC' }
    })
  });
  const gtext = await gql.text();
  let member = false;
  try {
    member = !!JSON.parse(gtext)?.data?.user?.ppvLibrary;
  } catch {
    /* ignore */
  }
  console.log('動画(GraphQL):', gql.status, member ? 'Member として解決（ログイン済み）' : '未認証', gtext.slice(0, 120));

  // 3) 旧www側の動画API（再生URL）も見る
  const play = await s.fetch(
    'https://www.dmm.co.jp/digital/-/mylibrary/ajax-play-url/=/cid=sone00076/shop=videoa/device=pc/',
    { credentials: 'include', headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://www.dmm.co.jp/digital/-/mylibrary/' } }
  );
  const ptext = await play.text();
  console.log('動画(旧www再生API):', play.status, `${ptext.length} bytes`, ptext.slice(0, 80));

  console.log(
    '\n判定:',
    dtext.includes('"error_code":0') && member
      ? '本体・動画ともログイン済み → この状態では独立ログインは不要'
      : dtext.includes('"error_code":0') && !member
        ? '本体はログイン済みだが動画は未認証 → 動画は独立ログインが必要'
        : '本体が未ログインのため判定できない（先に再ログインしてください）'
  );
  app.quit();
});
