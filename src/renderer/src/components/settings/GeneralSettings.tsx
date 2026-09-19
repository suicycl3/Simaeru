import { getLang,LANGS,t } from '@shared/i18n';
import BackupSettings from '.././BackupSettings';
import { CompilationGuessRow } from './AccountRows';

export default function GeneralSettings(): JSX.Element {
  return (<section className="settings">
                <div className="settings__row">
                  <span className="settings__label">{t('表示する言語')}</span>
                  <select
                    className="select select--xs"
                    value={getLang()}
                    onChange={(e) => void window.api.setLanguage(e.target.value)}
                  >
                    {LANGS.map((l) => (
                      <option key={l.value} value={l.value}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="muted detail__note">
                  {t('切り替えると画面を読み直します。作品のタイトルや説明文など、サイトから取り込んだ内容はそのままです。')}
                </p>
                <div className="detail__heading">{t('実験的な機能')}</div>
                <CompilationGuessRow />
                <BackupSettings />
              </section>);
}
