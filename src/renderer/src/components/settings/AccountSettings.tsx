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
                  {t('ログインはサイトの画面で行います（ID/PW を保存しておくと自動で入力します。送信ボタンは押しません）。保存した ID/PW は Windows の暗号化で守られ、平文では保存しません。')}
                </p>
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
                        {w.uncertain ? t('ログイン状態を確かめ直す') : t('ログイン')}
                      </button>
                    </span>
                  </div>
                ))}
                <DgpAccountRow />
                <DmmPlayerAccountRow />
                <div className="settings__row">
                  <button className="btn btn--xs" onClick={onRecheck}>
                    {t('ログイン状態を確かめ直す')}
                  </button>
                  {loginWarnings.length === 0 && serviceWarnings.length === 0 && <span className="muted">{t('すべてのサイトにログインしています。')}</span>}
                </div>
                <p className="muted detail__note">
                  {t('一般向けの DMM ブックス（dmm.com）は FANZA（dmm.co.jp）とは別のログインです。一般向けの本を持っているときだけ確かめます（同じ DMM アカウントの ID/PW を自動で入力します）。')}
                </p>
              </section>);
}
