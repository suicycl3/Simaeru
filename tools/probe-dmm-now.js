/**
 * 本物の persist:dmm で「API → 通常ページ → API」を順に叩いて、いまの状態を見る。
 *   npx electron tools/probe-dmm-now.js
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

app.whenReady().then(async () => {
  const s = session.fromPartition('persist:dmm');
  const api = async (label) => {
    const res = await s.fetch(API, {
      credentials: 'include',
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': UA, Referer: PAGE }
    });
    const text = await res.text();
    console.log(`${label}: HTTP ${res.status} / ${text.slice(0, 110).replace(/\s+/g, ' ')}`);
  };

  for (const name of ['ec_session', 'login_secure_id', 'check_done_login']) {
    const got = await s.cookies.get({ name });
    console.log(
      `Cookie ${name}:`,
      got.map((c) => `${c.domain} 期限 ${c.session ? 'セッション' : new Date((c.expirationDate || 0) * 1000).toLocaleString('ja-JP')}`).join(' / ') || '(無し)'
    );
  }

  await api('\n1) いまのAPI  ');
  const page = await s.fetch(PAGE, { credentials: 'include', headers: { Accept: 'text/html', 'User-Agent': UA } });
  const html = await page.text();
  console.log(`2) 通常ページ : HTTP ${page.status} / ${html.length} bytes / ログイン導線? ${html.includes('service/login')}`);
  await api('3) もう一度API');
  app.quit();
});
