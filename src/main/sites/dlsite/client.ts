import { authenticated, unauthenticated, authUnknown, type AuthResult } from '@shared/auth';
import { session, type Session } from 'electron';
import { t } from '@shared/i18n';

export const DLSITE_PARTITION = 'persist:dlsite';

const PLAY_ORIGIN = 'https://play.dlsite.com';

export function dlsiteSession(): Session {
  return session.fromPartition(DLSITE_PARTITION);
}

export class DlsiteAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DlsiteAuthError';
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
}

/**
 * play.dlsite.com の API 呼び出し。Cookie セッション認証で、
 * 追加のヘッダは要らない（実キャプチャでも Referer/UA 以外は付いていない）。
 */
async function call<T>(path: string, opts: RequestOptions = {}, allowRevive = true): Promise<T> {
  const url = path.startsWith('http') ? path : `${PLAY_ORIGIN}${path}`;
  const res = await dlsiteSession().fetch(url, {
    method: opts.method ?? 'GET',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      Referer: `${PLAY_ORIGIN}/`,
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });

  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    // play のセッションは2時間ほどで切れる。トップを1回読むと SSO Cookie から
    // 発行し直されるので、起こしてから1回だけやり直す（DMM側と同じ考え方）。
    if (allowRevive) {
      await warmUpPlay();
      return call<T>(path, opts, false);
    }
    throw new DlsiteAuthError(t('DLsiteのログインが必要です。ログインしてから再度同期してください。'));
  }
  if (/login\.dlsite\.com/.test(res.url || '')) {
    throw new DlsiteAuthError(t('DLsiteのログインが切れています。再ログインしてください。'));
  }
  if (!res.ok) {
    throw new Error(`${opts.method ?? 'GET'} ${url} failed: HTTP ${res.status} ${text.slice(0, 160)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const head = text.trim().slice(0, 160).replace(/\s+/g, ' ');
    throw new Error(t('JSONではないレスポンスが返りました ({url}): {head}', { url, head }));
  }
}

export function get<T>(path: string): Promise<T> {
  return call<T>(path);
}

export function post<T>(path: string, body: unknown): Promise<T> {
  return call<T>(path, { method: 'POST', body });
}

interface AuthorizeResponse {
  account_id?: number;
  customer_id?: string;
  login_id?: string;
}

/** play 側の認証API。未ログインだと 401 か account_id 無しで返る */
async function playAuthorized(): Promise<boolean> {
  try {
    const res = await get<AuthorizeResponse>('/api/authorize');
    return typeof res.account_id === 'number';
  } catch (err) {
    if (err instanceof DlsiteAuthError) return false;
    throw err;
  }
}

let warmedAt = 0;

/**
 * play.dlsite.com のセッションを起こす。
 *
 * DLsiteのログインは login.dlsite.com で行われ、その足で www 側へ戻る。
 * play は別アプリ扱いで、**一度 play を開くまで /api/authorize が 401 を返す**ことがある。
 * そのせいで「ログインしたのに未ログインのまま」になっていたので、
 * 判定に失敗したときはトップを1回読んでセッションを確立してから見直す。
 */
async function warmUpPlay(): Promise<void> {
  if (Date.now() - warmedAt < 10_000) return; // 連続で叩かない
  warmedAt = Date.now();
  try {
    await dlsiteSession().fetch(`${PLAY_ORIGIN}/`, {
      credentials: 'include',
      headers: { Accept: 'text/html' }
    });
  } catch {
    /* 起こせなくても判定自体は続ける */
  }
}

/**
 * www 側（購入履歴・作品ページを取る側）でログインできているか。
 * play が未確立でもこちらが通っていれば「ログイン済み」と扱ってよい。
 *
 * `/home/mypage` はJSで飛ばすだけの中継ページ（実測で
 * `window.location.replace(...)` だけが入っている）なので判定に使えない。
 * 購入履歴ページを直接読んで、一覧の目印が出ているかで見る。
 */
async function wwwLoggedIn(): Promise<boolean> {
  try {
    const res = await dlsiteSession().fetch(
      'https://www.dlsite.com/home/mypage/userbuy/=/type/all/start/all/sort/1/order/1/page/1',
      { credentials: 'include', headers: { Accept: 'text/html' } }
    );
    if (!res.ok || (res.url || '').includes('login.dlsite.com')) return false;
    const html = await res.text();
    // 総件数の表示か、購入日の列があれば購入履歴が出ている＝ログイン済み
    return html.includes('page_total') || html.includes('buy_date');
  } catch {
    return false;
  }
}

/**
 * ログイン済みか。play → (起こし直して) play → www の順に見る。
 * どれか1つでも通ればログイン済みとして扱う。
 */
export async function probeDlsiteLogin(): Promise<AuthResult> {
  try {
    if (await playAuthorized()) return authenticated();
    await warmUpPlay();
    if (await playAuthorized()) return authenticated();
    if (await wwwLoggedIn()) return authenticated();
    return unauthenticated();
  } catch (err) {
    return authUnknown(err);
  }
}

/** 連続アクセスの間隔。DLsite側に負荷をかけないため */
export function politeDelay(ms = 300): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const WWW_ORIGIN = 'https://www.dlsite.com';

/**
 * 旧www側のHTMLページを取る。購入履歴とライセンスキーは play API には無く、
 * こちらにしか存在しない（DESIGN.md「DLsite 購入履歴/シリアル」参照）。
 *
 * 注意: /home/download/=/product_id/*.html は案内ページではなく作品ファイルそのものを
 * 流してくる。取得するとメモリを食い潰して落ちるので、ここで明示的に弾いている。
 * ダウンロードは必ず外部ブラウザで開く導線にすること。
 */
export async function getWwwHtml(path: string): Promise<string> {
  const url = path.startsWith('http') ? path : `${WWW_ORIGIN}${path}`;
  if (url.includes('/home/download/=/')) {
    throw new Error(t('ダウンロードURLは取得してはいけません(実ファイルが流れてくる): {url}', { url }));
  }
  const res = await dlsiteSession().fetch(url, {
    credentials: 'include',
    headers: { Accept: 'text/html', Referer: `${WWW_ORIGIN}/` }
  });
  if (res.status === 401 || res.status === 403 || (res.url || '').includes('login.dlsite.com')) {
    throw new DlsiteAuthError(t('DLsiteのログインが必要です。ログインしてから再度お試しください。'));
  }
  if (!res.ok) {
    throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  }
  return await res.text();
}

/**
 * 作品ページのように「消えていることが普通にある」ページ用。
 * 404/410 は例外にせず null を返す（販売終了・収録専用の作品など）。
 */
export async function getWwwHtmlOrNull(path: string): Promise<string | null> {
  try {
    return await getWwwHtml(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('HTTP 404') || message.includes('HTTP 410')) return null;
    throw err;
  }
}
