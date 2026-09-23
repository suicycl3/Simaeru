import { useEffect, useRef } from 'react';
import { t } from '@shared/i18n';

interface Props {
  query: string;
  onQuery: (q: string) => void;
  /** 当たりの数（null は数えている最中） */
  count: number | null;
  /** いま選んでいる当たり（0 始まり） */
  current: number;
  onMove: (delta: number) => void;
  onClose: () => void;
}

/**
 * ビューア内の検索欄。Enter で次、Shift+Enter で前、Esc で閉じる。
 * 数え終わるまで時間がかかるもの（PDF の全ページ）は count を null にして「検索中…」と出す。
 */
export default function FindBar({ query, onQuery, count, current, onMove, onClose }: Props): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const status =
    !query.trim()
      ? ''
      : count === null
        ? t('検索中…')
        : count === 0
          ? t('見つかりません')
          : `${current + 1} / ${count}`;

  return (
    <div className="findbar" role="search">
      <input
        ref={inputRef}
        className="findbar__input"
        type="search"
        value={query}
        placeholder={t('ビューア内を検索')}
        aria-label={t('ビューア内を検索')}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onMove(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
          // 検索欄の中の矢印キーでページがめくれないように
          e.stopPropagation();
        }}
      />
      <span className="findbar__status muted" aria-live="polite">
        {status}
      </span>
      <button className="btn btn--xs" disabled={!count} onClick={() => onMove(-1)} aria-label={t('前を検索')} title={t('前を検索（Shift+Enter）')}>
        ▲
      </button>
      <button className="btn btn--xs" disabled={!count} onClick={() => onMove(1)} aria-label={t('次を検索')} title={t('次を検索（Enter）')}>
        ▼
      </button>
      <button className="btn btn--xs btn--ghost" onClick={onClose} aria-label={t('検索を閉じる')} title={t('検索を閉じる（Esc）')}>
        ×
      </button>
    </div>
  );
}
