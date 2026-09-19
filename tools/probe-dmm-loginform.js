/**
 * DMM のログイン画面の入力欄が、自動入力のセレクタと噛み合うかを見る。
 * まっさらなセッションで開く（本物の persist:dmm は触らない）。
 *   npx electron tools/probe-dmm-loginform.js
 * ※ アプリを終了してから実行すること
 */
const path = require('node:path');
const { userDataDir } = require('./app-paths.cjs');
const { app, BrowserWindow, session } = require('electron');

app.setPath('userData', userDataDir(app.getPath('appData')));
const URL_ = process.argv[2] || 'https://accounts.dmm.co.jp/service/login/password';

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { session: session.fromPartition(`clean-${Date.now()}`), contextIsolation: true }
  });
  await win.loadURL(URL_).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 2500));
  const info = await win.webContents.executeJavaScript(`(() => {
    const inputs = [...document.querySelectorAll('input')].map((el) => ({
      type: el.type, name: el.name, id: el.id,
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
    }));
    const pick = (sel) => { const el = document.querySelector(sel); return el ? (el.name || el.id || el.type) : null; };
    return {
      url: location.href,
      inputs,
      selected: {
        password: pick('input[type="password"]'),
        email: pick('input[type="email"]'),
        loginName: pick('input[name*="login" i]:not([type="password"])'),
        mail: pick('input[name*="mail" i]'),
        idName: pick('input[name*="id" i]:not([type="password"])'),
        text: pick('input[type="text"]')
      }
    };
  })()`, true);
  console.log(JSON.stringify(info, null, 1));
  app.quit();
});
