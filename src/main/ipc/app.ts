import { getLang,normalizeLang,setLang,t } from '@shared/i18n';
import { app,dialog,ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { APP_NAME } from '@shared/appInfo';
import { logFromRenderer, readLog } from '../log';
import type { IpcServices } from './services';

export function registerAppIpc({ repo, getWindow }: Pick<IpcServices, "repo" | "getWindow">) {
  // ── このアプリについて ───────────────────────────────────
  ipcMain.handle('app:about', async () => {
    const read = (name: string): Promise<string | null> =>
      fs.promises.readFile(path.join(app.getAppPath(), name), 'utf8').catch(() => null);
    return {
      version: app.getVersion(),
      userData: app.getPath('userData'),
      // 英語表示なら英語版の一覧（無ければ日本語版）
      notices:
        // 中国語の版は作っていないので、英語版を出す
        (getLang() !== 'ja' ? await read('THIRD_PARTY_NOTICES.en.md') : null) ??
        (await read('THIRD_PARTY_NOTICES.md')) ??
        t('THIRD_PARTY_NOTICES.md が見つかりませんでした。')
    };
  });

  /** アプリログの書き出し。動きの記録（console に出しているもの）をファイルに保存する */
  ipcMain.handle('app:saveLog', async () => {
    const win = getWindow();
    const options = {
      defaultPath: `${APP_NAME}-log-${new Date().toISOString().slice(0, 10)}.txt`,
      filters: [{ name: 'Log', extensions: ['txt', 'log'] }]
    };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    const header = [
      `${APP_NAME} ${app.getVersion()}`,
      `${process.platform} ${process.getSystemVersion?.() ?? ''} / Electron ${process.versions.electron}`,
      `userData: ${app.getPath('userData')}`,
      `書き出し: ${new Date().toISOString()}`,
      ''
    ].join('\n');
    await fs.promises.writeFile(result.filePath, header + readLog(), 'utf8');
    return result.filePath;
  });

  /** 画面側で起きたことも同じ記録に残す */
  ipcMain.on('app:log', (_e, level: 'log' | 'warn' | 'error', message: string) => {
    logFromRenderer(level === 'warn' || level === 'error' ? level : 'log', String(message).slice(0, 2000));
  });

  // ── 画面の言語 ──
  // preload が読み込み時に同期で聞く（モジュールの定数も正しい言語で作れるように）
  ipcMain.on('app:langSync', (e) => {
    e.returnValue = getLang();
  });
  ipcMain.handle('app:setLanguage', (_e, lang: string) => {
    const next = normalizeLang(lang);
    if (!next) throw new Error(`unsupported language: ${lang}`);
    repo.setSetting('app.language', next);
    setLang(next);
    // 画面の文言はモジュールの読み込み時にも作るので、読み直して切り替える
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.reload();
    return next;
  });

}
