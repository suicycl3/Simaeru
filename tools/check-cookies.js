/**
 * 各サイトのCookieが「セッションCookie（アプリ終了で消える）」かどうかを見る。
 *   npx electron tools/check-cookies.js
 * ※ アプリを終了してから実行すること
 */
const path = require('node:path');
const { userDataDir } = require('./app-paths.cjs');
const { app, session } = require('electron');
app.setPath('userData', userDataDir(app.getPath('appData')));

app.whenReady().then(async () => {
  for (const part of ['persist:dmm', 'persist:dlsite']) {
    const s = session.fromPartition(part);
    const cookies = await s.cookies.get({});
    const session_ = cookies.filter((c) => c.session);
    const persistent = cookies.filter((c) => !c.session);
    console.log(`\n### ${part}: 全${cookies.length}個 / 永続${persistent.length} / セッション${session_.length}`);
    const interesting = cookies.filter((c) =>
      /login|session|auth|sid|token|user|secure/i.test(c.name)
    );
    for (const c of interesting.slice(0, 14)) {
      const exp = c.session
        ? 'セッション（終了で消える）'
        : new Date((c.expirationDate || 0) * 1000).toLocaleString('ja-JP');
      console.log(`  ${c.domain}${c.path} ${c.name} -> ${exp}`);
    }
  }
  app.quit();
});
