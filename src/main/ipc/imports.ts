import { t } from '@shared/i18n';
import { dialog,ipcMain } from 'electron';
import fs from 'node:fs';
import { scanFolders } from '../import/scanner';
import type { IpcServices } from './services';

export function registerImportsIpc({ repo, downloads, getWindow, send, filesChanged }: Pick<IpcServices, "repo" | "downloads" | "getWindow" | "send" | "filesChanged">) {
  // ── 取り込み（手元のファイル） ─────────────────────────
  /** 走査するフォルダ。既定はダウンロード先。設定で足せる */
  const SETTING_SCAN_DIRS = 'import.folders';
  const scanFolderList = (): string[] => {
    try {
      const raw = repo.getSetting(SETTING_SCAN_DIRS);
      const list = raw ? (JSON.parse(raw) as string[]) : [];
      return list.length ? list : [downloads.settings().root];
    } catch {
      return [downloads.settings().root];
    }
  };

  ipcMain.handle('import:folders', () => scanFolderList());

  ipcMain.handle('import:addFolder', async () => {
    const win = getWindow();
    const options = {
      title: t('取り込むフォルダを選ぶ'),
      properties: ['openDirectory'] as Array<'openDirectory'>
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return scanFolderList();
    const next = [...new Set([...scanFolderList(), ...result.filePaths])];
    repo.setSetting(SETTING_SCAN_DIRS, JSON.stringify(next));
    return next;
  });

  ipcMain.handle('import:removeFolder', (_e, folder: string) => {
    const next = scanFolderList().filter((f) => f !== folder);
    repo.setSetting(SETTING_SCAN_DIRS, JSON.stringify(next));
    return next;
  });

  /** 走査は時間がかかるので、進捗をイベントで流しながら動かす */
  ipcMain.handle('import:scan', async () => {
    const folders = scanFolderList();
    // 実体が消えたものに印を付けてから走査する
    await repo.markMissingFilesAsync((p2) => fs.promises.access(p2).then(() => true, () => false));
    return scanFolders(repo, folders, (message) => send('import:progress', { message }));
  });

  const addScanned = async (filePath: string, productRef: number | null, sizeBytes: number | null) => {
    // フォルダとして取り込んだものは、展開済みフォルダと同じく中身を見て扱う（FLAC 変換・起動の判定など）
    const stat = await fs.promises.stat(filePath).catch(() => null);
    const kind: string | null = stat?.isDirectory() ? 'folder' : null;
    repo.addLocalFile({
      productRef,
      path: filePath,
      sizeBytes,
      kind,
      source: 'scan'
    });
  };

  /** 候補から選んで紐付ける */
  ipcMain.handle(
    'import:link',
    async (_e, filePath: string, productRef: number | null, sizeBytes: number | null) => {
      await addScanned(filePath, productRef, sizeBytes);
      filesChanged(productRef);
      return true;
    }
  );

  /** 同じフォルダのファイルをまとめて紐付ける（画面の通知は最後に1回だけ） */
  ipcMain.handle(
    'import:linkMany',
    async (_e, files: Array<{ path: string; sizeBytes: number | null }>, productRef: number | null) => {
      for (const file of files) await addScanned(file.path, productRef, file.sizeBytes ?? null);
      filesChanged(productRef);
      return files.length;
    }
  );

}
