import path from 'node:path';
import { app, dialog, ipcMain, Menu, nativeImage, Tray, type BrowserWindow } from 'electron';
import { APP_NAME } from '@shared/appInfo';
import { t } from '@shared/i18n';
import type { Repo } from './db/repo';

/**
 * 閉じるボタン（×）を押したときに、タスクトレイに常駐するか、終了するか。
 * MCP サーバーとして動かしておきたいときなど、窓を閉じてもアプリを動かしたままにできる。
 *
 * - 設定 `app.closeAction`: ask（毎回確認する・既定）/ tray（常駐）/ quit（終了）
 * - 確認するときは「次回から確認しない」を選べる（設定の「全般」で戻せる）
 * - 常駐したら、タスクトレイのアイコンから表示・終了する
 * - トレイの「終了」・ほかの道筋の終了（復元して再起動など）では、確認せずに閉じる
 */

export type CloseAction = 'ask' | 'tray' | 'quit';
const SETTING = 'app.closeAction';

export function closeActionOf(repo: Pick<Repo, 'getSetting'>): CloseAction {
  const v = repo.getSetting(SETTING);
  return v === 'tray' || v === 'quit' ? v : 'ask';
}

export function setupCloseToTray(opts: { repo: Repo; getWindow: () => BrowserWindow | null; onHidden?: () => void }): {
  attach: (win: BrowserWindow) => void;
  showWindow: () => void;
} {
  const { repo, getWindow } = opts;
  let quitting = false;
  let tray: Tray | null = null;
  // 終了の道筋（トレイの「終了」・app.quit()）では、閉じるのを止めない
  app.on('before-quit', () => {
    quitting = true;
  });

  const showWindow = (): void => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  const ensureTray = (): void => {
    if (tray) return;
    // tray.png（16px）と tray@2x.png（32px）。画面の倍率に合わせて選ばれる
    const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'tray.png'));
    tray = new Tray(icon);
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: t('{0} を表示', { 0: APP_NAME }), click: showWindow },
        { type: 'separator' },
        {
          label: t('終了'),
          click: () => {
            quitting = true;
            app.quit();
          }
        }
      ])
    );
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
  };

  const hideToTray = (win: BrowserWindow): void => {
    ensureTray();
    win.hide();
    opts.onHidden?.();
  };

  const attach = (win: BrowserWindow): void => {
    win.on('close', (event) => {
      if (quitting) return;
      const action = closeActionOf(repo);
      if (action === 'quit') return;
      event.preventDefault();
      if (action === 'tray') {
        hideToTray(win);
        return;
      }
      // 毎回確認する
      void dialog
        .showMessageBox(win, {
          type: 'question',
          title: APP_NAME,
          message: t('{0} を終了しますか？', { 0: APP_NAME }),
          detail: t('タスクトレイに常駐すると、ウィンドウを閉じてもダウンロードや MCP サーバーは動き続けます。'),
          buttons: [t('タスクトレイに常駐'), t('終了'), t('キャンセル')],
          defaultId: 0,
          cancelId: 2,
          checkboxLabel: t('次回から確認しない（設定の「全般」で変更できます）'),
          noLink: true
        })
        .then(({ response, checkboxChecked }) => {
          if (response === 2) return;
          const chosen: CloseAction = response === 0 ? 'tray' : 'quit';
          if (checkboxChecked) repo.setSetting(SETTING, chosen);
          if (chosen === 'tray') hideToTray(win);
          else {
            quitting = true;
            app.quit();
          }
        });
    });
  };

  ipcMain.handle('app:closeAction', () => closeActionOf(repo));
  ipcMain.handle('app:setCloseAction', (_e, action: CloseAction) => {
    repo.setSetting(SETTING, action === 'tray' || action === 'quit' ? action : 'ask');
    return closeActionOf(repo);
  });

  return { attach, showWindow };
}
