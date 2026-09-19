import { t } from '@shared/i18n';
import { dialog,ipcMain } from 'electron';
import type { IpcServices } from './services';

export function registerDownloadsIpc({ downloads, getWindow }: Pick<IpcServices, "downloads" | "getWindow">) {
  ipcMain.handle('download:enqueue', (_e, ids: number[]) => downloads.enqueue(ids));
  /** 動画を画質を選んで積む（選んだ画質は作品ごとに覚え、実行の直前に導線を取り直すときも同じ画質を選ぶ） */
  ipcMain.handle('download:enqueueVideo', (_e, id: number, qualityKey: string) => downloads.enqueueVideo(id, qualityKey));
  ipcMain.handle('download:redownload', (_e, id: number) => downloads.redownload(id));
  ipcMain.handle('download:list', () => downloads.list());
  ipcMain.handle('download:estimate', (_e, ids: number[]) => downloads.estimate(ids));
  ipcMain.handle('download:pause', (_e, id: number) => downloads.pause(id));
  ipcMain.handle('download:resume', (_e, id: number) => downloads.resume(id));
  ipcMain.handle('download:cancel', (_e, id: number) => downloads.cancel(id));
  ipcMain.handle('download:retry', (_e, id: number) => downloads.retry(id));
  ipcMain.handle('download:remove', (_e, id: number) => downloads.remove(id));
  ipcMain.handle('download:resumeAll', () => downloads.resumeAll());
  ipcMain.handle('download:pauseAll', () => downloads.pauseAll());
  ipcMain.handle('download:clearFinished', () => downloads.clearFinished());
  ipcMain.handle('download:settings', () => downloads.settings());
  ipcMain.handle(
    'download:saveSettings',
    (_e, next: { root?: string; template?: string; concurrency?: number; maxBytesPerSec?: number }) => {
      downloads.saveSettings(next);
      return downloads.settings();
    }
  );

  /** 保存先フォルダを選ぶ */
  ipcMain.handle('download:pickRoot', async () => {
    const win = getWindow();
    const options = {
      title: t('保存先フォルダを選ぶ'),
      defaultPath: downloads.settings().root,
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return downloads.settings();
    downloads.saveSettings({ root: result.filePaths[0] });
    return downloads.settings();
  });

}
