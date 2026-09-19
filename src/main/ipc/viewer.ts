import { t } from '@shared/i18n';
import { ipcMain,shell } from 'electron';
import { DMM_PLAYER_FILE,dmmPlayerStatus,openInDmmPlayer } from '../install/dmmPlayer';
import { openInNeeView } from '../viewer/neeview';
import type { IpcServices } from './services';

export function registerViewerIpc({ jobs, repo }: Pick<IpcServices, "jobs" | "repo">) {
  // ── 閲覧 ───────────────────────────────────────────────
  ipcMain.handle('viewer:neeview', () => jobs.tools().neeview);

  ipcMain.handle('viewer:setNeeView', (_e, exePath: string) => {
    jobs.saveSettings({ neeviewPath: exePath });
    return jobs.tools().neeview;
  });

  /** DMM Player（動画の公式プレイヤー）が入っているか */
  ipcMain.handle('install:dmmPlayerStatus', () => dmmPlayerStatus());
  /** ダウンロードした DRM 付きの動画を DMM Player で開く（その作品の手元のファイルだけ） */
  ipcMain.handle('viewer:openDmmPlayer', async (_e, productRef: number, filePath: string) => {
    if (!DMM_PLAYER_FILE.test(filePath) || !repo.localFiles(productRef).some((f) => f.path === filePath && !f.missingAt)) {
      throw new Error(t('この作品のファイルではありません'));
    }
    await openInDmmPlayer(filePath);
    repo.markViewed(productRef);
  });

  ipcMain.handle('viewer:open', (_e, filePath: string, prefer: 'neeview' | 'default') => {
    if (prefer === 'neeview') {
      const exe = jobs.tools().neeview;
      if (exe) return openInNeeView(exe, filePath);
    }
    return shell.openPath(filePath);
  });

  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (!/^https?:\/\//.test(url)) throw new Error(t('外部リンクとして開けないURLです'));
    return shell.openExternal(url);
  });

}
