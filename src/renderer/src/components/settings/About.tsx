import { APP_NAME } from '@shared/appInfo';
import { t } from '@shared/i18n';
import { useEffect,useState } from 'react';
import Markdown from '../Markdown';

/** 版・データの置き場所・ライセンス */
export default function About(): JSX.Element {
  const [info, setInfo] = useState<{ version: string; userData: string; notices: string } | null>(null);
  const [saved, setSaved] = useState('');
  useEffect(() => {
    void window.api.aboutInfo().then(setInfo);
  }, []);
  if (!info) return <p className="muted">{t('読み込み中…')}</p>;
  return (
    <section className="settings">
      <div className="settings__row">
        <span className="settings__label">{t('版')}</span>
        <span>{APP_NAME} {info.version}</span>
      </div>
      <div className="settings__row">
        <span className="settings__label">{t('データの置き場所')}</span>
        <code className="dlbar__path">{info.userData}</code>
      </div>
      <div className="settings__row">
        <span className="settings__label">{t('アプリログ')}</span>
        <button
          className="btn btn--xs"
          onClick={() =>
            void window.api
              .saveLog()
              .then((file) => setSaved(file ?? ''))
              .catch((error) => setSaved(String(error)))
          }
        >
          {t('ログを保存…')}
        </button>
      </div>
      <p className="field__hint">
        {t('同期・ダウンロード・展開などの動きの記録を、選んだ場所にファイルとして書き出します。うまく動かないときの問い合わせに使えます（ID/PW・Cookie・ダウンロードURLの署名は含みません）。')}
      </p>
      <div className="settings__row">
        <span className="settings__label">{t('ログイン診断ログ')}</span>
        <button
          className="btn btn--xs"
          onClick={() =>
            void window.api.auth
              .diagnostics()
              .then((file) => setSaved(file ?? ''))
              .catch((error) => setSaved(String(error)))
          }
        >
          {t('ログを保存…')}
        </button>
      </div>
      <p className="field__hint">
        {t('ログイン状態の判定だけを取り出した記録です（ID/PW や Cookie は入りません）。')}
      </p>
      {saved && <p role="status" style={{ overflowWrap: 'anywhere' }}>{saved}</p>}
      <div className="detail__heading">{t('使っているソフトウェアのライセンス')}</div>
      {/* 文書の1行目の見出しは画面の見出しと重なるので出さない。ライセンス本文（###）は折りたたむ */}
      <Markdown source={info.notices.replace(/^#\s[^\n]*\n/, '')} collapseFrom={3} />
    </section>
  );
}
