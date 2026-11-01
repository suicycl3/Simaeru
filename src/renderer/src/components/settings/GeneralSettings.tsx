import { useEffect,useState } from 'react';
import { getLang,LANGS,locale,t } from '@shared/i18n';
import type { StartupSettings } from '@shared/types';
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

/** 閉じるボタン（×）を押したとき: 毎回確認する / タスクトレイに常駐する / アプリを終了する */
function CloseActionRow(): JSX.Element | null {
  const [action, setAction] = useState<'ask' | 'tray' | 'quit' | null>(null);
  useEffect(() => {
    void window.api.closeAction().then(setAction);
  }, []);
  if (!action) return null;
  return (
    <>
      <div className="settings__row">
        <span className="settings__label">{t('閉じるボタン（×）を押したとき')}</span>
        <select
          className="select select--xs"
          value={action}
          aria-label={t('閉じるボタン（×）を押したとき')}
          onChange={(e) => void window.api.setCloseAction(e.target.value as 'ask' | 'tray' | 'quit').then(setAction)}
        >
          <option value="ask">{t('毎回確認する')}</option>
          <option value="tray">{t('タスクトレイに常駐する')}</option>
          <option value="quit">{t('アプリを終了する')}</option>
        </select>
      </div>
      <p className="muted detail__note">
        {t('タスクトレイに常駐すると、ウィンドウを閉じてもダウンロードや MCP サーバーは動き続けます。タスクトレイのアイコンを右クリックすると、表示・設定・MCP サーバーの起動と停止・再起動・終了ができます。')}
      </p>
    </>
  );
}

/** 終了・再起動。× でタスクトレイに常駐させていると、ほかに終わらせる道筋が無いので */
function QuitRow(): JSX.Element {
  return (
    <div className="settings__row">
      <span className="settings__label">{t('アプリ')}</span>
      <button className="btn btn--xs" onClick={() => void window.api.quit(true)}>
        {t('再起動')}
      </button>
      <button className="btn btn--xs" onClick={() => void window.api.quit(false)}>
        {t('終了')}
      </button>
    </div>
  );
}

/** Windows の起動時に起動する（既定はオフ）。窓を出さずにタスクトレイで起動もできる */
function StartupRow(): JSX.Element | null {
  const [s, setS] = useState<StartupSettings | null>(null);
  useEffect(() => {
    void window.api.startup().then(setS);
  }, []);
  if (!s) return null;
  const save = (next: Partial<Pick<StartupSettings, 'openAtLogin' | 'startInTray'>>): void => void window.api.setStartup(next).then(setS);
  return (
    <>
      <label className="settings__row check">
        <input type="checkbox" checked={s.openAtLogin} onChange={(e) => save({ openAtLogin: e.target.checked })} />
        <span>{t('Windows の起動時に起動する')}</span>
      </label>
      <label className="settings__row check check--sub">
        <input type="checkbox" checked={s.startInTray} disabled={!s.openAtLogin} onChange={(e) => save({ startInTray: e.target.checked })} />
        <span>{t('ウィンドウを出さずにタスクトレイで起動する')}</span>
      </label>
      {s.disabledByWindows && (
        <p className="detail__note stats__error">
          {t('Windows の「スタートアップ アプリ」で無効になっているため、起動しません。タスクマネージャーの「スタートアップ アプリ」で有効にしてください。')}
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
                <CloseActionRow />
                <QuitRow />
                <StartupRow />
                <div className="detail__heading">{t('ライブラリ')}</div>
                <AutoUsedRow />
                <RefetchAllRow />
                <div className="detail__heading">{t('実験的な機能')}</div>
                <CompilationGuessRow />
                <BackupSettings />
              </section>);
}
