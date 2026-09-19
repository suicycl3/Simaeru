import { t } from '@shared/i18n';
import type { RefreshProgress } from '@shared/types';
import { ipcMain } from 'electron';
import fs from 'node:fs';
import { readZipIndex } from '../archive/zipReader';
import { isUnder } from '../content/localProtocol';
import { scanFolders } from '../import/scanner';
import type { IpcServices } from './services';

export function registerContentIpc({ contentCache, repo, send, downloads, refreshLinkCandidates, runCompilations }: Pick<IpcServices, "contentCache" | "repo" | "send" | "downloads" | "refreshLinkCandidates" | "runCompilations">) {
  // ── 中身（プレイヤー・ビューア） ───────────────────────────
  /** 作り置きをすぐ返す（台帳が変わっていれば裏で作り直して content:updated で知らせる） */
  ipcMain.handle('content:index', async (_e, productRef: number) => (await contentCache.getOrBuild(productRef)).index);
  /** 詳細を開いたときの確認。ファイルの有無だけを開かずに見る */
  ipcMain.handle('content:verify', (_e, productRef: number) => {
    // 詳細を開いた時点で、アーカイブを裏で一度開いておく。久しぶりに開くファイルは Windows の検査で
    // 初回だけ30秒ほど待たされ、ビューアを開いた直後の1枚目がなかなか出なかった（2枚目以降は速い）。
    // 待つのは裏の処理だけで、画面は止めない。
    for (const f of repo.localFiles(productRef)) {
      if (!f.missingAt && /\.zip$/i.test(f.path)) void readZipIndex(f.path).catch(() => undefined);
    }
    return contentCache.verify(productRef);
  });

  /** 手元の状態をまとめて最新にする: 保存先の新しいファイルの取り込み → 実体の有無 → 全作品の見取り図 */
  let refreshing: Promise<unknown> | null = null;
  ipcMain.handle('library:refreshLocal', () => {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const progress = (p: RefreshProgress): void => send('library:refreshProgress', p);
      progress({ phase: 'scan', done: 0, total: 0, message: t('保存先のファイルを確認しています') });
      // 展開したフォルダの中のファイルが個別に載っていたら外す（フォルダの一部として扱う）
      const nestedRemoved = repo.removeNestedLocalFiles(
        (child, folder) => child.toLowerCase() !== folder.toLowerCase() && isUnder(child, [folder])
      );
      const roots: string[] = [];
      for (const r of downloads.knownRoots()) {
        if (await fs.promises.access(r).then(() => true, () => false)) roots.push(r);
      }
      const scan = await scanFolders(repo, roots, (message) => progress({ phase: 'scan', done: 0, total: 0, message }));
      const result = await contentCache.refreshAll((done, total, title) =>
        progress({ phase: 'index', done, total, message: title ? t('中身を確認中: {title}', { title }) : t('中身を確認中') })
      );
      progress({ phase: 'index', done: result.products, total: result.products, message: t('紐付けの候補を探しています') });
      await refreshLinkCandidates();
      await runCompilations();
      progress({ phase: 'done', done: result.products, total: result.products, message: t('最新にしました') });
      send('library:filesChanged', { productRef: null });
      return { ...result, linked: scan.linked, pending: scan.pending.length, nestedRemoved };
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  });

}
