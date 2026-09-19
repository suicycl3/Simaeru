/**
 * DLsite のログイン判定（play / www）の生の結果を見る。
 *   npx electron tools/probe-dlsite-auth.js
 * ※ アプリを終了してから実行すること
 */
const path = require('node:path');
const { userDataDir } = require('./app-paths.cjs');
const { app, session } = require('electron');

app.setPath('userData', userDataDir(app.getPath('appData')));

app.whenReady().then(async () => {
  const s = session.fromPartition('persist:dlsite');
  for (const domain of ['play.dlsite.com', 'www.dlsite.com', 'login.dlsite.com', '.dlsite.com']) {
    const cookies = await s.cookies.get({ domain });
    console.log(`[${domain}] ${cookies.length} 個: ${cookies.map((c) => c.name).join(', ').slice(0, 200)}`);
  }
  for (const [label, url, accept] of [
    ['play /api/authorize', 'https://play.dlsite.com/api/authorize', 'application/json'],
    ['www マイページ', 'https://www.dlsite.com/home/mypage', 'text/html']
  ]) {
    const res = await s.fetch(url, { credentials: 'include', headers: { Accept: accept } });
    const text = await res.text();
    console.log(`\n${label}: HTTP ${res.status} final=${res.url || '(なし)'}`);
    console.log('  head:', text.slice(0, 140).replace(/\s+/g, ' '));
    if (label.startsWith('www')) {
      console.log('  userbuy導線:', text.includes('/home/mypage/userbuy'), '/ logout:', text.includes('logout'));
    }
  }
  app.quit();
});
