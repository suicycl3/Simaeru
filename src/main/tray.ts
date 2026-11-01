import path from 'node:path';
import { app, dialog, ipcMain, Menu, nativeImage, Tray, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { APP_NAME } from '@shared/appInfo';
import { t } from '@shared/i18n';
import { mcpStateLabel } from '@shared/mcpTools';
import type { McpStatus } from '@shared/types';
import type { Repo } from './db/repo';
import { HIDDEN_ARG } from './startup';

/**
 * 閉じるボタン（×）を押したときに、タスクトレイに常駐するか、終了するか。
 * MCP サーバーとして動かしておきたいときなど、窓を閉じてもアプリを動かしたままにできる。
 *
 * - 設定 `app.closeAction`: ask（毎回確認する・既定）/ tray（常駐）/ quit（終了）
 * - 確認するときは「次回から確認しない」を選べる（設定の「全般」で戻せる）
 * - 常駐したら、タスクトレイのアイコンから表示・終了する
 * - トレイの「終了」・ほかの道筋の終了（復元して再起動など）では、確認せずに閉じる
 * - 常駐にしていると × では終わらないので、終了・再起動は設定（全般）とトレイのメニューからできる
 * - トレイのメニューから、設定と MCP サーバーの起動・停止を開ける
 */

export type CloseAction = 'ask' | 'tray' | 'quit';
const SETTING = 'app.closeAction';
/** タスクバーのジャンプリストから「設定を開く」で起動されたとき */
export const OPEN_SETTINGS_ARG = '--open-settings';

/** トレイのメニューから動かす MCP サーバー（mcp/mcpServer.ts の McpService） */
interface McpControl {
  status(): McpStatus;
  setEnabled(enabled: boolean): Promise<McpStatus>;
  restart(): Promise<McpStatus>;
  onChange(listener: (status: McpStatus) => void): () => void;
}

/** 再起動したときの引数。トレイで起動した・設定を開いた、の印は引き継がない */
export function relaunchArgs(argv: string[] = process.argv): string[] {
  return argv.slice(1).filter((a) => a !== HIDDEN_ARG && a !== OPEN_SETTINGS_ARG);
}

export function closeActionOf(repo: Pick<Repo, 'getSetting'>): CloseAction {
  const v = repo.getSetting(SETTING);
  return v === 'tray' || v === 'quit' ? v : 'ask';
}

export function setupCloseToTray(opts: {
  repo: Repo;
  getWindow: () => BrowserWindow | null;
  /** 設定を開く（section を渡すとその見出しを開く） */
  openSettings: (section?: string) => void;
  onHidden?: () => void;
}): {
  attach: (win: BrowserWindow) => void;
  showWindow: () => void;
  /** タスクトレイのアイコンを出す（窓を出さずに起動したとき） */
  ensureTray: () => void;
  /** DB を開いたあとにできるもの（MCP サーバー・同期中か）をつなぐ */
  connect: (controls: { mcp: McpControl; isSyncing: () => boolean }) => void;
} {
  const { repo, getWindow } = opts;
  let quitting = false;
  let tray: Tray | null = null;
  let mcp: McpControl | null = null;
  let isSyncing: () => boolean = () => false;
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

  /** 終了する。restart なら、終わったあとに起動し直す（途中のダウンロードは次の起動で続きから） */
  const quitApp = (restart: boolean): void => {
    quitting = true;
    if (restart) app.relaunch({ args: relaunchArgs() });
    app.quit();
  };

  const openSettings = (section?: string): void => {
    showWindow();
    opts.openSettings(section);
  };

  const mcpMenu = (status: McpStatus): MenuItemConstructorOptions => ({
    label: t('MCP サーバー: {0}', { 0: mcpStateLabel(status) }),
    submenu: [
      // 起動できなかった（ポートが使われていたなど）ときは、やり直す
      { label: t('起動する'), enabled: !status.running, click: () => void (status.enabled ? mcp?.restart() : mcp?.setEnabled(true)) },
      { label: t('停止する'), enabled: status.enabled, click: () => void mcp?.setEnabled(false) },
      { label: t('再起動する'), enabled: status.enabled, click: () => void mcp?.restart() },
      { type: 'separator' },
      { label: t('MCP の設定を開く'), click: () => openSettings('mcp') }
    ]
  });

  const rebuildMenu = (): void => {
    if (!tray) return;
    const template: MenuItemConstructorOptions[] = [
      { label: t('{0} を表示', { 0: APP_NAME }), click: showWindow },
      { label: t('設定'), click: () => openSettings() },
      { type: 'separator' },
      ...(mcp ? [mcpMenu(mcp.status()), { type: 'separator' } as MenuItemConstructorOptions] : []),
      { label: t('再起動'), click: () => quitApp(true) },
      { label: t('終了'), click: () => quitApp(false) }
    ];
    tray.setContextMenu(Menu.buildFromTemplate(template));
  };

  const ensureTray = (): void => {
    if (tray) return;
    // tray.png（16px）と tray@2x.png（32px）。画面の倍率に合わせて選ばれる
    const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'tray.png'));
    tray = new Tray(icon);
    tray.setToolTip(APP_NAME);
    rebuildMenu();
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
  };

  const connect = (controls: { mcp: McpControl; isSyncing: () => boolean }): void => {
    mcp = controls.mcp;
    isSyncing = controls.isSyncing;
    // 設定・ステータスバーから変えても、トレイのメニューの表示を合わせる
    mcp.onChange(() => rebuildMenu());
    rebuildMenu();
  };

  /** 終了・再起動で止まってしまう処理の名前 */
  const busyWork = (): string[] => {
    const active = (state: string): boolean => state === 'running' || state === 'queued';
    return [
      ...(repo.listDownloads(100000).some((r) => active(r.state)) ? [t('ダウンロード')] : []),
      ...(repo.listJobs().some((r) => active(r.state)) ? [t('展開・変換')] : []),
      ...(isSyncing() ? [t('同期')] : [])
    ];
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
            quitApp(false);
          }
        });
    });
  };

  ipcMain.handle('app:closeAction', () => closeActionOf(repo));
  ipcMain.handle('app:setCloseAction', (_e, action: CloseAction) => {
    repo.setSetting(SETTING, action === 'tray' || action === 'quit' ? action : 'ask');
    return closeActionOf(repo);
  });

  /**
   * 画面（設定の「全般」）からの終了・再起動。
   * 動いている処理があるときだけ確かめる（ダウンロード・展開は次の起動で続きから、同期は止まる）
   */
  ipcMain.handle('app:quit', async (_e, restart: boolean) => {
    const busy = busyWork();
    if (busy.length > 0) {
      const win = getWindow();
      const box = {
        type: 'warning' as const,
        title: APP_NAME,
        message: restart ? t('{0} を再起動しますか？', { 0: APP_NAME }) : t('{0} を終了しますか？', { 0: APP_NAME }),
        detail: t('{0}の途中です。ダウンロードと展開・変換は、次に起動したときに続きから進めます。同期は止まります。', { 0: busy.join('・') }),
        buttons: [restart ? t('再起動') : t('終了'), t('キャンセル')],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      };
      const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, box) : await dialog.showMessageBox(box);
      if (response !== 0) return false;
    }
    quitApp(!!restart);
    return true;
  });

  return { attach, showWindow, ensureTray, connect };
}
