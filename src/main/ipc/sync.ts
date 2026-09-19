import { t } from '@shared/i18n';
import { ipcMain } from 'electron';
import type { Repo } from '../db/repo';
import type { SyncService } from '../sync/syncService';

type Deps = {
  repo: Repo;
  sync: SyncService;
  afterSync: () => void;
};

export function registerSyncIpc({ repo, sync, afterSync }: Deps): void {
  ipcMain.handle('sync:history', () => repo.syncHistory());
  ipcMain.handle('sync:start', async (_e, floorKeys: string[], opts?: { full?: boolean }) => {
    if (sync.isRunning) throw new Error(t('同期はすでに実行中です'));
    const summary = await sync.run(floorKeys, { full: opts?.full });
    afterSync();
    return summary;
  });

  ipcMain.handle('sync:cancel', () => {
    sync.cancel();
    return true;
  });

  ipcMain.handle('sync:lastAt', () => repo.lastSuccessfulSyncAt());

}
