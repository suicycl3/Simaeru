/**
 * アプリの画面だけに preload の API と IPC を使わせる守り（src/main/security/appPages.ts）を、本物の Electron で確かめる。
 *   npm run build のあとに: npx electron tools/test-app-pages.js
 *
 * 本物のデータには触らない（使い捨ての userData）。外部のサイトにもつながない（http(s) の窓は開く手前で止める）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain } = require('electron');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'simaeru-app-pages-'));
app.setPath('userData', path.join(work, 'profile'));
app.on('window-all-closed', () => {});

let failed = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok ' : 'NG '} ${name}${ok ? '' : ` — ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    const appIndex = path.join(root, 'out/renderer/index.html');
    const realPreload = path.join(root, 'out/preload/index.js');
    if (!fs.existsSync(appIndex) || !fs.existsSync(realPreload)) throw new Error('先に npm run build を実行してください');

    // 守りのモジュールは out/test に束ねる（__dirname が out/test になり、画面の実体 out/renderer/index.html を正しく指す）
    const outfile = path.join(root, 'out/test/app-pages.cjs');
    buildSync({ entryPoints: [path.join(root, 'src/main/security/appPages.ts')], outfile, bundle: true, platform: 'node', format: 'cjs',
      external: ['electron'], alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'error' });
    const { isAppPageUrl, guardAppWindow, restrictIpcToAppPages } = require(outfile);

    // よそのページ（作品に入っていた HTML のつもり）
    const foreign = path.join(work, 'foreign.html');
    fs.writeFileSync(foreign, '<!doctype html><title>foreign</title><p>foreign</p>');
    // IPC の確認用 preload（ipcRenderer をそのまま見せる。テストだけで使う）
    const rawPreload = path.join(work, 'raw-preload.js');
    fs.writeFileSync(rawPreload, "window.__invoke = (c) => require('electron').ipcRenderer.invoke(c);");

    console.log('== 画面の判定 ==');
    check('ビルドした画面は通す', isAppPageUrl(pathToFileURL(appIndex).href), true);
    check('ビューアの別窓（#popup=）も通す', isAppPageUrl(`${pathToFileURL(appIndex).href}#popup=%7B%7D`), true);
    check('大文字小文字の違いは同じ', isAppPageUrl(pathToFileURL(appIndex).href.toUpperCase().replace('FILE:', 'file:')), true);
    check('よそのローカル HTML は通さない', isAppPageUrl(pathToFileURL(foreign).href), false);
    check('Web のページは通さない', isAppPageUrl('https://www.dmm.co.jp/'), false);
    check('壊れた URL は通さない', isAppPageUrl('::::'), false);

    // メインの登録口を包む（以後の handle は確認つき）。画面が sendSync で読む言語にも答えておく
    restrictIpcToAppPages(ipcMain);
    ipcMain.handle('test:ping', () => 'pong');
    ipcMain.on('app:langSync', (e) => { e.returnValue = 'ja'; });

    const open = async (file, preload) => {
      const win = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: preload === rawPreload ? false : true, sandbox: preload !== rawPreload, nodeIntegration: false } });
      await win.loadFile(file);
      return win;
    };

    console.log('== preload の API ==');
    const appWin = await open(appIndex, realPreload);
    check('アプリの画面には API がある', await appWin.webContents.executeJavaScript('typeof window.api'), 'object');
    const foreignWin = await open(foreign, realPreload);
    check('よそのページには API を出さない', await foreignWin.webContents.executeJavaScript('typeof window.api'), 'undefined');
    foreignWin.destroy();

    console.log('== 窓の移動と新しい窓 ==');
    const opened = [];
    guardAppWindow(appWin, (url) => opened.push(url));
    await appWin.webContents.executeJavaScript(`location.href = ${JSON.stringify(pathToFileURL(foreign).href)}; 1`);
    await wait(800);
    check('よそのページへは移らない', isAppPageUrl(appWin.webContents.getURL()), true);
    check('移った先で API が使えるまま（=アプリの画面のまま）', await appWin.webContents.executeJavaScript('typeof window.api'), 'object');
    await appWin.webContents.executeJavaScript(`window.open(${JSON.stringify(pathToFileURL(foreign).href)}); window.open('ms-settings:'); window.open('https://example.com/a?b=1'); 1`);
    await wait(500);
    check('新しい窓は http(s) だけを外のブラウザに渡す', opened, ['https://example.com/a?b=1']);
    check('アプリの中に窓は増えない', BrowserWindow.getAllWindows().length, 1);
    appWin.destroy();

    console.log('== IPC の呼び出し元 ==');
    const trustedWin = await open(appIndex, rawPreload);
    check('アプリの画面からの IPC は通る', await trustedWin.webContents.executeJavaScript('window.__invoke("test:ping")'), 'pong');
    trustedWin.destroy();
    const untrustedWin = await open(foreign, rawPreload);
    check('よそのページからの IPC は断る', await untrustedWin.webContents.executeJavaScript('window.__invoke("test:ping").then(() => "通った", (e) => /forbidden/.test(String(e)) ? "断られた" : String(e))'), '断られた');
    untrustedWin.destroy();

    console.log(failed === 0 ? '\nOK' : `\nNG ${failed} 件`);
    // 動いている Electron がプロファイルを掴んでいるので、後片付けは失敗しても結果に響かせない
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 一時フォルダは OS が片付ける */ }
    app.exit(failed === 0 ? 0 : 1);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
