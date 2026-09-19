import { BrowserWindow, session, shell } from 'electron';

/**
 * 購入サイトの「ブラウザで読む・遊ぶ」を、アプリの中の窓で開く。
 *
 * - 同期・ダウンロードと同じセッション（パーティション）を**そのまま**使うので、ログインし直さなくてよい。
 *   Cookie を別のセッションへ写したりはしない（写すと元のログインが壊れる。メモ: 認証調査の注意）。
 * - 復号はしない。サイトの公式ビューア・プレイヤーを表示するだけ。
 * - この Electron には Widevine / PlayReady が無い（ClearKey だけ。requestMediaKeySystemAccess で確認）。
 *   DMM 動画の HTML5 プレイヤーは、Widevine・PlayReady のほかに W3C 共通の鍵方式も配信に載せているので、アプリ内で開く。
 *   再生できなかったときのために、画面側に外部ブラウザで開く導線を残す。
 * - 開くのは http(s) だけ。公式アプリを起動するリンク（`dmm…:` で始まるもの。DMM プレイヤーでのダウンロードなど）は、
 *   ページの操作から移ったときだけ Windows に渡す。それ以外の形式は開かない。
 */

/** Electron とアプリ名の印を外した UA。サイトによっては見慣れない UA で表示を変える */
function browserUserAgent(ua: string): string {
  return ua.replace(/\s(Electron|dmm-library|MyLibrary|Simaeru)\/\S+/g, '');
}

const isWeb = (url: string): boolean => /^https?:\/\//i.test(url);
/** 公式アプリを起動するリンク（DMM プレイヤー・DMM GAMES PLAYER など） */
export const isOfficialAppLink = (url: string): boolean => /^dmm[a-z0-9+.-]*:/i.test(url);

/** 公式アプリを起動するリンクへ移ろうとしたら、窓では開かず Windows に渡す */
function handOff(url: string): void {
  console.log(`[browser] 公式アプリに渡します: ${url.split(':')[0]}:`);
  void shell.openExternal(url);
}

export function openSiteBrowser(url: string, opts: { partition: string; title: string }): BrowserWindow {
  const ses = session.fromPartition(opts.partition);
  const create = (target: string, title: string): BrowserWindow => {
    const win = new BrowserWindow({
      width: 1280,
      height: 900,
      title,
      autoHideMenuBar: true,
      backgroundColor: '#1b2838',
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false }
    });
    win.webContents.setUserAgent(browserUserAgent(win.webContents.getUserAgent()));
    // 別の窓で開くリンク（ビューアを新しいタブで開くサイトがある）も、同じセッションのアプリ内の窓で開く
    win.webContents.setWindowOpenHandler(({ url: next }) => {
      if (isWeb(next)) create(next, title);
      else if (isOfficialAppLink(next)) handOff(next);
      return { action: 'deny' };
    });
    const guard = (e: { preventDefault: () => void }, next: string): void => {
      if (isWeb(next)) return;
      e.preventDefault();
      if (isOfficialAppLink(next)) handOff(next);
    };
    win.webContents.on('will-navigate', guard);
    win.webContents.on('will-redirect', guard);
    win.webContents.on('page-title-updated', (e, pageTitle) => {
      e.preventDefault();
      win.setTitle(pageTitle ? `${pageTitle} - ${title}` : title);
    });
    // ブラウザと同じ操作: 再読み込み・戻る/進む・全画面・閉じる
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      const key = input.key;
      const wc = win.webContents;
      let handled = true;
      if (key === 'F5' || (input.control && key.toLowerCase() === 'r')) wc.reload();
      else if (input.alt && key === 'ArrowLeft') wc.navigationHistory.goBack();
      else if (input.alt && key === 'ArrowRight') wc.navigationHistory.goForward();
      else if (key === 'F11') win.setFullScreen(!win.isFullScreen());
      else if (key === 'Escape' && win.isFullScreen()) win.setFullScreen(false);
      else if (input.control && key.toLowerCase() === 'w') win.close();
      else handled = false;
      if (handled) e.preventDefault();
    });
    void win.loadURL(target);
    return win;
  };
  return create(url, opts.title);
}

/** 外部ブラウザで開く（http(s) だけ） */
export function openExternalWeb(url: string): Promise<void> {
  return isWeb(url) ? shell.openExternal(url) : Promise.resolve();
}
