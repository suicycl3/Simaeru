import { useEffect,useState } from 'react';
import { getLang,LANGS,t } from '@shared/i18n';
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
        {t('ビューアやプレイヤーで中身を開いたとき、公式プレイヤーで見たときに、♥「使った」の印を付けて利用日を残します。オフにすると、カードや詳細の ♡ を押したときだけ印が付きます。ゲームの起動日は、この設定に関係なく残ります。')}
      </p>
    </>
  );
}

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
                <div className="detail__heading">{t('ライブラリ')}</div>
                <AutoUsedRow />
                <div className="detail__heading">{t('実験的な機能')}</div>
                <CompilationGuessRow />
                <BackupSettings />
              </section>);
}
