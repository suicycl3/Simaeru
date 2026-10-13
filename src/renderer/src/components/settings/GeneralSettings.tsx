import { useEffect,useState } from 'react';
import { getLang,LANGS,locale,t } from '@shared/i18n';
import { formatDuration } from '../../lib/format';
import { THEMES, savedTheme, setTheme, type Theme } from '../../lib/theme';
import BackupSettings from '.././BackupSettings';
import { CompilationGuessRow } from './AccountRows';

/** 閲覧したら自動で♡「使った」を付けるか（既定はオン） */
function AutoUsedRow(): JSX.Element | null {
  const [on, setOn] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void window.api.library.autoUsed().then(setOn);
  }, []);
  if (on === null) return null;
  return (
    <>
      <label className="settings__row check">
        <input
          type="checkbox"
          checked={on}
          disabled={saving}
          onChange={(e) => {
            const next = e.target.checked;
            setSaving(true);
            void window.api.library
              .setAutoUsed(next)
              .then(setOn)
              .finally(() => setSaving(false));
          }}
        />
        <span>{t('閲覧・再生したら自動で「使った」にする')}</span>
      </label>
      <p className="muted detail__note">
        {t('内蔵のビューア・プレイヤーや公式プレイヤーで開いたときに、♥「使った」の印を付けて利用日を記録します。オフにすると、カードや詳細の ♡ を押したときだけ印が付きます。ゲームの起動日は、この設定に関係なく記録されます。')}
      </p>
    </>
  );
}

/** すべての作品のタグ情報（詳細）を取り直す。全部を未取得に戻し、裏の取得をすぐ始める */
function RefetchAllRow(): JSX.Element {
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState<{ count: number; eta: number | null } | null>(null);
  return (
    <>
      <div className="settings__row">
        {confirm ? (
          <>
            <span>{t('すべての作品の詳細（タグ・スタッフ・説明文）を、バックグラウンドで取得し直します。よろしいですか？')}</span>
            <button
              className="btn btn--xs btn--primary"
              onClick={() =>
                void window.api.meta.refetchAll().then((r) => {
                  setConfirm(false);
                  setDone({ count: r.count, eta: r.status.etaSeconds });
                })
              }
            >
              {t('取得し直す')}
            </button>
            <button className="btn btn--xs btn--ghost" onClick={() => setConfirm(false)}>
              {t('やめる')}
            </button>
          </>
        ) : (
          <button className="btn btn--xs" onClick={() => { setDone(null); setConfirm(true); }}>
            {t('すべての作品のタグ情報を取得し直す…')}
          </button>
        )}
      </div>
      <p className="muted detail__note">
        {t('サイトでジャンルが追加・修正されたときに使います。今あるタグは消さずに、新しく取得したタグを追加します。終わるまでは、作品は「未取得」として数えられます。進み具合は画面下のステータスバーに表示されます（数千件なら、取得の速さの設定によって数十分〜数時間かかります）。')}
      </p>
      {done && (
        <p role="status" className="muted">
          {done.eta
            ? t('{0} 件を取得し直しています（目安 {1}）。', { 0: done.count.toLocaleString(locale()), 1: formatDuration(done.eta) })
            : t('{0} 件を取得し直しています。', { 0: done.count.toLocaleString(locale()) })}
        </p>
      )}
    </>
  );
}

/** テーマ（配色）。選んだらすぐ切り替わる */
function ThemeRow(): JSX.Element {
  const [theme, setThemeState] = useState<Theme>(savedTheme);
  return (
    <div className="settings__row">
      <span className="settings__label">{t('テーマ')}</span>
      <select
        className="select select--xs"
        value={theme}
        aria-label={t('テーマ')}
        onChange={(e) => {
          const next = e.target.value as Theme;
          setTheme(next);
          setThemeState(next);
        }}
      >
        {THEMES.map((x) => (
          <option key={x.value} value={x.value}>
            {x.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function GeneralSettings(): JSX.Element {
  return (<section className="settings">
                <div className="detail__heading">{t('表示')}</div>
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
                  {t('切り替えると画面を読み込み直します。作品名や説明文など、サイトから取り込んだ内容は翻訳されません。')}
                </p>
                <ThemeRow />
                <div className="detail__heading">{t('ライブラリ')}</div>
                <AutoUsedRow />
                <RefetchAllRow />
                <div className="detail__heading">{t('実験的な機能')}</div>
                <CompilationGuessRow />
                <BackupSettings />
              </section>);
}
