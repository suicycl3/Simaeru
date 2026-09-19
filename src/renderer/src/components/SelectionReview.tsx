import { useEffect, useState } from 'react';
import type { Product } from '@shared/types';
import { t } from '@shared/i18n';

export default function SelectionReview({ ids, onClose }: { ids: number[]; onClose: () => void }): JSX.Element {
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<Array<Product | null>>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setRows([]);
    void Promise.all(ids.slice(page * 50, page * 50 + 50).map((id) => window.api.library.product(id))).then((value) => { if (active) setRows(value); }).catch((e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [ids, page]);
  return <div className="modal" role="dialog" aria-modal="true" aria-label={t('選択内容を確認')}><div className="modal__panel">
    <div className="modal__head"><h3>{t('選択内容を確認')} ({ids.length})</h3><button className="detail__close" aria-label={t('閉じる')} onClick={onClose}>×</button></div>
    {error && <p role="alert">{error}</p>}
    <ol start={page * 50 + 1}>{rows.map((row, i) => <li key={ids[page * 50 + i]}>{row?.title ?? `#${ids[page * 50 + i]}`} — {row?.siteId} / {row?.productId}</li>)}</ol>
    <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>←</button>
    <span> {page + 1} / {Math.max(1, Math.ceil(ids.length / 50))} </span>
    <button className="btn" disabled={(page + 1) * 50 >= ids.length} onClick={() => setPage(page + 1)}>→</button>
  </div></div>;
}
