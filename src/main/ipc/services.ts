import type { BrowserWindow } from 'electron';
import type { ContentCache } from '../content/contentCache';
import type { Repo } from '../db/repo';
import type { DownloadManager } from '../download/downloadManager';
import type { JobRunner } from '../jobs/jobRunner';

/** 各登録モジュールは必要な依存だけをPickして受け取る。所有と起動順はipc.tsに置く。 */
export interface IpcServices {
  repo: Repo;
  downloads: DownloadManager;
  jobs: JobRunner;
  contentCache: ContentCache;
  getWindow: () => BrowserWindow | null;
  send: (channel: string, payload: unknown) => void;
  filesChanged: (productRef: number | null) => void;
  toolsDir: string;
  workDir: string;
  refreshLinkCandidates: () => Promise<number>;
  runCompilations: () => Promise<number>;
}
