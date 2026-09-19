import { t } from '@shared/i18n';
import { archiveWorkType } from '@shared/storagePolicy';
import type { FlacOriginal,PostProcessSettings } from '@shared/types';
import { dialog,ipcMain,shell } from 'electron';
import fs from 'node:fs';
import { listArchiveEntries } from '../archive/archiveAccess';
import { isArchiveFile } from '../archive/sevenZip';
import {
isProductPath
} from '../install/installService';
import { estimateFlac } from '../media/flac';
import type { IpcServices } from './services';

export function registerJobsIpc({ repo, jobs, getWindow, filesChanged }: Pick<IpcServices, "repo" | "jobs" | "getWindow" | "filesChanged">) {
  // ── 展開・FLAC 変換 ─────────────────────────────────────
  /** レンダラから渡されたパスは、その作品の手元のファイル配下に限る */
  const assertProductPath = (productRef: number, target: string): void => {
    if (!isProductPath(repo, productRef, target)) throw new Error(t('この作品のファイルではありません'));
  };

  ipcMain.handle('jobs:list', () => jobs.list());
  ipcMain.handle('jobs:settings', () => ({ settings: jobs.settings(), tools: jobs.tools() }));
  ipcMain.handle('jobs:saveSettings', (_e, next: Partial<PostProcessSettings>) => {
    jobs.saveSettings(next);
    return { settings: jobs.settings(), tools: jobs.tools() };
  });
  ipcMain.handle('jobs:pickTool', async (_e, kind: 'sevenZip' | 'ffmpeg') => {
    const win = getWindow();
    const options = {
      title: kind === 'sevenZip' ? t('7z.exe を選ぶ') : t('ffmpeg.exe を選ぶ'),
      filters: [{ name: t('実行ファイル'), extensions: ['exe'] }],
      properties: ['openFile'] as Array<'openFile'>
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (!result.canceled && result.filePaths[0]) {
      jobs.saveSettings(kind === 'sevenZip' ? { sevenZipPath: result.filePaths[0] } : { ffmpegPath: result.filePaths[0] });
    }
    return { settings: jobs.settings(), tools: jobs.tools() };
  });
  /** archived: 圧縮したまま持つ作品を、あえて展開して使うとき（zip を消すかは別の設定） */
  ipcMain.handle('jobs:extract', (_e, productRef: number, archive: string, archived?: boolean) => {
    assertProductPath(productRef, archive);
    const s = jobs.settings();
    // 消すかどうかは作品の扱いと設定で決まる
    return jobs.enqueueExtract(
      productRef,
      archive,
      false,
      archived
        ? { deleteArchive: s.archiveHandling[archiveWorkType(repo.getProduct(productRef) ?? { workType: null })] === 'extractDelete', archivedToo: true }
        : { deleteArchive: s.deleteArchiveAfterExtract }
    );
  });
  ipcMain.handle('jobs:flacEstimate', async (_e, productRef: number, target: string) => {
    assertProductPath(productRef, target);
    if (isArchiveFile(target)) {
      const listing = await listArchiveEntries(target, jobs.tools().sevenZip);
      const wavs = listing.entries.filter((e) => !e.isDir && /\.wav$/i.test(e.path));
      const bytes = wavs.reduce((sum, e) => sum + e.size, 0);
      return { files: wavs.length, bytes, estimatedBytes: Math.round(bytes * 0.55) };
    }
    return estimateFlac(target);
  });
  ipcMain.handle('jobs:flac', (_e, productRef: number, target: string, original: FlacOriginal) => {
    assertProductPath(productRef, target);
    return jobs.enqueueFlac(productRef, target, original);
  });
  /** MP3 などがある WAV / FLAC を消す（アーカイブは作り直す） */
  ipcMain.handle('jobs:lossyOnly', (_e, productRef: number, target: string, original: FlacOriginal) => {
    assertProductPath(productRef, target);
    return jobs.enqueueLossyOnly(productRef, target, original);
  });
  ipcMain.handle('jobs:stripPdf', (_e, productRef: number, target: string, original: FlacOriginal) => {
    assertProductPath(productRef, target);
    return jobs.enqueueStripPdf(productRef, target, original);
  });
  ipcMain.handle('jobs:cancel', (_e, id: number) => jobs.cancel(id));
  ipcMain.handle('jobs:retry', (_e, id: number) => jobs.retry(id));
  ipcMain.handle('jobs:remove', (_e, id: number) => jobs.remove(id));
  ipcMain.handle('jobs:forProduct', (_e, productRef: number) => repo.jobsForProduct(productRef));
  /**
   * 展開したフォルダを消す（圧縮のまま持つ作品で、アーカイブが残っているときだけ）。
   * 消すのはフォルダだけで、元のアーカイブから何度でも作り直せる。ごみ箱へ入れる。
   */
  ipcMain.handle('jobs:removeExtracted', async (_e, productRef: number, folder: string) => {
    const row = repo.localFiles(productRef).find((f) => f.path === folder && f.kind === 'folder');
    if (!row?.derivedFrom) throw new Error(t('展開してできたフォルダではありません'));
    if (!(await fs.promises.access(row.derivedFrom).then(() => true, () => false))) {
      throw new Error(t('元のアーカイブが無いため、このフォルダは消せません'));
    }
    await shell.trashItem(folder);
    repo.removeLocalFile(folder);
    filesChanged(productRef);
    return true;
  });

}
