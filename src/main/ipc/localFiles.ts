import { t } from '@shared/i18n';
import type { TrashPlan,TrashResult } from '@shared/types';
import { ipcMain,shell } from 'electron';
import fs from 'node:fs';
import { isUnder } from '../content/localProtocol';
import type { IpcServices } from './services';

export function registerLocalFilesIpc({ repo, downloads, filesChanged, jobs, send }: Pick<IpcServices, "repo" | "downloads" | "filesChanged" | "jobs" | "send">) {
  /** 作品ごとの手元のファイルと、落とせる導線の数 */
  ipcMain.handle('library:files2', (_e, id: number) => {
    const product = repo.getProduct(id);
    return {
      files: repo.localFiles(id),
      downloadable: product ? downloads.linksFor(product).length : 0
    };
  });

  /** 台帳から外す（ファイルそのものは消さない）。見つからなくなったファイルの片付け用 */
  ipcMain.handle('library:removeFile', (_e, productRef: number, filePath: string) => {
    if (!repo.localFiles(productRef).some((f) => f.path === filePath)) throw new Error(t('この作品のファイルではありません'));
    repo.removeLocalFile(filePath);
    filesChanged(productRef);
    return true;
  });

  // ── 手元のファイルを消す ────────────────────────────────
  /** その作品が、ダウンロード中・展開などの処理中か（消すと処理が壊れる） */
  const busyReason = (productRef: number): string | null => {
    if (downloads.list().some((d) => d.productRef === productRef && (d.state === 'running' || d.state === 'queued'))) {
      return t('ダウンロード中・待機中の作品です。終わってから削除してください。');
    }
    if (jobs.list().some((j) => j.productRef === productRef && (j.state === 'running' || j.state === 'queued'))) {
      return t('展開・変換の処理中です。終わってから削除してください。');
    }
    return null;
  };

  /**
   * 手元のファイルをごみ箱へ入れて、台帳から外す。only を省くと、その作品のファイルをすべて。
   * - インストール先のフォルダを消したときは、インストールの紐付けも外す
   * - ファイルが残らなければ「完了」のダウンロード行も消す（もう一度ダウンロードできるように）
   */
  const trashLocalFiles = async (productRef: number, only?: string[]): Promise<TrashResult> => {
    const product = repo.getProduct(productRef);
    if (!product) throw new Error(t('作品が見つかりません'));
    const busy = busyReason(productRef);
    if (busy) throw new Error(busy);
    const all = repo.localFiles(productRef);
    const targets = only ? all.filter((f) => only.includes(f.path)) : all;
    if (only && targets.length !== only.length) throw new Error(t('この作品のファイルではありません'));
    const result: TrashResult = { products: 0, removed: 0, bytes: 0, failed: [] };
    const trashed: string[] = [];
    for (const f of targets) {
      if (!f.missingAt) {
        try {
          await shell.trashItem(f.path);
        } catch (err) {
          // もう無いなら台帳から外すだけでよい。あるのに消せない（使用中など）なら残す
          if (await fs.promises.access(f.path).then(() => true, () => false)) {
            result.failed.push({ path: f.path, error: err instanceof Error ? err.message : String(err) });
            continue;
          }
        }
      }
      repo.removeLocalFile(f.path);
      trashed.push(f.path);
      result.removed++;
      result.bytes += f.missingAt ? 0 : (f.sizeBytes ?? 0);
    }
    // 消したフォルダの中にある行（展開したフォルダの中身など）も外す
    for (const f of repo.localFiles(productRef)) {
      if (isUnder(f.path, trashed)) repo.removeLocalFile(f.path);
    }
    const installPath = product.installation?.installPath;
    if (installPath && isUnder(installPath, trashed)) repo.removeInstallation(productRef);
    if (!repo.localFiles(productRef).some((f) => !f.missingAt)) downloads.forgetDone(productRef);
    if (trashed.length > 0) result.products = 1;
    filesChanged(productRef);
    send('library:changed', { productRef });
    return result;
  };

  ipcMain.handle('library:trashFiles', (_e, productRef: number, only?: string[]) => trashLocalFiles(productRef, only));

  /** まとめて消す前の見積もり */
  ipcMain.handle('library:trashPlan', (_e, ids: number[]): TrashPlan => {
    const plan: TrashPlan = { products: 0, files: 0, bytes: 0, busy: 0, installed: 0 };
    for (const id of ids) {
      const files = repo.localFiles(id).filter((f) => !f.missingAt);
      if (files.length === 0) continue;
      if (busyReason(id)) {
        plan.busy++;
        continue;
      }
      plan.products++;
      plan.files += files.length;
      plan.bytes += files.reduce((n, f) => n + (f.sizeBytes ?? 0), 0);
      const installPath = repo.getProduct(id)?.installation?.installPath;
      if (installPath && isUnder(installPath, files.map((f) => f.path))) plan.installed++;
    }
    return plan;
  });

  ipcMain.handle('library:trashMany', async (_e, ids: number[]): Promise<TrashResult> => {
    const total: TrashResult = { products: 0, removed: 0, bytes: 0, failed: [] };
    for (const id of ids) {
      if (!repo.localFiles(id).some((f) => !f.missingAt) || busyReason(id)) continue;
      try {
        const r = await trashLocalFiles(id);
        total.products += r.products;
        total.removed += r.removed;
        total.bytes += r.bytes;
        total.failed.push(...r.failed);
      } catch (err) {
        total.failed.push({ path: repo.getProduct(id)?.title ?? String(id), error: err instanceof Error ? err.message : String(err) });
      }
    }
    return total;
  });

}
