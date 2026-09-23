import { ipcMain } from 'electron';
import { t } from '@shared/i18n';
import type { IpcServices } from './services';

/**
 * プレイリスト（自分で作る一覧）の窓口。
 * 一覧の絞り込みは `library:query` の `playlistId` で行うので、ここは作る・名前を変える・出し入れするだけ。
 */
export function registerPlaylistsIpc({ repo, send }: Pick<IpcServices, 'repo' | 'send'>) {
  const changed = (): void => send('playlists:changed', { playlists: repo.listPlaylists() });

  ipcMain.handle('playlists:list', () => repo.listPlaylists());

  ipcMain.handle('playlists:create', (_e, name: string, productRefs: number[] = []) => {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) throw new Error(t('プレイリストの名前を入れてください。'));
    const playlist = repo.createPlaylist(trimmed.slice(0, 100));
    if (productRefs.length > 0) repo.addToPlaylist(playlist.id, productRefs);
    changed();
    return repo.getPlaylist(playlist.id);
  });

  ipcMain.handle('playlists:rename', (_e, id: number, name: string) => {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) throw new Error(t('プレイリストの名前を入れてください。'));
    repo.renamePlaylist(id, trimmed.slice(0, 100));
    changed();
    return repo.getPlaylist(id);
  });

  ipcMain.handle('playlists:delete', (_e, id: number) => {
    repo.deletePlaylist(id);
    changed();
    return true;
  });

  /** 末尾に足す。すでに入っているものは足さない。戻り値は足した数 */
  ipcMain.handle('playlists:add', (_e, id: number, productRefs: number[]) => {
    const added = repo.addToPlaylist(id, productRefs ?? []);
    changed();
    return added;
  });

  ipcMain.handle('playlists:remove', (_e, id: number, productRefs: number[]) => {
    const removed = repo.removeFromPlaylist(id, productRefs ?? []);
    changed();
    return removed;
  });

  /** その作品が入っているプレイリスト（詳細で出す） */
  ipcMain.handle('playlists:of', (_e, productRef: number) => repo.playlistsOf(productRef));
}
