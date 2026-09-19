import { ipcMain } from 'electron';
import { planRelocation } from '../download/relocate';
import type { IpcServices } from './services';

export function registerRelocationIpc({ repo, downloads, jobs }: Pick<IpcServices, "repo" | "downloads" | "jobs">) {
  // ── 保存先・フォルダ構成の変更に合わせた移動 ─────────────────
  ipcMain.handle('download:relocationPlan', () =>
    planRelocation(repo, downloads.settings().root, downloads.settings().template, downloads.knownRoots())
  );
  ipcMain.handle('download:relocate', async (_e, froms: string[]) => {
    const plan = await planRelocation(repo, downloads.settings().root, downloads.settings().template, downloads.knownRoots());
    const items = plan.items.filter((i) => froms.includes(i.from));
    if (items.length === 0) return null;
    return jobs.enqueueMove(items, downloads.knownRoots());
  });

}
