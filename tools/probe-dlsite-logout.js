/**
 * 「未ログインなのにログイン中と判定されないか」を、まっさらなセッションで確かめる。
 * 本物の persist:dlsite には一切触らない（使い捨てパーティションを使う）。
 *
 *   npx electron tools/probe-dlsite-logout.js
 * ※ アプリを終了してから実行すること（userData を共有するため）
 */
const path = require('node:path');
const { userDataDir } = require('./app-paths.cjs');
const { app, session } = require('electron');

app.setPath('userData', userDataDir(app.getPath('appData')));

app.whenReady().then(async () => {
  // 使い捨て（非永続）パーティション = Cookie を持たない＝未ログイン状態
  const clean = session.fromPartition(`clean-${Date.now()}`);

  const targets = [
    ['play /api/authorize', 'https://play.dlsite.com/api/authorize', 'application/json'],
    [
      'www 購入履歴',
      'https://www.dlsite.com/home/mypage/userbuy/=/type/all/start/all/sort/1/order/1/page/1',
      'text/html'
    ],
    ['www マイページ', 'https://www.dlsite.com/home/mypage', 'text/html']
  ];

  for (const [label, url, accept] of targets) {
    const res = await clean.fetch(url, { credentials: 'include', headers: { Accept: accept } });
    const text = await res.text();
    console.log(`\n##### ${label}`);
    console.log('  HTTP:', res.status, '/ redirected:', res.redirected, '/ url:', res.url || '(空)');
    console.log('  bytes:', text.length);
    console.log('  head :', text.slice(0, 160).replace(/\s+/g, ' '));
    // いま判定に使っている目印が、未ログインでも出てしまわないか
    for (const marker of ['page_total', 'buy_date', 'account_id', 'login.dlsite.com', 'ログイン']) {
      const n = (text.match(new RegExp(marker, 'g')) || []).length;
      if (n) console.log(`   目印「${marker}」: ${n} 回`);
    }
  }
  app.quit();
});
