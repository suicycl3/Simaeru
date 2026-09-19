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
  return <section>
    <h4>{t('台帳のバックアップ')}</h4>
    <p className="muted">{t('作品・設定・お気に入り・紐付けを保存します。作品ファイル、表紙、ログイン情報は含みません。')}</p>
    <div className="settings__row">
      <button className="btn" disabled={busy} onClick={() => void run(false)}>{t('バックアップを保存')}</button>
      <button className="btn btn--ghost" disabled={busy} onClick={() => void run(true)}>{t('バックアップから復元')}</button>
    </div>
    {message && <p role="status" style={{ overflowWrap: 'anywhere' }}>{message}</p>}
  </section>;
}
