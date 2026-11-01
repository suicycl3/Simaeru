import { app, ipcMain } from 'electron';
import { APP_NAME } from '@shared/appInfo';
import type { StartupSettings } from '@shared/types';
import type { Repo } from './db/repo';

/**
 * Windows の起動時（サインイン時）に起動する。MCP サーバーやダウンロードのために常駐させたいとき用。
 *
 * - 設定 `app.openAtLogin`（既定はオフ）と `app.startInTray`（窓を出さずにタスクトレイで起動。既定はオン）
 * - 登録は Electron の setLoginItemSettings（現在のユーザーの「スタートアップ」）。オフにしたら外す
 * - 展開して使うアプリなのでフォルダごと動かされることがある。オンのあいだは起動のたびに今の場所で登録し直す
 * - タスクマネージャーの「スタートアップ アプリ」で無効にされていると起動しない。設定の画面でそれを知らせる
 */

const OPEN_AT_LOGIN = 'app.openAtLogin';
const START_IN_TRAY = 'app.startInTray';
/** サインイン時の起動に付ける引数。これが付いていたら窓を出さない */
export const HIDDEN_ARG = '--hidden';

/** 起動に使う引数。開発中（electron.exe）はアプリのフォルダも渡す */
export function loginArgs(packaged: boolean, appPath: string, hidden: boolean): string[] {
  return [...(packaged ? [] : [appPath]), ...(hidden ? [HIDDEN_ARG] : [])];
}

/** 窓を出さずに起動したか（サインイン時の起動で「タスクトレイで起動」のとき） */
export const launchedHidden = (argv: string[] = process.argv): boolean => argv.includes(HIDDEN_ARG);

export function setupStartup(repo: Pick<Repo, 'getSetting' | 'setSetting'>): void {
  const read = (): { openAtLogin: boolean; startInTray: boolean } => ({
    openAtLogin: repo.getSetting(OPEN_AT_LOGIN) === '1',
    startInTray: repo.getSetting(START_IN_TRAY) !== '0'
  });
  const options = (hidden: boolean): { path: string; args: string[] } => ({
    path: process.execPath,
    args: loginArgs(app.isPackaged, app.getAppPath(), hidden)
  });
  /**
   * 設定に合わせて登録する。
   * @param byUser 設定の画面で変えたとき。このときだけ「スタートアップ アプリ」の有効・無効も有効にする
   *   （起動のたびの登録し直しでは、タスクマネージャーで無効にした選択を打ち消さない）
   */
  const apply = (byUser: boolean): void => {
    const s = read();
    if (s.openAtLogin) {
      // 引数が変わると別の登録になるので、もう一方（窓を出す・出さない）の登録は外しておく
      app.setLoginItemSettings({ ...options(!s.startInTray), name: APP_NAME, openAtLogin: false });
      app.setLoginItemSettings({ ...options(s.startInTray), name: APP_NAME, openAtLogin: true, ...(byUser ? { enabled: true } : {}) });
    } else {
      for (const hidden of [true, false]) app.setLoginItemSettings({ ...options(hidden), name: APP_NAME, openAtLogin: false });
    }
  };
  const status = (): StartupSettings => {
    const s = read();
    const item = app.getLoginItemSettings(options(s.startInTray));
    return {
      ...s,
      // 登録はあるのに、タスクマネージャーの「スタートアップ アプリ」で無効にされている
      disabledByWindows: s.openAtLogin && item.openAtLogin && item.executableWillLaunchAtLogin === false
    };
  };

  // オンのあいだは、起動のたびに今の場所で登録し直す（フォルダを動かしても続けて起動できるように）
  if (read().openAtLogin) {
    try {
      apply(false);
    } catch (err) {
      console.warn('[startup] サインイン時の起動を登録し直せませんでした:', err);
    }
  }

  ipcMain.handle('app:startup', () => status());
  ipcMain.handle('app:setStartup', (_e, next: Partial<Pick<StartupSettings, 'openAtLogin' | 'startInTray'>>) => {
    if (typeof next.openAtLogin === 'boolean') repo.setSetting(OPEN_AT_LOGIN, next.openAtLogin ? '1' : '0');
    if (typeof next.startInTray === 'boolean') repo.setSetting(START_IN_TRAY, next.startInTray ? '1' : '0');
    apply(true);
    return status();
  });
}
