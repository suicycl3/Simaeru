import type { AuthResult } from '@shared/auth';
import type { SiteAdapter } from '../types';
import { DMM_PARTITION, probeDmmLogin } from './client';
import { dlsoftFloor } from './dlsoft';
import { doujinFloor } from './doujin';
import { BOOK_COM_LOGIN_URL, bookFloor, probeBookComLogin } from './book';
import { probeVideoLogin, videoFloor, VIDEO_LOGIN_URL } from './video';
import { t } from '@shared/i18n';

export const dmmSite: SiteAdapter = {
  siteId: 'dmm',
  label: 'DMM / FANZA',
  partition: DMM_PARTITION,
  loginUrl: 'https://accounts.dmm.co.jp/service/login/password',
  isLoggedInUrl(url: string) {
    // ログイン完了後は accounts のマイページ等へ遷移する
    return /^https:\/\/(www|accounts)\.dmm\.(co\.jp|com)\//.test(url) && !/service\/login/.test(url);
  },
  probeLogin: probeDmmLogin,
  floors: [dlsoftFloor, doujinFloor, bookFloor, videoFloor]
};

/**
 * 動画(FANZA)は本体ログインとは別にサービス側のログインを求められるため、
 * ログインウィンドウの開始URLを分けている。
 */
export const DMM_LOGIN_TARGETS: Record<
  string,
  { startUrl: string; probe: () => Promise<AuthResult>; label: string }
> = {
  video: { startUrl: VIDEO_LOGIN_URL, probe: probeVideoLogin, label: 'FANZA動画' },
  // 一般向けの DMM ブックス（dmm.com）。FANZA（dmm.co.jp）とは Cookie のドメインもログインも別
  bookCom: { startUrl: BOOK_COM_LOGIN_URL, probe: probeBookComLogin, label: 'DMMブックス（dmm.com）' }
};

export { probeBookComLogin };

export { fetchDoujinDetail, fetchDoujinFiles } from './doujin';
