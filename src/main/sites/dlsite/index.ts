import type { SiteAdapter } from '../types';
import { DLSITE_PARTITION, probeDlsiteLogin } from './client';
import { dlsiteLibraryFloor } from './library';

export const dlsiteSite: SiteAdapter = {
  siteId: 'dlsite',
  label: 'DLsite',
  partition: DLSITE_PARTITION,
  loginUrl: 'https://login.dlsite.com/login',
  isLoggedInUrl(url: string) {
    // ログイン後は play か www 側へ戻る
    return /^https:\/\/(play|www)\.dlsite\.com\//.test(url);
  },
  probeLogin: probeDlsiteLogin,
  floors: [dlsiteLibraryFloor]
};
