import { SEARCH_FIELD_LABELS, type SearchField, type SortDir, type SortKey } from '@shared/types';
import ClearableInput from './ClearableInput';
import MenuButton from './MenuButton';
import { t } from '@shared/i18n';

interface Props {
  search: string;
  onSearch: (v: string) => void;
  /** 検索語を正規表現として扱う */
  useRegex: boolean;
  onUseRegex: (v: boolean) => void;
  /** 正規表現が不正なときの理由 */
  regexError: string | null;
  /** 検索の対象。既定はタイトルとブランド */
  searchFields: SearchField[];
  onSearchFields: (fields: SearchField[]) => void;
  sortKey: SortKey;
  onSortKey: (v: SortKey) => void;
  sortDir: SortDir;
  onSortDir: (v: SortDir) => void;
  view: 'grid' | 'list';
  onView: (v: 'grid' | 'list') => void;
  total: number;
  /** いま表示している範囲をまとめてダウンロードする */
  onDownloadAll: () => void;
  /** 手元にある作品を表示しているとき（ダウンロード済みなど）だけ、削除のメニューを出す */
  canTrash: boolean;
  /** 表示中の作品すべての手元のファイルを削除する */
  onTrashAll: () => void;
  /** 選んで削除する（選ぶ画面を、削除を主にして開く） */
  onStartDeleting: () => void;
  /** 選んでダウンロードするモード */
  selecting: boolean;
  onStartSelecting: () => void;
  syncing: boolean;
  /** full: true で全件取り直す */
  onSync: (opts?: { full?: boolean }) => void;
  onCancel: () => void;
}

const SORT_KEYS: Array<{ value: SortKey; label: string }> = [
  { value: 'purchased', label: t('購入日順') },
  { value: 'released', label: t('発売日順') },
  { value: 'title', label: t('タイトル順') },
  { value: 'maker', label: t('ブランド順') },
  { value: 'used', label: t('利用日順') }
];

/** 基準ごとに「昇順/降順」の呼び方を変えると意味が伝わりやすい */
const DIR_LABEL: Record<SortKey, { asc: string; desc: string }> = {
  purchased: { asc: t('古い順'), desc: t('新しい順') },
  released: { asc: t('古い順'), desc: t('新しい順') },
  title: { asc: 'A→Z', desc: 'Z→A' },
  maker: { asc: 'A→Z', desc: 'Z→A' },
  used: { asc: t('古い順'), desc: t('最近の順') }
};

export default function Toolbar({
  search,
  onSearch,
  useRegex,
  onUseRegex,
  regexError,
  searchFields,
  onSearchFields,
  sortKey,
  onSortKey,
  sortDir,
  onSortDir,
  view,
  onView,
  total,
  onDownloadAll,
  canTrash,
  onTrashAll,
  onStartDeleting,
  selecting,
  onStartSelecting,
  syncing,
  onSync,
  onCancel
}: Props): JSX.Element {
  const dirLabel = DIR_LABEL[sortKey][sortDir];

  return (
    <header className="toolbar">
      <div className="toolbar__search">
        <ClearableInput
          value={search}
          onChange={onSearch}
          placeholder={useRegex ? t('正規表現で検索（例: ^魔法.*少女$）') : t('タイトル・ブランドで検索')}
        />
        {/* 正規表現モードはタイトル/ブランド/作者/タグを対象に総当たりする（索引は使えない） */}
        <label className="toolbar__regex" title={t('正規表現で検索します（大文字小文字は区別しません）')}>
          <input type="checkbox" checked={useRegex} onChange={(e) => onUseRegex(e.target.checked)} />
          {t('正規表現')}
        </label>
        {/* 検索の対象。説明文や作品IDを足すと全文検索の索引が使えないので総当たりになる */}
        <div className="toolbar__fields">
          {(['title', 'maker', 'description', 'productId', 'creators'] as SearchField[]).map((f) => (
            <label key={f} className="toolbar__regex" title={t('{0}を検索対象にする', { 0: t(SEARCH_FIELD_LABELS[f]) })}>
              <input
                type="checkbox"
                checked={searchFields.includes(f)}
                onChange={(e) =>
                  onSearchFields(
                    e.target.checked
                      ? [...searchFields, f]
                      : searchFields.filter((v) => v !== f).length
                        ? searchFields.filter((v) => v !== f)
                        : ['title']
                  )
                }
              />
              {t(SEARCH_FIELD_LABELS[f])}
            </label>
          ))}
        </div>
        {regexError && <span className="toolbar__regexError">{t('式が不正です: {regexError}', { regexError })}</span>}
      </div>

      <div className="toolbar__actions">
      <span className="toolbar__count">{t('{0} 件', { 0: total.toLocaleString() })}</span>

      <select
        className="select"
        value={sortKey}
        aria-label={t('並べ替えの基準')}
        onChange={(e) => onSortKey(e.target.value as SortKey)}
      >
        {SORT_KEYS.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>

      <button
        className="btn btn--ghost btn--dir"
        title={sortDir === 'asc' ? t('昇順') : t('降順')}
        onClick={() => onSortDir(sortDir === 'asc' ? 'desc' : 'asc')}
      >
        {sortDir === 'asc' ? '↑' : '↓'} {dirLabel}
      </button>

      <div className="segmented">
        <button className={view === 'grid' ? 'on' : ''} onClick={() => onView('grid')}>
          {t('グリッド')}
        </button>
        <button className={view === 'list' ? 'on' : ''} onClick={() => onView('list')}>
          {t('リスト')}
        </button>
      </div>

      <MenuButton
        label={t('ダウンロード')}
        title={t('いま表示している作品をダウンロードのキューに入れます')}
        onClick={onDownloadAll}
        menuTitle={t('ダウンロードのしかた')}
        items={[
          { label: t('表示中の {0} 件をダウンロード', { 0: total.toLocaleString() }), hint: t('絞り込んだ結果をまとめてキューに入れます'), onSelect: onDownloadAll },
          {
            label: t('選んでダウンロード…'),
            hint: t('カードを押して選びます（Ctrl+クリックでいつでも選べます）'),
            disabled: selecting,
            onSelect: onStartSelecting
          }
        ]}
      />

      {canTrash && (
        <MenuButton
          label={t('削除')}
          title={t('いま表示している作品の、手元のファイルをごみ箱へ入れます')}
          onClick={onTrashAll}
          menuTitle={t('削除のしかた')}
          items={[
            {
              label: t('表示中の {0} 件のファイルを削除', { 0: total.toLocaleString() }),
              hint: t('絞り込んだ結果すべての手元のファイルを、確かめてからごみ箱へ入れます'),
              disabled: total === 0,
              onSelect: onTrashAll
            },
            {
              label: t('選んで削除…'),
              hint: t('カードを押して選び、選んだ作品のファイルをごみ箱へ入れます'),
              disabled: selecting,
              onSelect: onStartDeleting
            }
          ]}
        />
      )}

      {syncing ? (
        <button className="btn btn--ghost" onClick={onCancel}>
          {t('同期を中断')}
        </button>
      ) : (
        /* 既定は差分。購入履歴は新しい順に並ぶので、既知のぶんに当たった時点で打ち切る */
        <MenuButton
          label={t('購入履歴を同期')}
          className="btn btn--primary"
          title={t('新しく買った分を取り込みます')}
          onClick={() => onSync()}
          menuTitle={t('同期のしかた')}
          items={[
            { label: t('新しく買った分だけ（通常）'), hint: t('既知の作品に当たったところで打ち切ります'), onSelect: () => onSync() },
            { label: t('全件を取り直す'), hint: t('既知の分も含めて取り直します（時間がかかります）'), onSelect: () => onSync({ full: true }) }
          ]}
        />
      )}
      </div>
    </header>
  );
}
