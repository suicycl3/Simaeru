import { getLang,normalizeLang,setLang,t } from '@shared/i18n';
import { app,dialog,ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { APP_NAME } from '@shared/appInfo';
import { logFromRenderer, readLog } from '../log';
import { checkLatestRelease } from '../maintenance/versionCheck';
import { isRemovableUserData, scheduleUserDataRemoval } from '../maintenance/userDataRemoval';
import type { IpcServices } from './services';

export function registerAppIpc({
  repo,
  getWindow,
  isBusy = () => false
}: Pick<IpcServices, 'repo' | 'getWindow'> & {
  /** 同期・ダウンロード・後処理の途中か（途中ならデータを消して終了しない） */
  isBusy?: () => boolean;
}) {
  // ── このアプリについて ───────────────────────────────────
  ipcMain.handle('app:about', async () => {
    const read = (name: string): Promise<string | null> =>
      fs.promises.readFile(path.join(app.getAppPath(), name), 'utf8').catch(() => null);
    return {
      version: app.getVersion(),
      userData: app.getPath('userData'),
      // 英語表示なら英語版の一覧（無ければ日本語版）
      notices:
        // 中国語の版は作っていないので、英語版を出す
        (getLang() !== 'ja' ? await read('THIRD_PARTY_NOTICES.en.md') : null) ??
        (await read('THIRD_PARTY_NOTICES.md')) ??
        t('THIRD_PARTY_NOTICES.md が見つかりませんでした。')
    };
  });

  /** アプリログの書き出し。動きの記録（console に出しているもの）をファイルに保存する */
  ipcMain.handle('app:saveLog', async () => {
    const win = getWindow();
    const options = {
      defaultPath: `${APP_NAME}-log-${new Date().toISOString().slice(0, 10)}.txt`,
      filters: [{ name: 'Log', extensions: ['txt', 'log'] }]
    };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    const header = [
      `${APP_NAME} ${app.getVersion()}`,
      `${process.platform} ${process.getSystemVersion?.() ?? ''} / Electron ${process.versions.electron}`,
      `userData: ${app.getPath('userData')}`,
      `書き出し: ${new Date().toISOString()}`,
      ''
    ].join('\n');
    await fs.promises.writeFile(result.filePath, header + readLog(), 'utf8');
    return result.filePath;
  });

  // ── 新しい版の確認（押したときだけ。自動では通信しない） ──
  ipcMain.handle('app:checkUpdate', () => checkLatestRelease(app.getVersion()));

  // ── ユーザーデータを削除して終了 ──
  // データのフォルダはアプリが開いているので、アプリが終わるのを待って消す処理を残してから終了する。
  // ダウンロードした作品のファイルはこのフォルダの外にあるので消さない
  ipcMain.handle('app:deleteUserDataAndQuit', () => {
    if (isBusy()) throw new Error(t('同期・ダウンロード・後処理の途中です。終わってから、もう一度お試しください。'));
    const dir = app.getPath('userData');
    if (!isRemovableUserData(dir)) throw new Error(t('データのフォルダとして確かめられなかったので、消しませんでした: {0}', { 0: dir }));
    console.log(`[app] ユーザーデータを削除して終了します: ${dir}`);
    scheduleUserDataRemoval(dir);
    setTimeout(() => app.quit(), 200);
    return dir;
  });

  /** 画面側で起きたことも同じ記録に残す */
  ipcMain.on('app:log', (_e, level: 'log' | 'warn' | 'error', message: string) => {
    logFromRenderer(level === 'warn' || level === 'error' ? level : 'log', String(message).slice(0, 2000));
  });

  // ── 画面の言語 ──
  // preload が読み込み時に同期で聞く（モジュールの定数も正しい言語で作れるように）
  ipcMain.on('app:langSync', (e) => {
    e.returnValue = getLang();
  });
  ipcMain.handle('app:setLanguage', (_e, lang: string) => {
    const next = normalizeLang(lang);
    if (!next) throw new Error(`unsupported language: ${lang}`);
    repo.setSetting('app.language', next);
    setLang(next);
    // 画面の文言はモジュールの読み込み時にも作るので、読み直して切り替える
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.reload();
    return next;
  });

}
