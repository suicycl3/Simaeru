import { useState } from 'react';
import { t } from '@shared/i18n';

export default function BackupSettings(): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const run = async (restore: boolean): Promise<void> => {
    setBusy(true); setMessage('');
    try {
      const result = restore ? await window.api.library.restore() : await window.api.library.backup();
      if (typeof result === 'string') setMessage(`${t('保存しました')}: ${result}`);
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  return <>
    <div className="detail__heading">{t('バックアップ')}</div>
    <div className="settings__row">
      <button className="btn btn--xs" disabled={busy} onClick={() => void run(false)}>{t('バックアップを保存…')}</button>
      <button className="btn btn--xs btn--ghost" disabled={busy} onClick={() => void run(true)}>{t('バックアップから復元…')}</button>
    </div>
    <p className="muted detail__note">{t('ライブラリの情報（作品の一覧・お気に入り・プレイリスト・起動の紐付け）と設定を、1 つのファイルに保存します。作品のファイル・表紙・ログイン情報は含みません。')}</p>
    {message && <p role="status" className="muted detail__note" style={{ overflowWrap: 'anywhere' }}>{message}</p>}
  </>;
}
