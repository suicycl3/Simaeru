import { authStatusMessage,authValue,type AuthResult } from '@shared/auth';
import { APP_NAME } from '@shared/appInfo';
import { t } from '@shared/i18n';
import type { FloorInfo,LoginStatus } from '@shared/types';
import { dialog,ipcMain } from 'electron';
import fs from 'node:fs';
import { CredentialStore,isSecureStorageAvailable } from '../auth/credentials';
import { authDiagnostics,recordAuth } from '../auth/diagnostics';
import { clearSiteSession,openLoginWindow } from '../auth/loginWindow';
import type { Repo } from '../db/repo';
import { DMM_LOGIN_TARGETS } from '../sites/dmm';
import { probeBookComLogin } from '../sites/dmm/book';
import { probeVideoLogin } from '../sites/dmm/video';
import { getSite,listFloors,SITES } from '../sites/registry';

type Deps = {
  repo: Repo;
  credentials: CredentialStore;
  send: (channel: string, payload: unknown) => void;
};

/** 認証状態と認証に依存するフロアの公開を同じ境界で管理する。 */
export function registerAuthIpc({ repo, credentials, send }: Deps): { loggedInSites: () => string[] } {
  const loggedInSites = new Set<string>();
  let authChecked = false;

  /**
   * 直近に確定した判定結果。通信に失敗しただけのときに
   * 「未ログイン」へ倒してしまわないよう、前回値を持っておく。
   */
  const lastKnown = new Map<string, boolean>();

  async function refreshAuth(): Promise<LoginStatus[]> {
    const statuses: LoginStatus[] = [];
    for (const site of SITES) {
      const probed = await site.probeLogin();
      // unknown は「判定できなかった」とき。
      // 通信の一時的な失敗で未ログイン表示に変わると、ログインし直しを促してしまう。
      const uncertain = probed.state === 'unknown';
      const loggedIn = uncertain ? (lastKnown.get(site.siteId) ?? false) : probed.state === 'authenticated';
      // adapter の reason は例外の文面。画面に出す文言はここで作る
      const message = authStatusMessage(t(site.label), probed);
      recordAuth({ service: site.siteId, event: 'probe', state: uncertain ? 'unknown' : loggedIn ? 'authenticated' : 'unauthenticated' });
      if (!uncertain) lastKnown.set(site.siteId, loggedIn);
      if (loggedIn) loggedInSites.add(site.siteId);
      else loggedInSites.delete(site.siteId);

      // 動画は本体とは別にサービス側のログインを求められることがある。
      // 本体が未ログインならそちらが先なので、ここでは判定しない。
      const services: Record<string, boolean | null> = {};
      const probeService = async (service: string, probe: () => Promise<AuthResult>): Promise<void> => {
        const result = await probe();
        services[service] = authValue(result);
        recordAuth({ service, event: 'probe', state: result.state });
      };
      if (loggedIn && site.siteId === 'dmm') await probeService('video', probeVideoLogin);
      // 一般向けの DMM ブックス（dmm.com）は FANZA とは別のログイン。持っている作品があるときだけ確かめる
      if (site.siteId === 'dmm' && repo.countGeneralBooks() > 0) await probeService('bookCom', probeBookComLogin);

      statuses.push({
        siteId: site.siteId as LoginStatus['siteId'],
        loggedIn,
        services,
        message,
        uncertain,
        checkedAt: Date.now()
      });
    }
    authChecked = true;
    return statuses;
  }

  ipcMain.handle('app:info', () => ({
    appName: APP_NAME,
    sites: SITES.map((s) => ({ siteId: s.siteId, label: s.label }))
  }));

  ipcMain.handle('auth:status', () => refreshAuth());
  ipcMain.handle('auth:diagnostics', async () => {
    const result = await dialog.showSaveDialog({ defaultPath: `${APP_NAME}-auth-diagnostics.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return null;
    await fs.promises.writeFile(result.filePath, authDiagnostics(), 'utf8');
    return result.filePath;
  });

  /**
   * service を渡すとサービス別ログイン（FANZA動画など）を開く。
   * 動画は本体にログイン済みでも別途ログインを求められるため。
   */
  ipcMain.handle('auth:login', async (_e, siteId: string, service?: string) => {
    const site = getSite(siteId);
    const target = service ? DMM_LOGIN_TARGETS[service] : undefined;
    if (service && !target) throw new Error(t('未知のログイン対象です: {service}', { service }));
    openLoginWindow(
      site,
      (result) => {
        const uncertain = result.state === 'unknown';
        const loggedIn = uncertain ? (lastKnown.get(siteId) ?? false) : result.state === 'authenticated';
        if (!service && !uncertain) {
          lastKnown.set(siteId, loggedIn);
          if (loggedIn) {
            loggedInSites.add(siteId);
            // 未ログインのせいで打ち切られていた作品を、対象に戻す
            repo.resetMetaAttempts(siteId);
          } else {
            loggedInSites.delete(siteId);
          }
        }
        send('auth:changed', { siteId, loggedIn, service: service ?? null, uncertain });
      },
      {
        ...(target ?? {}),
        // 保存済みのログイン情報があれば入力欄まで埋める（送信はしない）
        autofill: () => credentials.reveal(siteId)
      }
    );
    return true;
  });

  /**
   * ログイン情報。パスワードは既定では返さない（`credentials:reveal` を明示的に呼んだときだけ）。
   * 保存は OS の保護領域で暗号化してから。暗号化できない環境では保存しない。
   */
  ipcMain.handle('credentials:list', () => ({
    available: isSecureStorageAvailable(),
    items: credentials.list()
  }));

  ipcMain.handle('credentials:get', (_e, siteId: string) => credentials.get(siteId));

  ipcMain.handle('credentials:reveal', (_e, siteId: string) => credentials.reveal(siteId));

  ipcMain.handle(
    'credentials:save',
    (_e, siteId: string, loginId: string, password: string) => {
      getSite(siteId); // 未知のサイトIDを弾く
      credentials.save(siteId, loginId, password);
      return credentials.get(siteId);
    }
  );

  ipcMain.handle('credentials:clear', (_e, siteId: string) => {
    credentials.clear(siteId);
    return credentials.get(siteId);
  });

  ipcMain.handle('auth:logout', async (_e, siteId: string) => {
    const site = getSite(siteId);
    await clearSiteSession(site);
    lastKnown.set(siteId, false);
    loggedInSites.delete(siteId);
    send('auth:changed', { siteId, loggedIn: false });
    return true;
  });

  ipcMain.handle(
    'library:floors',
    async (): Promise<{ floors: FloorInfo[]; counts: Record<string, number> }> => {
      // ログイン判定より先に呼ばれると全フロアが無効扱いになるので、未判定ならここで確認する
      if (!authChecked) await refreshAuth();
      const counts: Record<string, number> = {};
      for (const c of repo.floorCounts()) counts[c.floorKey] = c.count;
      return { floors: listFloors(loggedInSites), counts };
    }
  );

  return { loggedInSites: () => [...loggedInSites] };
}
