import { useEffect, useState } from 'react';
import type { SyncHistoryEntry } from '@shared/types';
import { t } from '@shared/i18n';

export default function SyncHistory({ onClose, onRetry, busy }: { onClose: () => void; onRetry: (keys: string[]) => void; busy: boolean }): JSX.Element {
  const [rows, setRows] = useState<SyncHistoryEntry[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { void window.api.sync.history().then(setRows).catch((e) => setError(String(e))); }, [busy]);
  return <div className="modal" role="dialog" aria-modal="true" aria-label={t('同期履歴')}>
    <div className="modal__panel">
      <div className="modal__head"><h3>{t('同期履歴')}</h3><button className="detail__close" onClick={onClose} aria-label={t('閉じる')}>×</button></div>
      {error && <p role="alert">{error}</p>}
      {rows.map((row) => <section key={row.runId} className="syncHistory__entry">
        <strong>{new Date(row.startedAt).toLocaleString()} — {t(row.status === 'done' ? '同期が完了しました' : row.status === 'cancelled' ? '同期を中断しました' : row.status === 'partial' ? '同期の一部が失敗しました' : row.status === 'error' ? '同期に失敗しました' : '同期中')}</strong>
        <ul>{row.floors.map((floor) => <li key={floor.floorKey}>{floor.floorKey}: {floor.error ?? `${floor.fetched} / +${floor.added}`}</li>)}</ul>
        {row.floors.some((f) => f.error) && <button className="btn" disabled={busy} onClick={() => onRetry(row.floors.filter((f) => f.error).map((f) => f.floorKey))}>{t('失敗したフロアを再試行')}</button>}
      </section>)}
    </div>
  </div>;
}
