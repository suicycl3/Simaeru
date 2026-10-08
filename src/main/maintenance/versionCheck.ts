import { APP_NAME, APP_REPOSITORY } from '@shared/appInfo';
import { t } from '@shared/i18n';

/**
 * 新しい版があるかを、GitHub のリリース（最新の公開版）に問い合わせる。
 * 利用者が「新しい版を確認」を押したときだけ呼ぶ（自動では通信しない）。
 * 送るのはアプリ名と版（User-Agent）だけで、ID/パスワード・台帳の中身・作品の情報は送らない。
 */
export interface UpdateCheck {
  current: string;
  latest: string;
  /** 新しい版があるか */
  newer: boolean;
  /** リリースのページ（https://github.com/<APP_REPOSITORY>/releases/… のときだけ） */
  url: string | null;
  publishedAt: string | null;
}

/** 'v0.3.1' → [0, 3, 1]。数字でない部分（-beta など）は無視する */
function parts(version: string): number[] {
  return version
    .replace(/^v/i, '')
    .split(/[.-]/)
    .map((p) => Number.parseInt(p, 10))
    .filter((n) => Number.isFinite(n));
}

/** a が b より新しければ正、同じなら 0、古ければ負 */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export async function checkLatestRelease(current: string, fetchImpl: typeof fetch = fetch): Promise<UpdateCheck> {
  let res: Response;
  try {
    res = await fetchImpl(`https://api.github.com/repos/${APP_REPOSITORY}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `${APP_NAME}/${current}` },
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new Error(t('新しい版を確認できませんでした（つながりません）。'));
  }
  if (!res.ok) throw new Error(t('新しい版を確認できませんでした（HTTP {0}）。', { 0: res.status }));
  const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown; published_at?: unknown };
  const latest = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/i, '') : null;
  if (!latest) throw new Error(t('新しい版を確認できませんでした（応答が読めません）。'));
  const url =
    typeof body.html_url === 'string' && body.html_url.startsWith(`https://github.com/${APP_REPOSITORY}/releases/`) ? body.html_url : null;
  return {
    current,
    latest,
    newer: compareVersions(latest, current) > 0,
    url,
    publishedAt: typeof body.published_at === 'string' ? body.published_at : null
  };
}
