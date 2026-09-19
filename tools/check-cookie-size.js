/**
 * 指定URLへ送られるCookieヘッダの大きさを測る（nginx の 400 対策の切り分け）。
 *   npx electron tools/check-cookie-size.js
 * ※ アプリを終了してから実行すること
 */
const path = require('node:path');
const { userDataDir } = require('./app-paths.cjs');
const { app, session } = require('electron');
app.setPath('userData', userDataDir(app.getPath('appData')));

const TARGET = 'https://www.dmm.co.jp/dc/-/proxy/=/transfer_type=download/shop=doujin/product_id=d_100003/';

app.whenReady().then(async () => {
  const s = session.fromPartition('persist:dmm');
  const cookies = await s.cookies.get({ url: TARGET });
  const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  console.log(`送信されるCookie: ${cookies.length} 個 / ヘッダ長 ${header.length} バイト`);
  console.log('（nginx の既定上限は 4KB〜8KB）\n');
  const big = [...cookies].sort((a, b) => b.value.length - a.value.length).slice(0, 15);
  for (const c of big) {
    console.log(`  ${String(c.value.length).padStart(6)} B  ${c.domain}${c.path}  ${c.name}`);
  }
  app.quit();
});
