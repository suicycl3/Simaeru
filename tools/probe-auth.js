/**
 * アプリのセッションが今どの状態かを一望する。
 *   npx electron tools/probe-auth.js
 */
const path = require('node:path');
const { userDataDir } = require('./app-paths.cjs');
const { app, session } = require('electron');

const PARTITION = 'persist:dmm';
app.setPath('userData', userDataDir(app.getPath('appData')));

async function get(url, headers) {
  const res = await session.fromPartition(PARTITION).fetch(url, {
    credentials: 'include',
    headers: headers || {}
  });
  return { status: res.status, url: res.url, text: await res.text() };
}

app.whenReady().then(async () => {
  const s = session.fromPartition(PARTITION);
  const cookies = await s.cookies.get({});
  console.log('cookies:', cookies.length);

  // 年齢確認クッキー（本体の client.ts が毎回入れているもの）
  const hasAge = cookies.some((c) => c.name === 'age_check_done' && c.domain === '.dmm.co.jp');
  console.log('age_check_done(.dmm.co.jp):', hasAge ? 'あり' : 'なし');
  console.log('ckcy:', cookies.some((c) => c.name === 'ckcy') ? 'あり' : 'なし');

  const doujin = await get(
    'https://www.dmm.co.jp/dc/doujin/api/mylibraries/?page=1&sort=purchasedate_desc&genre=all&limit=1',
    { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://www.dmm.co.jp/dc/-/mylibrary/' }
  );
  console.log('同人API:', doujin.status, doujin.text.slice(0, 120));

  const lib = await get('https://dlsoft.dmm.co.jp/library/', {
    Referer: 'https://dlsoft.dmm.co.jp/library/'
  });
  const csrf = lib.text.match(/<meta\s+name="csrf-token"[^>]*content="([^"]+)"/i)?.[1];
  console.log('dlsoft /library/:', lib.status, lib.text.length, 'bytes, csrf=', csrf ? 'あり' : 'なし');
  console.log('  マイライブラリらしさ:', /mylibrary|ライブラリ/.test(lib.text) ? 'あり' : 'なし');

  app.quit();
});
