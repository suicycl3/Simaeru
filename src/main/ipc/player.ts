import { ipcMain } from 'electron';
import type { IpcServices } from './services';

export function registerPlayerIpc({ repo }: Pick<IpcServices, "repo">) {
  /** 聴いた位置・読んだ位置。作品ごとに1つ */
  ipcMain.handle('player:getState', (_e, productRef: number) => {
    const raw = repo.getSetting(`player.state.${productRef}`);
    try {
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  ipcMain.handle('player:setState', (_e, productRef: number, state: unknown) => {
    repo.setSetting(`player.state.${productRef}`, JSON.stringify(state ?? null));
  });

}
