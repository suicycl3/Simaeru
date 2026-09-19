import path from 'node:path';
import { app, BrowserWindow, protocol, session, shell } from 'electron';
import { APP_NAME } from '@shared/appInfo';
import { installLogCapture } from './log';
import { resolveUserDataDir } from './userData';
import { closeDatabase, openDatabase } from './db/database';
import { applyPendingRestore } from './db/backup';
import { Repo } from './db/repo';
import { CredentialStore } from './auth/credentials';
import { pruneOversizedCookies } from './sites/dmm/client';
import { cacheCovers, COVER_SCHEME, registerCoverProtocol } from './images/imageCache';
import { SyncService } from './sync/syncService';
import { SITES } from './sites/registry';
import { registerIpc } from './ipc';
import { LOCAL_SCHEME_PRIVILEGES, registerLocalProtocol } from './content/localProtocol';
import { findSevenZip } from './tools/externalTools';
import { cleanCache, configureArchiveCache } from './archive/archiveAccess';
import { normalizeLang, setLang } from '@shared/i18n';

// データの置き場所は `%APPDATA%\<APP_ID>`。以前の名前のフォルダがあれば、ここで引き継ぐ（userData.ts）。
// SIMAERU_USER_DATA は動作確認用（本物のデータに触らずに、写しで起動する）
app.setPath('userData', resolveUserDataDir(app.getPath('appData'), process.env.SIMAERU_USER_DATA));
app.setName(APP_NAME);
// console の出力をファイルにも残す（「このアプリについて」から書き出せる）
installLogCapture(app.getPath('userData'));
console.log(`[app] ${APP_NAME} ${app.getVersion()} 起動 / userData=${app.getPath('userData')}`);

// <img src="libcover://..."> を読ませるには ready 前の privileged 登録が要る
protocol.registerSchemesAsPrivileged([
  {
    scheme: COVER_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  },
  // mylib:// … 手元のファイル（音声のシーク・PDF・画像）
  LOCAL_SCHEME_PRIVILEGES
]);

/**
 * 多重起動を禁止する。
 * 同じ userData を複数プロセスが同時に触ると SQLite も Chromium のキャッシュも壊れる
 * （実際に library.db を破損させた）。2つ目は即終了し、既存ウィンドウを前面に出す。
 */
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#1b2838',
    autoHideMenuBar: true,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());

  // 外部リンクは既定のブラウザで開く（アプリ内で開かせない）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  if (!gotTheLock) return;
  registerCoverProtocol();

  applyPendingRestore(app.getPath('userData'));
  const { db, recoveredFrom, salvaged } = openDatabase(app.getPath('userData'));
  if (recoveredFrom) {
    // 破損DBは退避済み。読める表は写してあり、作り置き（中身の一覧・検索の索引）は使ううちに作り直される
    console.warn(`library.db が壊れていたため作り直しました。退避先: ${recoveredFrom} 写した行: ${JSON.stringify(salvaged)}`);
  }
  const repo = new Repo(db);
  // 画面の言語。設定が無ければ Windows の表示言語に合わせる（日本語以外は英語）
  // 設定が無ければ Windows の表示言語に合わせる（日本語・中国語以外は英語）
  setLang(normalizeLang(repo.getSetting('app.language')) ?? normalizeLang(app.getLocale()) ?? 'en');
  const sync = new SyncService(repo);

  const credentials = new CredentialStore(db, app.getPath('userData'));
  // 前の版で保存したID/PWには控えが無いので、起動時に作っておく
  try {
    const created = credentials.ensureBackups();
    console.log(`[credentials] 起動時の控え作成: ${created} 件`);
  } catch (err) {
    // 控えが作れなくても起動は続ける。理由は残す
    console.warn('[credentials] 控えを作れませんでした:', err);
  }
  // アーカイブの中の音声・動画をシークできるよう、必要なときだけ一時フォルダへ書き出す
  configureArchiveCache(path.join(app.getPath('temp'), `${APP_NAME}-cache`));
  void cleanCache();
  registerLocalProtocol({
    allowedPaths: () => repo.allLocalPaths(),
    sevenZip: () => findSevenZip(repo.getSetting('tools.sevenZip'), path.join(app.getPath('userData'), 'tools'))
  });

  const { metaCrawler, downloads, jobs } = registerIpc({
    repo,
    sync,
    credentials,
    getWindow: () => mainWindow
  });

  createWindow();

  // 同期の途中で終了すると表紙の先読みが中断され、次に開いたときサムネイルが
  // 出ない作品が残る。起動時にも取りこぼしぶんだけ拾いに行く（無ければ即終わる）。
  void cacheCovers(repo, (done) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('covers:progress', { done });
    }
  });

  // DMMの /dc 配下はアクセスのたびに巨大Cookieが増える。放置すると
  // Cookieヘッダが上限を超えて 400 になるので、起動時に整理しておく。
  void pruneOversizedCookies();

  // 作品メタの裏取得。起動直後は重いので少し置いてから動き出す。
  metaCrawler.start();
  // 前回の実行中だったダウンロードを待機に戻してから再開する
  downloads.start();
  // 展開・FLAC 変換。前回途中だったものはやり直す
  jobs.start();
  app.on('before-quit', () => {
    metaCrawler.stop();
    downloads.stop();
    jobs.stop();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// WALを畳んでから閉じる。閉じずに落とすとWALが肥大化し、
// 強制終了と重なったときにDB破損の温床になる。
let sessionFlushed = false;
let flushingSession = false;
app.on('before-quit', (event) => {
  if (sessionFlushed) { closeDatabase(); return; }
  event.preventDefault();
  if (flushingSession) return;
  flushingSession = true;
  // Cookie はメモリ上にも溜まる。終了時に書き出しておかないと、
  // 直前のログインが次回起動時に消えていることがある。
  void Promise.allSettled(SITES.map((site) => session.fromPartition(site.partition).cookies.flushStore())).finally(() => {
    sessionFlushed = true;
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
