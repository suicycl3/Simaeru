import { authenticated, authUnknown, type AuthResult } from '@shared/auth';
import { BrowserWindow, session } from 'electron';
import type { SiteAdapter } from '../sites/types';
import { t } from '@shared/i18n';
import { credentialOriginAllowed } from './credentialOrigin';
import { clearCsrfCache } from '../sites/dmm/client';

const openWindows = new Map<string, BrowserWindow>();

/**
 * ログインはアプリ内の「本物のブラウザウィンドウ」で行う。
 * Cookie はサイト専用パーティションに永続化され、以降の一覧取得はそのセッションで動く。
 * （外部ブラウザに飛ばす方式だと Cookie を持ってこられないため、この形にしている）
 */
export interface LoginTarget {
  /** 開始URL。省略時はサイト既定のログインページ */
  startUrl?: string;
  /**
   * サービス別ログイン（FANZA動画など）の完了判定。
   * URLでは判定できない — 本体にログイン済みだと目的サービスのURLへ素通りしてしまい、
   * 「着地＝完了」にするとウィンドウが一瞬で閉じるだけで認証は済まない。
   * 実際にそのサービスのAPIが通るかで判定する。
   */
  probe?: () => Promise<AuthResult>;
  /** ウィンドウタイトル用（例: 'FANZA動画'） */
  label?: string;
  /**
   * 保存済みのログイン情報。あればログインフォームの入力欄を埋める。
   * **送信までは行わない** — 最後のボタンは人が押す（2段階認証や規約同意が挟まるため）。
   */
  autofill?: () => { loginId: string | null; password: string | null };
}

export function openLoginWindow(
  site: SiteAdapter,
  onFinished: (result: AuthResult) => void,
  target: LoginTarget = {}
): BrowserWindow {
  // サービス別ログインは本体ログインとは別ウィンドウで開けるようにキーを分ける
  const key = `${site.siteId}:${target.label ?? 'default'}`;
  const existing = openWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return existing;
  }

  const checkLoggedIn = target.probe ?? (() => site.probeLogin());

  const win = new BrowserWindow({
    width: 1000,
    height: 820,
    title: t('{label} にログイン', { label: t(target.label ?? site.label) }),
    autoHideMenuBar: true,
    webPreferences: {
      session: session.fromPartition(site.partition),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  openWindows.set(key, win);

  let settled = false;
  const settle = async (loggedIn: boolean): Promise<void> => {
    if (settled) return;
    settled = true;
    if (loggedIn) {
      await session.fromPartition(site.partition).cookies.flushStore().catch(() => undefined);
      if (site.siteId === 'dmm') clearCsrfCache();
    }
    onFinished(authenticated());
    if (!win.isDestroyed()) win.close();
  };

  // 遷移のたびに実際の認証状態を確かめ、通ったときだけ閉じる。
  // 判定が非同期なので、遅れて返った結果で誤って閉じないよう settled で締める。
  let checking = false;
  const verify = async (): Promise<void> => {
    if (settled || checking) return;
    checking = true;
    try {
      if ((await checkLoggedIn()).state === 'authenticated') await settle(true);
    } catch {
      // 通信障害ではログイン窓を閉じない。
    } finally {
      checking = false;
    }
  };

  /**
   * ログインフォームに保存済みの値を入れる。
   * name/id/type のどれかで判断できるよう、よくある形を順に当たる。
   * React等でも値が反映されるよう、入力イベントを発火させてから書き込む。
   */
  const fillCredentials = async (): Promise<void> => {
    if (settled) return;
    const origin = win.webContents.getURL();
    if (!credentialOriginAllowed(site.siteId, origin)) return;
    const creds = target.autofill?.();
    if (!creds?.loginId && !creds?.password) return;
    const script = `(() => {
      if (location.origin !== ${JSON.stringify(new URL(origin).origin)}) return;
      const password = document.querySelector('input[type="password"]');
      if (!password?.form || new URL(password.form.action || location.href, location.href).origin !== location.origin) return;
      const setValue = (el, value) => {
        if (!el || !value || el.value) return false;
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        desc && desc.set ? desc.set.call(el, value) : (el.value = value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      const pw = document.querySelector('input[type="password"]');
      const idField =
        document.querySelector('input[type="email"]') ||
        document.querySelector('input[name*="login" i]:not([type="password"])') ||
        document.querySelector('input[name*="mail" i]') ||
        document.querySelector('input[name*="id" i]:not([type="password"])') ||
        document.querySelector('input[type="text"]');
      const filledId = setValue(idField, ${JSON.stringify(creds.loginId ?? '')});
      const filledPw = setValue(pw, ${JSON.stringify(creds.password ?? '')});
      // 「次回から自動ログイン」に相当するチェックも入れておく。
      // これが無いとサイト側のセッションが短命のままで、毎回ログインし直しになる。
      let keptLoggedIn = false;
      if (filledPw) {
        const keep = document.querySelector(
          'input[type="checkbox"][name*="auto_login" i], input[type="checkbox"][name*="autologin" i], input[type="checkbox"][id*="auto_login" i]'
        );
        if (keep && !keep.checked) {
          keep.click();
          keptLoggedIn = true;
        }
      }
      return { filledId, filledPw, keptLoggedIn };
    })()`;
    try {
      await win.webContents.executeJavaScript(script, true);
    } catch {
      /* フォームが無いページなら何もしなくてよい */
    }
  };

  win.webContents.on('did-navigate', () => void verify());
  win.webContents.on('did-navigate-in-page', () => void verify());
  // SPAだと遷移イベントが出ないことがあるので、描画完了時にも見る
  win.webContents.on('did-finish-load', () => {
    void verify();
    void fillCredentials();
  });
  // それでも取りこぼす経路（フレーム内遷移など）があるので保険で見張る
  const poll = setInterval(() => void verify(), 3000);

  win.on('closed', () => {
    clearInterval(poll);
    openWindows.delete(key);
    if (!settled) {
      // 手動で閉じられた場合も、実際にログインできているかは確認する
      settled = true;
      void checkLoggedIn().then(onFinished).catch((error) => onFinished(authUnknown(error)));
    }
  });

  // リダイレクト連鎖の途中で loadURL の Promise が ERR_ABORTED で reject することがある。
  // ウィンドウ自体は最終ページまで進むので、ここでは握り潰してよい。
  void win.loadURL(target.startUrl ?? site.loginUrl).catch(() => undefined);
  return win;
}

/** ログアウト（サイトのCookieを全消去） */
export async function clearSiteSession(site: SiteAdapter): Promise<void> {
  const s = session.fromPartition(site.partition);
  await s.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb'] });
  if (site.siteId === 'dmm') clearCsrfCache();
}
