import { t } from '@shared/i18n';
import type { DgpSummary,InstalledProgram } from '@shared/types';
import { dialog,ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { dgpKey,dgpStatus,openDgp,readDgpGames } from '../install/dmmGamePlayer';
import {
analyzeFolder,
exeFromDisplayIcon,
launchProduct,
rankPrograms,
readInstalledPrograms,
runInstaller
} from '../install/installService';
import { findLinkCandidates } from '../install/linkCandidates';
import { refreshLinkHealth } from '../install/linkHealth';
import type { IpcServices } from './services';

export function registerInstallIpc({ send, repo, contentCache, getWindow }: Pick<IpcServices, "send" | "repo" | "contentCache" | "getWindow">) {
  // ── インストール・起動（Phase 2） ─────────────────────────
  /** 紐付け・起動のあとは一覧の件数（未インストールなど）と並び（最近起動した順）が変わるので知らせる */
  const refreshed = (productRef: number) => {
    send('library:changed', { productRef });
    return repo.getProduct(productRef);
  };

  // ── 紐付けの候補（「紐付け候補あり」） ──────────────────────
  let candidatesRunning: Promise<number> | null = null;
  /** まだ紐付けていないゲームごとに、導入済みプログラム・DMM GAMES PLAYER のゲームから候補を探し直す。@returns 候補のある作品数 */
  const refreshLinkCandidates = (): Promise<number> => {
    if (candidatesRunning) return candidatesRunning;
    candidatesRunning = (async () => {
      // 先に、紐付けたソフトが消えていないかを見る（リンク切れは候補を探し直す対象に入る）
      const broken = await refreshLinkHealth(repo).catch((err: unknown) => {
        console.warn('[install] 紐付けの見回りに失敗:', err);
        return [] as number[];
      });
      if (broken.length > 0) send('library:changed', { productRef: null });
      const targets = repo.linkCandidateTargets();
      if (targets.length === 0) return 0;
      const [dgpGames, programs] = await Promise.all([
        readDgpGames().catch(() => []),
        readInstalledPrograms().catch(() => [])
      ]);
      const found = findLinkCandidates(targets, { dgpGames, programs, linkedKeys: repo.linkedKeys() });
      repo.setLinkCandidates(found);
      send('library:changed', { productRef: null });
      return [...found.values()].filter(Boolean).length;
    })()
      .catch((err: unknown) => {
        console.warn('[install] 紐付けの候補を探せませんでした:', err);
        return 0;
      })
      .finally(() => {
        candidatesRunning = null;
      });
    return candidatesRunning;
  };
  // 起動直後は重いので少し置いてから
  setTimeout(() => void refreshLinkCandidates(), 20_000);
  ipcMain.handle('install:refreshCandidates', () => refreshLinkCandidates());

  /** DMM GAMES PLAYER が要る作品を持っているのに、DMM GAMES PLAYER が入っていないかを見る（設定の「アカウント」・サイドバーの警告） */
  ipcMain.handle('install:dgpSummary', async (): Promise<DgpSummary> => {
    const counts = repo.dgpOnlyCounts();
    const status = await dgpStatus(null);
    return { installed: status.installed, exe: status.exe, ...counts };
  });
  const EXE_LIKE = /\.(exe|html?|bat|cmd|lnk|url)$/i;
  const isLaunchable = async (exe: string): Promise<boolean> =>
    EXE_LIKE.test(exe) && (await fs.promises.access(exe).then(() => true, () => false));

  ipcMain.handle('install:analyze', async (_e, productRef: number) => (await contentCache.getOrBuild(productRef)).install);
  ipcMain.handle('install:runInstaller', (_e, productRef: number, installer: string) =>
    runInstaller(repo, productRef, installer)
  );
  /** 「このフォルダをそのまま使う」: 作品の展開済みフォルダ内の exe を紐付ける */
  ipcMain.handle('install:useFolder', async (_e, productRef: number, folder: string, exe: string) => {
    if (!(await isLaunchable(exe))) throw new Error(t('起動できるファイルを選んでください'));
    repo.upsertInstallation({
      productRef,
      kind: 'managed',
      installPath: folder,
      executablePath: exe,
      displayName: path.basename(exe),
      state: 'installed',
      notes: t('そのまま使う（インストール不要）')
    });
    return refreshed(productRef);
  });
  /** インストーラを実行したあと、導入先のフォルダを選んでもらう */
  ipcMain.handle('install:pickFolder', async () => {
    const win = getWindow();
    const options = { title: t('インストールしたフォルダを選ぶ'), properties: ['openDirectory'] as Array<'openDirectory'> };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return analyzeFolder(result.filePaths[0]);
  });
  ipcMain.handle('install:pickExe', async (_e, defaultPath?: string) => {
    const win = getWindow();
    const options = {
      title: t('起動するファイルを選ぶ'),
      defaultPath,
      filters: [{ name: t('起動できるファイル'), extensions: ['exe', 'html', 'htm', 'bat', 'lnk'] }],
      properties: ['openFile'] as Array<'openFile'>
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle('install:folderCandidates', async (_e, folder: string) => {
    if (!folder || !(await fs.promises.access(folder).then(() => true, () => false))) return null;
    return analyzeFolder(folder);
  });
  /** 導入先（インストーラで入れた先）を記録する */
  ipcMain.handle('install:linkInstalled', async (_e, productRef: number, folder: string, exe: string) => {
    if (!(await isLaunchable(exe))) throw new Error(t('起動できるファイルを選んでください'));
    repo.upsertInstallation({
      productRef,
      kind: 'managed',
      installPath: folder,
      executablePath: exe,
      displayName: path.basename(folder),
      state: 'installed',
      notes: t('インストーラで導入')
    });
    return refreshed(productRef);
  });
  ipcMain.handle('install:programs', (_e, productRef: number) => {
    const product = repo.getProduct(productRef);
    return rankPrograms(product?.title ?? '', product?.maker ?? null);
  });
  ipcMain.handle('install:programExes', async (_e, program: InstalledProgram) => {
    const has = (p: string | null): Promise<boolean> =>
      p ? fs.promises.access(p).then(() => true, () => false) : Promise.resolve(false);
    const fromIcon = exeFromDisplayIcon(program.displayIcon);
    const folder = (await has(program.installLocation))
      ? program.installLocation
      : fromIcon
        ? path.dirname(fromIcon)
        : null;
    const analysis = folder ? await analyzeFolder(folder) : null;
    const list = analysis?.executables.map((e) => e.path) ?? [];
    if (fromIcon && (await has(fromIcon)) && !list.includes(fromIcon)) list.unshift(fromIcon);
    return { folder, executables: list };
  });
  /** 既に導入済みのプログラムと紐付ける（候補を出すだけで、選ぶのはユーザー） */
  ipcMain.handle('install:linkExisting', async (_e, productRef: number, program: InstalledProgram, exe: string | null) => {
    if (exe && !(await isLaunchable(exe))) throw new Error(t('起動できるファイルを選んでください'));
    repo.upsertInstallation({
      productRef,
      kind: 'linked_existing',
      installPath: program.installLocation,
      executablePath: exe,
      uninstallKey: program.key,
      displayName: program.displayName,
      version: program.version,
      state: 'installed'
    });
    return refreshed(productRef);
  });
  /** DMM GAMES PLAYER: 入っているか・入っているゲーム（作品に近い順） */
  ipcMain.handle('install:dgpStatus', (_e, productRef: number) => dgpStatus(repo.getProduct(productRef)));
  ipcMain.handle('install:linkDgp', async (_e, productRef: number, dgpProductId: string) => {
    const status = await dgpStatus(null);
    const game = status.games.find((g) => g.productId === dgpProductId);
    if (!game) throw new Error(t('DMM GAMES PLAYER にそのゲームが見つかりません'));
    repo.upsertInstallation({
      productRef,
      kind: 'dmm_game_player',
      installPath: game.path,
      executablePath: null,
      uninstallKey: dgpKey(game),
      displayName: `DMM GAMES PLAYER: ${game.path ? path.basename(game.path) : game.productId}`,
      version: game.version,
      state: 'installed',
      notes: t('DMM GAMES PLAYER から起動')
    });
    return refreshed(productRef);
  });
  ipcMain.handle('install:openDgp', () => openDgp());
  ipcMain.handle('install:unlink', (_e, productRef: number) => {
    repo.removeInstallation(productRef);
    void refreshLinkCandidates();
    return refreshed(productRef);
  });
  ipcMain.handle('install:launch', async (_e, productRef: number) => {
    try {
      await launchProduct(repo, productRef);
    } catch (err) {
      // 起動ファイルが消えていたなどは、リンク切れとして付け直してから知らせる
      if ((await refreshLinkHealth(repo).catch(() => [])).length > 0) send('library:changed', { productRef: null });
      throw err;
    }
    return refreshed(productRef);
  });
  /** 詳細を開いたときに、紐付けが生きているかを確かめ直す。変わっていれば更新後の作品を返す */
  ipcMain.handle('install:checkLink', async (_e, productRef: number) => {
    const changed = await refreshLinkHealth(repo).catch(() => [] as number[]);
    if (changed.length === 0) return null;
    send('library:changed', { productRef: changed.length === 1 ? changed[0] : null });
    return repo.getProduct(productRef);
  });

  return { refreshLinkCandidates };
}
