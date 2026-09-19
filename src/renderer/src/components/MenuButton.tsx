import { useEffect, useRef, useState } from 'react';
import { t } from '@shared/i18n';

export interface MenuItem {
  label: string;
  /** 補足（小さく2行目に出す） */
  hint?: string;
  disabled?: boolean;
  onSelect: () => void;
}

interface Props {
  /** 押すと実行する本体のボタン */
  label: React.ReactNode;
  onClick: () => void;
  title?: string;
  className?: string;
  disabled?: boolean;
  /** ▾ で開く選択肢 */
  items: MenuItem[];
  menuTitle?: string;
}

/**
 * 本体のボタン＋▾ で選択肢を出すボタン。よく使う操作を1押しで、たまに使う操作は ▾ から選べるようにする。
 */
export default function MenuButton({ label, onClick, title, className = 'btn', disabled, items, menuTitle }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="splitBtn" ref={ref}>
      <button className={`${className} splitBtn__main`} onClick={onClick} title={title} disabled={disabled}>
        {label}
      </button>
      <button
        className={`${className} splitBtn__caret`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={menuTitle ?? t('ほかの操作')}
        disabled={disabled}
      >
        ▾
      </button>
      {open && (
        <div className="menu" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              className="menu__item"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              <span>{item.label}</span>
              {item.hint && <span className="menu__hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
