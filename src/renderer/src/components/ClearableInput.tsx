import { t } from '@shared/i18n';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** 幅の詰まった場所（サイドバー等）で使う小さめの見た目 */
  small?: boolean;
  ariaLabel?: string;
}

/**
 * 自由入力欄。値が入っているときだけ × を出して、マウスで消せるようにする。
 * 検索・絞り込みなど入力欄を増やすたびに同じものを書かないよう共通化してある。
 */
export default function ClearableInput({
  value,
  onChange,
  placeholder,
  small,
  ariaLabel
}: Props): JSX.Element {
  return (
    <div className="clearable">
      <input
        className={`input ${small ? 'input--sm' : ''}`}
        placeholder={placeholder}
        value={value}
        aria-label={ariaLabel ?? placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button className="clearable__clear" onClick={() => onChange('')} aria-label={t('入力をクリア')}>
          ×
        </button>
      )}
    </div>
  );
}
