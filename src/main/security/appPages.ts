import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';

/**
 * アプリ自身の画面（本体・ビューアの別窓）だけに、preload の API と IPC を使わせるための守り。
 *
 * 本体の窓が別のページへ移ると（ファイルを窓にドロップした・ページの中から移動したなど）、
 * そのページにも preload の `window.api` が渡り、保存した ID/パスワードの表示や任意のファイルの起動ができてしまう。
 * - 窓: アプリの画面以外へは移らせない。新しい窓は http(s) だけ既定のブラウザに渡す
 * - IPC: 呼び出し元のページがアプリの画面でなければ断る
 * （preload の側でも、アプリの画面でなければ API を出さない）
 */

/** アプリの画面の実体（ビルド後の out/renderer/index.html）。main は 1 本に束ねるので out/main 基準 */
export function rendererFile(): string {
  return path.join(__dirname, '../renderer/index.html');
}

/** 開発中は electron-vite の開発サーバから画面を読む */
export function devRendererUrl(): string | null {
  return process.env.ELECTRON_RENDERER_URL || null;
}

/**
 * アプリの画面の URL か。ハッシュ（ビューアの別窓の `#popup=`）とクエリ（言語）は見ない。
 * Windows のパスなので大文字小文字は区別しない。
 */
export function isAppPageUrl(url: string | null | undefined, file = rendererFile(), devUrl = devRendererUrl()): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (devUrl && u.origin === new URL(devUrl).origin) return true;
    if (u.protocol !== 'file:') return false;
    const want = pathToFileURL(file);
    return decodeURIComponent(u.pathname).toLowerCase() === decodeURIComponent(want.pathname).toLowerCase();
  } catch {
    return false;
  }
}

export const isWebUrl = (url: string): boolean => /^https?:\/\//i.test(url);

/** URL をログに出すときは、場所だけにする（クエリやハッシュに中身が入ることがある） */
const where = (url: string): string => url.split(/[?#]/)[0];

/** 移動のイベントから行き先を読む。新しい Electron ではイベントに url が載る（位置引数の url は非推奨）。どちらでも読む */
export function navigationUrl(event: { url?: string }, legacyUrl?: string): string {
  return event.url ?? legacyUrl ?? '';
}

/**
 * アプリの画面を出す窓に掛ける守り。
 * @param openExternal 新しい窓を既定のブラウザで開く処理（http(s) だけ渡す）
 */
export function guardAppWindow(win: BrowserWindow, openExternal: (url: string) => unknown): void {
  const block = (event: { preventDefault: () => void; url?: string }, legacyUrl?: string): void => {
    const url = navigationUrl(event, legacyUrl);
    if (isAppPageUrl(url)) return;
    event.preventDefault();
    console.warn(`[security] アプリの画面以外への移動を止めました: ${where(url)}`);
  };
  win.webContents.on('will-navigate', block);
  win.webContents.on('will-redirect', block);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void openExternal(url);
    else console.warn(`[security] http(s) 以外のリンクは開きません: ${where(url)}`);
    return { action: 'deny' };
  });
}

type Sender = IpcMainEvent | IpcMainInvokeEvent;

/** 呼び出し元フレームの URL。フレームが既に無い（閉じた・移った）ときは空 */
function senderUrl(event: Sender): string {
  try {
    return event.senderFrame?.url ?? '';
  } catch {
    return '';
  }
}

/** IPC の呼び出し元がアプリの画面か */
export function isTrustedSender(event: Sender): boolean {
  return isAppPageUrl(senderUrl(event));
}

/**
 * ipcMain の登録口を包み、アプリの画面以外からの呼び出しを断る。
 * IPC を登録するより前に 1 回だけ呼ぶ（以後の handle / on はすべて確認つきになる）。
 */
export function restrictIpcToAppPages(ipcMain: IpcMain, trusted: (event: Sender) => boolean = isTrustedSender): void {
  const allowed = (channel: string, event: Sender): boolean => {
    if (trusted(event)) return true;
    console.warn(`[security] アプリの画面以外からの IPC を断りました: ${channel} ${where(senderUrl(event))}`);
    return false;
  };

  // handle / handleOnce: 断るときは画面側の invoke を失敗させる
  const wrapHandle = (register: typeof ipcMain.handle): typeof ipcMain.handle =>
    (channel, listener) =>
      register(channel, (event, ...args) => {
        if (!allowed(channel, event)) throw new Error('forbidden');
        return listener(event, ...args);
      });
  ipcMain.handle = wrapHandle(ipcMain.handle.bind(ipcMain));
  ipcMain.handleOnce = wrapHandle(ipcMain.handleOnce.bind(ipcMain));

  // on / once（sendSync を含む）: 断るときは同期の返り値も空にしておく
  const wrapOn = (register: typeof ipcMain.on): typeof ipcMain.on =>
    ((channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) =>
      register(channel, (event: IpcMainEvent, ...args: unknown[]) => {
        if (!allowed(channel, event)) {
          event.returnValue = null;
          return;
        }
        listener(event, ...args);
      })) as typeof ipcMain.on;
  ipcMain.on = wrapOn(ipcMain.on.bind(ipcMain));
  ipcMain.once = wrapOn(ipcMain.once.bind(ipcMain));
}
