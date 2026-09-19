/** 保存資格情報の入力を許可するログインorigin。サフィックス一致は使わない。 */
export function credentialOriginAllowed(siteId: string, url: string): boolean {
  try {
    const u = new URL(url);
    const origins: Record<string, string[]> = {
      dmm: ['https://accounts.dmm.co.jp', 'https://accounts.dmm.com'],
      dlsite: ['https://login.dlsite.com']
    };
    return !u.username && !u.password && (origins[siteId] ?? []).includes(u.origin);
  } catch {
    return false;
  }
}
