import { getLang, LANGS, t } from '@shared/i18n';

interface Props {
  onLogin: () => void;
  onRecheck: () => void;
}

export default function LoginGate({ onLogin, onRecheck }: Props): JSX.Element {
  return (
    <div className="gate">
      <div className="gate__card">
        <h1>{t('購入履歴を取り込みます')}</h1>
        <p>
          {t('「ログイン」を押すとブラウザウィンドウが開きます。そこで DMM / FANZA にログインしてください。ログインが確認できたらこの画面は自動で切り替わります。')}
        </p>
        <p className="muted">
          {t('ログイン情報はこのアプリが受け取らず、ブラウザウィンドウから DMM へ直接送られます。アプリはログイン後の Cookie セッションを使って一覧APIを読むだけです。')}
        </p>
        <div className="gate__actions">
          <button className="btn btn--primary" onClick={onLogin}>
            {t('ログイン')}
          </button>
          <button className="btn btn--ghost" onClick={onRecheck}>
            {t('ログイン状態を再確認')}
          </button>
        </div>
        <div className="gate__lang">
          <select className="select select--xs" value={getLang()} onChange={(e) => void window.api.setLanguage(e.target.value)} aria-label="Language">
            {LANGS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
