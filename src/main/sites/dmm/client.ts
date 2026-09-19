import { authenticated, unauthenticated, authUnknown, type AuthResult } from '@shared/auth';
import { session, type Session } from 'electron';
import { t } from '@shared/i18n';
import { recordAuth } from '../../auth/diagnostics';

export const DMM_PARTITION = 'persist:dmm';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36';

export function dmmSession(): Session {
  return session.fromPartition(DMM_PARTITION);
}

/**
 * 年齢確認は Cookie 1個で通る。これが無いと dlsoft/doujin のページが
 * /age_check/ にリダイレクトされ、ログイン済みでも一覧APIまで到達できない。
 */
export async function ensureAgeCheckCookie(): Promise<void> {
  const s = dmmSession();
  const existing = await s.cookies.get({ domain: '.dmm.co.jp', name: 'age_check_done' });
  if (existing.length > 0) return;
  const expires = Date.now() / 1000 + 60 * 60 * 24 * 365;
  for (const domain of ['.dmm.co.jp', '.dmm.com']) {
    await s.cookies
      .set({
        url: `https://www${domain}/`,
        name: 'age_check_done',
        value: '1',
        domain,
        path: '/',
        secure: true,
        expirationDate: expires
      })
      .catch(() => undefined);
  }
}

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  referer?: string;
  /** 再試行時にも現在のセッションに対応するトークンを取得する */
  csrfPage?: string;
}

async function request(url: string, opts: FetchOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
    ...(opts.referer ? { Referer: opts.referer } : {}),
    ...(opts.headers ?? {})
  };
  if (opts.csrfPage) headers['X-CSRF-TOKEN'] = await getCsrfToken(opts.csrfPage);
  return dmmSession().fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body,
    // Cookie を必ず載せる
    credentials: 'include'
  });
}

/** マイライブラリの通常ページ。セッション復活の踏み台に使う */
const REVIVE_PAGE = 'https://www.dmm.co.jp/dc/-/mylibrary/';
/**
 * 一般向け（dmm.com）は FANZA（dmm.co.jp）と Cookie のドメインが別で、ログインも別。
 * 復活の踏み台も dmm.com 側のページを使う。
 */
const REVIVE_PAGE_COM = 'https://book.dmm.com/library/';

const reviving = new Map<string, Promise<boolean>>();
const reviveResults = new Map<string, { at: number; ok: boolean }>();

/** URL が一般向け（dmm.com）のものか */
export function isDmmCom(url: string): boolean {
  try {
    return /(^|\.)dmm\.com$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * 期限内でも無効になっていることがあるセッションCookie。
 * **これが残っていると自動ログインが走らない**（実測: 無効な ec_session を持ったまま
 * 通常ページを読んでもログイン済みページにならない）。復活の前に捨てる。
 */
const STALE_SESSION_COOKIES = ['ec_session', 'laravel_session', 'INT_SESID', 'XSRF-TOKEN'];

async function dropStaleSessionCookies(forUrl: string): Promise<void> {
  const s = dmmSession();
  const target = new URL(forUrl);
  for (const name of STALE_SESSION_COOKIES) {
    const found = await s.cookies.get({ name, url: forUrl });
    for (const c of found) {
      const host = (c.domain || '').replace(/^\./, '');
      // cookies.get のURLフィルタに加え、別ドメインや別サービスのCookieを明示的に除外。
      if (host !== target.hostname || !(target.pathname === (c.path || '/') || target.pathname.startsWith((c.path || '/').replace(/\/$/, '') + '/'))) continue;
      const url = `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`;
      await s.cookies.remove(url, c.name);
      recordAuth({ service: target.hostname, event: 'cookie-remove', cookie: { name: c.name, domain: c.domain ?? '', path: c.path ?? '/' } });
    }
  }
}

/**
 * 期限切れになったAPIセッションを、自動ログインCookieから復活させる。
 *
 * DMMは `login_secure_id`（1年もの）と `ec_session`（**2時間で失効**）を分けて持っている。
 * APIはXHR前提なので、失効しても401を返すだけで自動ログインが走らない。
 * 通常ページを1回読むと自動ログインが走って `ec_session` が再発行される
 * （実測: 401 → ページ読み込み → 同じAPIが error_code 0 で通る）。
 * これをやらないと2時間ごとに手でログインし直す羽目になる。
 *
 * @returns 直前に復活を試みた（＝呼び出し元は1回だけ再試行してよい）なら true
 */
export async function reviveDmmSession(forUrl?: string): Promise<boolean> {
  const page = forUrl && isDmmCom(forUrl) ? REVIVE_PAGE_COM : REVIVE_PAGE;
  const target = forUrl ?? REVIVE_PAGE;
  const key = new URL(target).origin;
  const pending = reviving.get(key);
  if (pending) { recordAuth({ service: key, event: 'recovery-wait' }); return pending; }
  const previous = reviveResults.get(key);
  if (previous && Date.now() - previous.at < 10_000) return previous.ok;
  const work = (async (): Promise<boolean> => {
   try {
    recordAuth({ service: key, event: 'recovery-start' });
    await ensureAgeCheckCookie();
    // ドメイン共通Cookieは他サービスが使っている可能性があるため削除しない。
    clearCsrfCache();
    await dropStaleSessionCookies(target);
    const res = await dmmSession().fetch(page, {
      credentials: 'include',
      headers: { 'User-Agent': UA, Accept: 'text/html' }
    });
    await res.text();
    return res.ok && !redirectedToLogin(res, page);
  } catch {
    return false;
  }
  })();
  reviving.set(key, work);
  try {
    const ok = await work;
    recordAuth({ service: key, event: 'recovery-end', ok });
    reviveResults.set(key, { at: Date.now(), ok });
    return ok;
  } finally {
    reviving.delete(key);
  }
}

/**
 * `/dc` 配下に溜まる「名前が英数40文字・800バイト級」のCookieを捨てる。
 *
 * DMMはアクセスのたびにこの形のCookieを足していくらしく、放っておくと
 * Cookieヘッダが15KBを超え、nginx が **400 Request Header Or Cookie Too Large** を返すようになる
 * （実測: 46個・15,641バイト。整理して30個・2,637バイトで復旧）。
 * 認証系（login_secure_id / ec_session など）は名前が決まっているので巻き込まない。
 * 消してもサイト側が必要なら再発行するだけなのは実測済み。
 *
 * @returns 消した個数
 */
export async function pruneOversizedCookies(maxHeaderBytes = 4000): Promise<number> {
  const s = dmmSession();
  const cookies = await s.cookies.get({ url: REVIVE_PAGE }).catch(() => []);
  const headerSize = cookies.map((c) => `${c.name}=${c.value}`).join('; ').length;
  if (headerSize <= maxHeaderBytes) return 0;

  const junk = cookies.filter((c) => /^[A-Za-z0-9]{40}$/.test(c.name) && c.value.length > 200);
  let removed = 0;
  for (const c of junk) {
    const host = (c.domain || '').replace(/^\./, '');
    const url = `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`;
    try {
      await s.cookies.remove(url, c.name);
      removed++;
    } catch {
      /* 消せないものは諦めて次へ */
    }
  }
  return removed;
}

/** 失敗の本文を短く。HTML ならページの題名だけ（「<!DOC」だけが出ても分からない） */
export function describeBody(text: string): string {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.replace(/\s+/g, ' ').trim();
  if (title) return `(${title})`;
  if (/^\s*</.test(text)) return '';
  return text.trim().slice(0, 200);
}

/** 本文がログイン画面（HTML）かどうか。APIがHTMLを返したらセッション切れ */
function looksLikeLoginHtml(text: string): boolean {
  const head = text.slice(0, 800);
  return /^\s*</.test(head) && /service\/login|ログインしてください/.test(head);
}

export class DmmAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DmmAuthError';
  }
}

/** ログイン画面（パスワード入力など）へ飛ばされたか。自動ログインの通り道（login/token）は除く */
function redirectedToLogin(res: Response, url: string): boolean {
  const finalUrl = res.url || url;
  return /accounts\.dmm\.(co\.jp|com)\/service\/login/.test(finalUrl);
}

function assertNotRedirectedToLogin(res: Response, url: string): void {
  if (redirectedToLogin(res, url)) {
    throw new DmmAuthError(
      isDmmCom(url)
        ? t('DMMブックス（dmm.com）のログインが必要です。設定の「アカウント」からログインしてください。')
        : t('DMMのログインが切れています。再ログインしてください。')
    );
  }
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  await ensureAgeCheckCookie();
  let res = await request(url, opts);
  // 2 時間で切れるセッションは、401・403 のほか、ログイン画面への転送でも分かる。自動ログインで起こし直して 1 回やり直す
  if (res.status === 401 || redirectedToLogin(res, url)) {
    if (await reviveDmmSession(url)) res = await request(url, opts);
  }
  assertNotRedirectedToLogin(res, url);
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  return res.text();
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  return fetchJsonOnce<T>(url, opts, true);
}

/** @param allowRevive セッション切れのときに復活させて1回だけやり直してよいか */
async function fetchJsonOnce<T>(
  url: string,
  opts: FetchOptions,
  allowRevive: boolean
): Promise<T> {
  await ensureAgeCheckCookie();
  const res = await request(url, {
    ...opts,
    headers: {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      ...(opts.headers ?? {})
    }
  });
  // ログイン画面へ転送された（旧 www 側の API はセッションが切れると 401 ではなく転送する）ときも、起こし直して 1 回やり直す
  if (redirectedToLogin(res, url) && allowRevive && (await reviveDmmSession(url))) return fetchJsonOnce<T>(url, opts, false);
  assertNotRedirectedToLogin(res, url);
  const text = await res.text();
  const authFailed = res.status === 401 || looksLikeLoginHtml(text);
  if (authFailed) {
    // 2時間で切れるAPIセッションは、自動ログインCookieから起こし直せる
    if (allowRevive && (await reviveDmmSession(url))) return fetchJsonOnce<T>(url, opts, false);
    throw new DmmAuthError(
      isDmmCom(url)
        ? t('DMMブックス（dmm.com）のログインが必要です。設定の「アカウント」からログインしてください。')
        : t('DMMのログインが必要です。ログインしてから再度同期してください。')
    );
  }
  // Cookieが膨らみすぎると nginx が400を返す。整理して1回だけやり直す。
  if (res.status === 400 && /Cookie Too Large/i.test(text)) {
    if (allowRevive && (await pruneOversizedCookies()) > 0) {
      return fetchJsonOnce<T>(url, opts, false);
    }
  }
  if (!res.ok) {
    throw new Error(`GET ${url} failed: HTTP ${res.status} ${describeBody(text)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // HTML が返ってきた＝年齢確認/仕様変更のいずれか。切り分けできる文言を残す。
    const head = text.trim().slice(0, 160).replace(/\s+/g, ' ');
    throw new Error(t('JSONではないレスポンスが返りました ({url}): {head}', { url, head }));
  }
}

/**
 * 動画フロアの GraphQL 用。
 * 注意: このエンドポイントに User-Agent / Referer / Origin を手で足すと
 * net::ERR_BLOCKED_BY_CLIENT で弾かれる（実測）。Content-Type だけ付けること。
 */
export async function fetchGraphql<T>(
  endpoint: string,
  body: { operationName: string; query: string; variables: unknown }
): Promise<T> {
  const res = await dmmSession().fetch(endpoint, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (res.status === 401) {
    throw new DmmAuthError(t('DMMのログインが必要です。ログインしてから再度同期してください。'));
  }
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(t('GraphQLがJSONを返しませんでした: {0}', { 0: text.slice(0, 160) }));
  }
  // GraphQL は「一部のフィールドだけ失敗、残りは返る」ことが普通にある。
  // data が使えるならエラーがあっても採用し、data が無いときだけ失敗にする。
  const { data, errors } = json as { data?: T; errors?: Array<{ message: string }> };
  if (data) return data;
  if (errors?.length) {
    throw new Error(t('GraphQLエラー: {0}', { 0: errors.map((e) => e.message).join(' / ') }));
  }
  throw new Error(t('GraphQLレスポンスに data がありません'));
}

const csrfCache = new Map<string, { token: string; at: number }>();
let csrfGeneration = 0;
const CSRF_TTL = 10 * 60 * 1000;

/** ページHTMLの <meta name="csrf-token" content="..."> を取り出す（dlsoft/doujin が要求する） */
export async function getCsrfToken(pageUrl: string): Promise<string> {
  const cached = csrfCache.get(pageUrl);
  if (cached && Date.now() - cached.at < CSRF_TTL) return cached.token;
  const generation = csrfGeneration;
  const html = await fetchText(pageUrl);
  const m = html.match(/<meta\s+name="csrf-token"[^>]*content="([^"]+)"/i);
  if (!m) {
    // ログイン画面や年齢確認ページが返っていると meta ごと存在しない
    if (/ログイン|login/i.test(html) && !/library/i.test(html)) {
      throw new DmmAuthError(t('DMMのログインが必要です。ログインしてから再度同期してください。'));
    }
    throw new Error(t('csrf-token が見つかりません: {pageUrl}', { pageUrl }));
  }
  if (generation === csrfGeneration) csrfCache.set(pageUrl, { token: m[1], at: Date.now() });
  return m[1];
}

export function clearCsrfCache(): void {
  csrfGeneration++;
  csrfCache.clear();
}

/**
 * ログイン済みか。
 *
 * 判定に使えないもの（実測）:
 *  - HTMLページのリダイレクト先: 未ログインでも 200 の器だけ返る（中身はJSで描画）ため誤判定する。
 *  - accounts の /api/v1/point: ログイン済みでも単独で叩くと 401 UNAUTHORIZED を返す。
 *
 * 同人ライブラリAPIは未ログインで 401（error_message="ログインしていません。"）、
 * ログイン済みで 200 を返すことを両方の状態で実測済みなので、これを判定に使う。
 * 1件だけ要求して負荷を最小にしている。
 */
export async function probeDmmLogin(): Promise<AuthResult> {
  const first = await probeDmmLoginOnce();
  if (first.state !== 'unauthenticated') return first;
  // 未ログインに見えても、APIセッションが切れているだけのことがある。
  // 自動ログインで起こし直してからもう一度確かめる。
  if (!(await reviveDmmSession())) return first;
  return probeDmmLoginOnce();
}

async function probeDmmLoginOnce(): Promise<AuthResult> {
  try {
    await ensureAgeCheckCookie();
    const res = await request(
      'https://www.dmm.co.jp/dc/doujin/api/mylibraries/?page=1&sort=purchasedate_desc&genre=all&limit=1',
      {
        headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        referer: 'https://www.dmm.co.jp/dc/-/mylibrary/'
      }
    );
    if (res.status === 401) return unauthenticated();
    if (/service\/login/.test(res.url || '')) return unauthenticated();
    if (!res.ok) return authUnknown(`HTTP ${res.status}`);
    const text = await res.text();
    try {
      const json = JSON.parse(text) as { error_code?: number | string };
      const ok = json.error_code === 0 || json.error_code === '0';
      return ok ? authenticated() : authUnknown(t('ログイン状態を確認できませんでした'));
    } catch {
      return looksLikeLoginHtml(text) ? unauthenticated() : authUnknown(t('ログイン状態を確認できませんでした'));
    }
  } catch (err) {
    return authUnknown(err);
  }
}

/** 連続アクセスの間隔。DMM側に負荷をかけないよう全アダプタで共有する。 */
export function politeDelay(ms = 350): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
