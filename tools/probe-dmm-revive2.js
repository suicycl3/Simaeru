/**
 * 無効になったセッションCookieを捨ててから通常ページを読むと、
 * 自動ログインでセッションが再発行されるかを本物のセッションで確かめる。
 *   npx electron tools/probe-dmm-revive2.js
 * ※ アプリを終了してから実行すること
 */
const path = require('node:path');
const { userDataDir } = require('./app-paths.cjs');
const { app, session } = require('electron');
app.setPath('userData', userDataDir(app.getPath('appData')));

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36';
const API = 'https://www.dmm.co.jp/dc/doujin/api/mylibraries/?page=1&sort=purchasedate_desc&genre=all&limit=1';
const PAGE = 'https://www.dmm.co.jp/dc/-/mylibrary/';
const STALE = ['ec_session', 'laravel_session', 'INT_SESID', 'XSRF-TOKEN'];

app.whenReady().then(async () => {
  const s = session.fromPartition('persist:dmm');
  const api = async (label) => {
    const res = await s.fetch(API, {
      credentials: 'include',
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': UA, Referer: PAGE }
    });
    const text = await res.text();
    console.log(`${label}: HTTP ${res.status} / ${text.slice(0, 90).replace(/\s+/g, ' ')}`);
    return res.status === 200;
  };

  await api('1) いまのAPI    ');

  let removed = 0;
  for (const name of STALE) {
    for (const c of await s.cookies.get({ name })) {
      const host = (c.domain || '').replace(/^\./, '');
      const url = `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`;
      try {
        await s.cookies.remove(url, c.name);
        removed++;
        console.log(`   捨てた: ${c.domain}${c.path} ${c.name}`);
      } catch (err) {
        console.log(`   捨てられず: ${c.domain}${c.path} ${c.name} (${err.message})`);
      }
    }
  }
  console.log(`2) 無効Cookieを ${removed} 個削除`);

  const page = await s.fetch(PAGE, { credentials: 'include', headers: { Accept: 'text/html', 'User-Agent': UA } });
  const html = await page.text();
  console.log(`3) 通常ページ   : HTTP ${page.status} / ${html.length} bytes / ログイン導線? ${html.includes('service/login')}`);
  const after = await s.cookies.get({ name: 'ec_session' });
  console.log('   ec_session 再発行:', after.length > 0);

  await api('4) もう一度API  ');
  app.quit();
});
