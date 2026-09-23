import { APP_NAME } from '@shared/appInfo';
import { app,BrowserWindow,ipcMain,shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { CredentialStore } from './auth/credentials';
import { ContentCache } from './content/contentCache';
import { registerBackupIpc } from './db/backup';
import type { Repo } from './db/repo';
import { DownloadManager } from './download/downloadManager';
import { cacheCovers } from './images/imageCache';
import { registerAppIpc } from './ipc/app';
import { registerAuthIpc } from './ipc/auth';
import { registerBrowserIpc } from './ipc/browser';
import { registerContentIpc } from './ipc/content';
import { registerDownloadsIpc } from './ipc/downloads';
import { registerImportsIpc } from './ipc/imports';
import { registerInstallIpc } from './ipc/install';
import { registerJobsIpc } from './ipc/jobs';
import { registerLibraryIpc } from './ipc/library';
import { registerLocalFilesIpc } from './ipc/localFiles';
import { registerPlaylistsIpc } from './ipc/playlists';
import { registerPlayerIpc } from './ipc/player';
import { registerRelocationIpc } from './ipc/relocation';
import { registerSyncIpc } from './ipc/sync';
import { registerToolsIpc } from './ipc/tools';
import { registerViewerIpc } from './ipc/viewer';
import { JobRunner } from './jobs/jobRunner';
import { MetaCrawler } from './meta/metaCrawler';
import type { SyncService } from './sync/syncService';

interface Deps {
  repo: Repo;
  sync: SyncService;
  credentials: CredentialStore;
  getWindow: () => BrowserWindow | null;
}

export function registerIpc({
  repo,
  sync,
  credentials,
  getWindow
}: Deps): { metaCrawler: MetaCrawler; downloads: DownloadManager; jobs: JobRunner } {
  const send = (channel: string, payload: unknown): void => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  sync.on('progress', (p) => send('sync:progress', p));
  registerBackupIpc(() => sync.isRunning || repo.listDownloads().some((r) => ['running', 'queued'].includes(r.state)) || repo.listJobs().some((r) => ['running', 'queued'].includes(r.state)));

  const auth = registerAuthIpc({ repo, credentials, send });

  const { fetchDetail, scheduleCompilations, runCompilations } = registerLibraryIpc({ repo, send });

  registerSyncIpc({ repo, sync, afterSync: () => {
    void refreshLinkCandidates();
    scheduleCompilations(1_000);
    void cacheCovers(repo, (done) => send('covers:progress', { done }));
  } });

  // ── ダウンロード ───────────────────────────────────────
  // 実体の取得は downloadManager が受け持つ。URLは実行の直前に取り直す。
  const freeBytes = (dir: string): number | null => {
    try {
      const st = fs.statfsSync(dir);
      return st.bavail * st.bsize;
    } catch {
      return null;
    }
  };

  // 展開・FLAC 変換のキュー。ダウンロードが終わったら（設定しだいで）自動で積む
  // 作品の中身の見取り図とインストール判定の作り置き（詳細を開くたびに読み直さない）
  const contentCache = new ContentCache({
    repo,
    sevenZip: () => jobs.tools().sevenZip,
    onUpdated: (productRef) => send('content:updated', { productRef })
  });
  const filesChanged = (productRef: number | null): void => {
    send('library:filesChanged', { productRef });
    if (productRef !== null) contentCache.schedule(productRef);
  };

  const toolsDir = path.join(app.getPath('userData'), 'tools');
  const workDir = path.join(app.getPath('temp'), `${APP_NAME}-work`);
  const jobs = new JobRunner({
    repo,
    onProgress: (rows) => send('jobs:progress', rows),
    onLocalFilesChanged: (productRef) => filesChanged(productRef),
    trashItem: (p2) => shell.trashItem(p2),
    freeBytes,
    workDir,
    toolsDir
  });
  // 解凍するだけの exe（自己解凍書庫）を台帳から覚え直し、まだ調べていないものは画面が落ち着いてから裏で調べる
  jobs.restoreSelfExtracting();
  const sfxScan = setTimeout(() => {
    void jobs
      .extractDownloadedSelfExtracting()
      .then((n) => n > 0 && console.log(`[jobs] 解凍するだけの exe を ${n} 作品ぶん見つけ、設定に従って展開に回しました`))
      .catch((err) => console.warn('[jobs] 自己解凍の exe の確認に失敗:', err));
  }, 15_000);
  sfxScan.unref?.();

  const downloads = new DownloadManager({
    repo,
    fetchDetail,
    onProgress: (rows) => send('download:progress', rows),
    onFinished: (productRef) => {
      filesChanged(productRef);
      void jobs.onDownloadFinished(productRef).catch((err) => console.warn('[jobs] 後処理の判断に失敗:', err));
    }
  });

  registerDownloadsIpc({ downloads, getWindow });

  registerLocalFilesIpc({ repo, downloads, filesChanged, jobs, send });

  registerBrowserIpc({ repo });

  registerImportsIpc({ repo, downloads, getWindow, send, filesChanged });

  registerViewerIpc({ jobs, repo });

  registerAppIpc({ repo, getWindow });

  registerToolsIpc({ send, jobs, toolsDir, workDir, getWindow });

  registerJobsIpc({ repo, jobs, getWindow, filesChanged });

  registerContentIpc({ contentCache, repo, send, downloads, refreshLinkCandidates: () => refreshLinkCandidates(), runCompilations });

  registerRelocationIpc({ repo, downloads, jobs });

  registerPlayerIpc({ repo });

  registerPlaylistsIpc({ repo, send });

  const { refreshLinkCandidates } = registerInstallIpc({ send, repo, contentCache, getWindow });

  // 作品メタは裏でゆっくり集める。一気に取るとサイト側に負荷がかかるため。
  const metaCrawler = new MetaCrawler({
    repo,
    fetchDetail,
    isSyncRunning: () => sync.isRunning,
    loggedInSites: auth.loggedInSites,
    onProgress: (status) => send('meta:progress', status)
  });

  ipcMain.handle('meta:status', () => metaCrawler.status());
  ipcMain.handle('meta:setEnabled', (_e, enabled: boolean) => metaCrawler.setEnabled(enabled));
  ipcMain.handle('meta:setSpeed', (_e, intervalMs: number, concurrency: number) =>
    metaCrawler.setSpeed(intervalMs, concurrency)
  );
  ipcMain.handle('meta:runNow', () => metaCrawler.runNow());

  return { metaCrawler, downloads, jobs };
}
