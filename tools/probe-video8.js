/**
 * 動画ログインの挙動確認。
 *  - probeVideoLogin 相当の判定が例外を投げずに false を返すか
 *  - 開始URL(マイライブラリ)を開いたとき、ログイン画面に留まるか（＝ユーザーが操作できるか）
 * を見る。新しいログインウィンドウは「判定が true のときだけ閉じる」ので、
 * ここで false のままなら一瞬で閉じることはない。
 *
 *   npx electron tools/probe-video8.js
 */
const path = require('node:path');
const { userDataDir } = require('./app-paths.cjs');
const { app, session, BrowserWindow } = require('electron');

const PARTITION = 'persist:dmm';
const ENDPOINT = 'https://api.video.dmm.co.jp/graphql';
const LIB = 'https://video.dmm.co.jp/mylibrary/';

app.setPath('userData', userDataDir(app.getPath('appData')));

const QUERY = `query Mylibrary($offset: Int!, $limit: Int!, $filter: PPVContentViewingRightsItemSummaryListFilterInput!, $sort: PPVContentViewingRightsItemSummaryListSort!) {
  user { ... on Member { ppvLibrary { mylibraryList: contentViewingRightsSummaryList(filter: $filter, offset: $offset, limit: $limit, sort: $sort) { pageInfo { totalCount } } } } }
}`;

async function probeVideoLogin() {
  try {
    const res = await session.fromPartition(PARTITION).fetch(ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationName: 'Mylibrary',
        query: QUERY,
        variables: {
          offset: 0,
          limit: 1,
          filter: { displayStatus: 'VISIBLE' },
          sort: 'VIEWING_RIGHTS_ACQUIRED_AT_DESC'
        }
      })
    });
    const json = JSON.parse(await res.text());
    if (json.errors) return { ok: false, why: json.errors.map((e) => e.message).join(' / ') };
    return {
      ok: !!json.data?.user?.ppvLibrary,
      total: json.data?.user?.ppvLibrary?.mylibraryList?.pageInfo?.totalCount ?? null,
      body: JSON.stringify(json).slice(0, 160)
    };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

app.whenReady().then(async () => {
  const s = session.fromPartition(PARTITION);
  await s.cookies.get({});

  const before = await probeVideoLogin();
  console.log('判定(操作前):', JSON.stringify(before));

  const win = new BrowserWindow({
    width: 1000,
    height: 820,
    show: true,
    webPreferences: { session: s, contextIsolation: true, nodeIntegration: false }
  });
  await win.loadURL(LIB).catch((e) => console.log('load:', e.message));
  await new Promise((r) => setTimeout(r, 8000));

  let state = null;
  try {
    state = await win.webContents.executeJavaScript(
      '({url: location.href, title: document.title, hasPasswordInput: !!document.querySelector("input[type=password]")})',
      true
    );
  } catch (e) {
    state = { error: e.message };
  }
  console.log('ウィンドウ状態:', JSON.stringify(state));
  const after = await probeVideoLogin();
  console.log('判定(表示後):', JSON.stringify(after));
  console.log(
    after.ok
      ? '→ 新ロジックではここでウィンドウを閉じる（ログイン済み）'
      : '→ 新ロジックではウィンドウは開いたまま（ユーザーがログインできる）'
  );

  win.destroy();
  app.quit();
});
