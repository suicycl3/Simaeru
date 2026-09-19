import { t } from '@shared/i18n';
import type { ToolName } from '@shared/types';
import { dialog,ipcMain,net,shell } from 'electron';
import fs from 'node:fs';
import { ToolInstaller } from '../tools/toolInstaller';
import { applyNeeViewDefaults,isNeeViewRunning } from '../viewer/neeviewSettings';
import type { IpcServices } from './services';

export function registerToolsIpc({ send, jobs, toolsDir, workDir, getWindow }: Pick<IpcServices, "send" | "jobs" | "toolsDir" | "workDir" | "getWindow">) {
  // ── 外部ツール（設定画面から入れる） ─────────────────────────
  const tools = new ToolInstaller({
    toolsDir,
    workDir,
    fetch: (url, init) => net.fetch(url, init),
    onProgress: (p) => send('tools:progress', p)
  });

  ipcMain.handle('tools:status', async () => {
    const status = jobs.tools();
    const installed = {
      sevenZip: await tools.installed('sevenZip'),
      ffmpeg: await tools.installed('ffmpeg'),
      neeview: await tools.installed('neeview')
    };
    return { status, installed };
  });
  /** 取得する前に「何を・どこから・どれくらい」を見せる */
  ipcMain.handle('tools:plan', (_e, tool: ToolName) => tools.plan(tool));
  ipcMain.handle('tools:install', async (_e, tool: ToolName) => {
    await tools.install(tool);
    return jobs.tools();
  });
  /** 見開き・サブフォルダーを読み込む設定を、いま使っている NeeView（ZIP 版）に入れる */
  ipcMain.handle('tools:neeviewDefaults', async () => {
    const exe = jobs.tools().neeview;
    if (!exe) throw new Error(t('NeeView が見つかりません'));
    if (await isNeeViewRunning()) throw new Error(t('NeeView を終了してから、もう一度お試しください。'));
    try {
      return await applyNeeViewDefaults(exe);
    } catch (err) {
      if (err instanceof Error && err.message === 'unsupported') {
        throw new Error(t('この NeeView は設定の置き場所が違うため書き込めません（アプリから入れた ZIP 版だけに対応しています）。NeeView の設定で「見開き」「サブフォルダーを読み込む」を選んでください。'));
      }
      throw err;
    }
  });
  ipcMain.handle('tools:uninstall', async (_e, tool: ToolName) => {
    await tools.uninstall(tool);
    return jobs.tools();
  });
  ipcMain.handle('tools:openDir', async () => {
    await fs.promises.mkdir(toolsDir, { recursive: true });
    return shell.openPath(toolsDir);
  });
  ipcMain.handle('tools:pick', async (_e, kind: ToolName) => {
    const win = getWindow();
    const names: Record<ToolName, string> = { sevenZip: '7z.exe', ffmpeg: 'ffmpeg.exe', neeview: 'NeeView.exe' };
    const options = {
      title: t('{0} を選ぶ', { 0: names[kind] }),
      filters: [{ name: t('実行ファイル'), extensions: ['exe'] }],
      properties: ['openFile'] as Array<'openFile'>
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (!result.canceled && result.filePaths[0]) {
      const file = result.filePaths[0];
      jobs.saveSettings(kind === 'sevenZip' ? { sevenZipPath: file } : kind === 'ffmpeg' ? { ffmpegPath: file } : { neeviewPath: file });
    }
    return jobs.tools();
  });
  /** 指定を外して自動で探す状態に戻す */
  ipcMain.handle('tools:clearPath', (_e, kind: ToolName) => {
    jobs.saveSettings(kind === 'sevenZip' ? { sevenZipPath: '' } : kind === 'ffmpeg' ? { ffmpegPath: '' } : { neeviewPath: '' });
    return jobs.tools();
  });

}
