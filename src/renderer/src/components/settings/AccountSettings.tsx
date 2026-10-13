import { t } from '@shared/i18n';
import type {
LoginStatus,
ServiceWarning
} from '@shared/types';
import { DgpAccountRow,DmmPlayerAccountRow } from './AccountRows';

export default function AccountSettings({ auth, siteLabels, serviceWarnings, onLogin, onLoginService, onLogout, onRecheck, onEditCredentials }: {
  auth: LoginStatus[];
  siteLabels: Record<string, string>;
  serviceWarnings: ServiceWarning[];
  onLogin: (siteId: string) => void;
  onLoginService: (siteId: string, service: string) => void;
  onLogout: (siteId: string) => void;
  onRecheck: () => void;
  onEditCredentials: (siteId: string) => void;
}): JSX.Element {
  const loginWarnings = auth.filter((a) => !a.loggedIn || a.uncertain);
  return (<section className="settings">
                <p className="muted">
                  {t('ログインは各サイトの画面で行います。ID/PW を保存しておくと自動で入力します（ログインのボタンは押しません）。保存した ID/PW は Windows の機能で暗号化して保存します。')}
                </p>
                <div className="detail__heading">{t('ログイン')}</div>
                {auth.map((a) => (
                  <div key={a.siteId} className={`account ${!a.loggedIn || a.uncertain ? 'account--warn' : ''}`}>
                    <span className={`status-dot ${a.loggedIn ? 'status-dot--on' : ''} ${a.uncertain ? 'status-dot--unknown' : ''}`} />
                    <b className="account__site">{siteLabels[a.siteId] ?? a.siteId}</b>
                    <span className={a.loggedIn && !a.uncertain ? 'muted' : 'account__state'} title={a.message ?? undefined}>
                      {a.uncertain ? t('{0}?（確認できませんでした）', { 0: a.loggedIn ? t('ログイン中') : t('未ログイン') }) : a.loggedIn ? t('ログイン中') : t('未ログイン')}
                    </span>
                    <span className="account__actions">
                      {a.loggedIn ? (
                        <button className="btn btn--xs btn--ghost" onClick={() => onLogout(a.siteId)}>
                          {t('ログアウト')}
                        </button>
                      ) : (
                        <button className="btn btn--xs btn--primary" onClick={() => onLogin(a.siteId)}>
                          {t('ログイン')}
                        </button>
                      )}
                      <button className="btn btn--xs" onClick={() => onEditCredentials(a.siteId)}>
                        {t('ID/PW を保存…')}
                      </button>
                    </span>
                  </div>
                ))}
                {serviceWarnings.map((w) => (
                  <div key={`${w.siteId}:${w.service}`} className="account account--warn">
                    <span className="status-dot" />
                    <b className="account__site">{w.label}</b>
                    <span className="account__state">{w.text}</span>
                    <span className="account__actions">
                      <button className="btn btn--xs btn--primary" onClick={() => w.uncertain ? onRecheck() : onLoginService(w.siteId, w.service)}>
                        {w.uncertain ? t('ログイン状態を再確認') : t('ログイン')}
                      </button>
                    </span>
                  </div>
                ))}
                <div className="settings__row">
                  <button className="btn btn--xs" onClick={onRecheck}>
                    {t('ログイン状態を再確認')}
                  </button>
                  {loginWarnings.length === 0 && serviceWarnings.length === 0 && <span className="muted">{t('すべてのサイトにログインしています。')}</span>}
                </div>
                <p className="muted detail__note">
                  {t('一般向けの DMM ブックス（dmm.com）は、FANZA（dmm.co.jp）とは別にログインが必要です。一般向けの本を購入している場合だけ確認します（同じ DMM アカウントの ID/PW を自動で入力します）。')}
                </p>
                <div className="detail__heading">{t('公式アプリ')}</div>
                <DgpAccountRow />
                <DmmPlayerAccountRow />
              </section>);
}
