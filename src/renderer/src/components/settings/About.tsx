import { APP_NAME } from '@shared/appInfo';
import { locale, t } from '@shared/i18n';
import { useEffect,useState } from 'react';
import Markdown from '../Markdown';

type UpdateResult = Awaited<ReturnType<typeof window.api.checkUpdate>>;

/** 新しい版の確認。押したときだけ GitHub のリリースに問い合わせる */
function UpdateRow(): JSX.Element {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateResult | { error: string } | null>(null);
  const check = (): void => {
    setChecking(true);
    setResult(null);
    void window.api
      .checkUpdate()
      .then(setResult)
      .catch((err: unknown) => setResult({ error: (err instanceof Error ? err.message : String(err)).replace(/^.*?Error: /, '') }))
      .finally(() => setChecking(false));
  };
  return (
    <>
      <div className="settings__row">
        <span className="settings__label">{t('新しい版')}</span>
        <button className="btn btn--xs" disabled={checking} onClick={check}>
          {checking ? t('確認しています…') : t('新しい版を確認')}
        </button>
        {result && 'error' in result && <span className="muted">{result.error}</span>}
        {result && !('error' in result) && !result.newer && <span className="muted">{t('最新の版です（{0}）。', { 0: result.latest })}</span>}
        {result && !('error' in result) && result.newer && (
          <>
            <span>
              {t('新しい版 {0} があります（いまは {1}）。', { 0: result.latest, 1: result.current })}
              {result.publishedAt ? ` ${t('{0} 公開', { 0: new Date(result.publishedAt).toLocaleDateString(locale()) })}` : ''}
            </span>
            {result.url && (
              <button className="link" onClick={() => void window.api.openExternal(result.url!)}>
                {t('リリースのページを開く')}
              </button>
            )}
          </>
        )}
      </div>
      <p className="field__hint">
        {t('押したときだけ、配布元（GitHub）の最新のリリースを問い合わせます。送るのはアプリの名前と版だけです。新しい版は、リリースのページから zip を落としてフォルダごと差し替えます（データはそのまま引き継がれます）。')}
      </p>
    </>
  );
}

/**
 * 使わなくなったときの「ユーザーデータを削除して終了」。
 * 消すもの（データのフォルダ）と残すもの（ダウンロードした作品）を見せ、確認を取ってから実行する
 */
function RemoveDataSection({ userData }: { userData: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [root, setRoot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (open) void window.api.download.settings().then((s) => setRoot(s.root));
  }, [open]);
  return (
    <>
      <div className="detail__heading">{t('このアプリを使わなくなったとき')}</div>
      {!open ? (
        <div className="settings__row">
          <button className="btn btn--xs" onClick={() => setOpen(true)}>
            {t('ユーザーデータを削除して終了…')}
          </button>
        </div>
      ) : (
        <div className="removeData">
          <p>{t('次のフォルダを丸ごと消して、アプリを終了します。元に戻せません。')}</p>
          <code className="dlbar__path">{userData}</code>
          <ul className="settings__list">
            <li>{t('台帳（作品の一覧・お気に入り・プレイリスト・紐付け）と設定')}</li>
            <li>{t('保存した ID/パスワードと、各サイトのログイン状態')}</li>
            <li>{t('表紙などのキャッシュと、設定の「ツール」から入れた 7-Zip・ffmpeg・NeeView')}</li>
          </ul>
          <p>{t('ダウンロードした作品のファイルは消しません。残る場所:')}</p>
          {root && <code className="dlbar__path">{root}</code>}
          <p className="muted detail__note">
            {t('消し終わるまで数秒かかります。そのあいだはアプリを開かないでください。アプリ本体（Simaeru.exe のあるフォルダ）は消さないので、使わなくなったら手で消してください。')}
          </p>
          <label className="check">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>{t('消したデータは元に戻せないことを確かめました')}</span>
          </label>
          {error && <div className="banner banner--error">{error}</div>}
          <div className="settings__row">
            <button
              className="btn btn--xs btn--danger"
              disabled={!agreed || leaving}
              onClick={() => {
                setError(null);
                setLeaving(true);
                void window.api.deleteUserDataAndQuit().catch((err: unknown) => {
                  setLeaving(false);
                  setError((err instanceof Error ? err.message : String(err)).replace(/^.*?Error: /, ''));
                });
              }}
            >
              {leaving ? t('終了しています…') : t('ユーザーデータを削除して終了')}
            </button>
            <button className="btn btn--xs btn--ghost" disabled={leaving} onClick={() => { setOpen(false); setAgreed(false); setError(null); }}>
              {t('やめる')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

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
      <UpdateRow />
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
      <RemoveDataSection userData={info.userData} />
      <div className="detail__heading">{t('使っているソフトウェアのライセンス')}</div>
      {/* 文書の1行目の見出しは画面の見出しと重なるので出さない。ライセンス本文（###）は折りたたむ */}
      <Markdown source={info.notices.replace(/^#\s[^\n]*\n/, '')} collapseFrom={3} />
    </section>
  );
}
