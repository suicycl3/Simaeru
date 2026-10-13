import { useEffect, useMemo, useState } from 'react';
import { CATEGORY_LABELS, type Category, type CreatorCount } from '@shared/types';
import { t } from '@shared/i18n';
import { storedLabel } from '../lib/labels';

/** 押したときにどの絞り込みに入れるか */
export type IndexKind = 'tag' | 'maker' | 'creator';

interface Entry {
  /** 絞り込みに使う値（保存されているまま） */
  value: string;
  /** 表示する名前（タグは訳す） */
  label: string;
  count: number;
}

interface Tab {
  key: string;
  label: string;
  kind: IndexKind;
  entries: Entry[];
}

/** 声優・出演者はひとつのタブにまとめる */
const CAST_ROLES = new Set(['声優', '出演', 'CV']);
/** ブランド・サークルは作品のブランド欄（maker）で数えるので、人の一覧からは外す */
const MAKER_ROLES = new Set(['ブランド', 'サークル', 'メーカー']);
const CATEGORIES: Category[] = ['game', 'doujin', 'book', 'video'];

interface Props {
  onClose: () => void;
  /** 押したもので一覧を絞り込む（同じ種類の絞り込みは置き換える） */
  onPick: (kind: IndexKind, value: string) => void;
  activeTags: string[];
  activeMakers: string[];
  activeCreators: string[];
  /** 作品の属性のタグか（旧作・セール・対応OSなどは違う）。カードと同じ決まり */
  isAttributeTag: (tag: string) => boolean;
}

/**
 * 索引: タグ・ブランド（サークル）・声優・作者などを、作品数つきで一覧にする。押すとそれで一覧を絞り込む。
 * 区分で範囲を狭められる（PCゲームのタグだけ、など）。
 */
export default function IndexPage({ onClose, onPick, activeTags, activeMakers, activeCreators, isAttributeTag }: Props): JSX.Element {
  const [category, setCategory] = useState<Category | ''>('');
  const [data, setData] = useState<{
    tags: Array<{ tag: string; count: number }>;
    makers: Array<{ maker: string; count: number }>;
    creators: CreatorCount[];
  } | null>(null);
  const [error, setError] = useState('');
  const [tabKey, setTabKey] = useState('tag');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'count' | 'name'>('count');
  /** 属性でないタグ（旧作・セールなど）も出す */
  const [allTags, setAllTags] = useState(false);

  useEffect(() => {
    let alive = true;
    const filter = category ? { categories: [category] } : {};
    setData(null);
    Promise.all([window.api.library.tags(filter), window.api.library.makers(filter), window.api.library.creators(filter)])
      .then(([tags, makers, creators]) => alive && setData({ tags, makers, creators }))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [category]);

  const tabs = useMemo((): Tab[] => {
    if (!data) return [];
    const tabsOut: Tab[] = [
      {
        key: 'tag',
        label: t('タグ'),
        kind: 'tag',
        entries: data.tags.filter((r) => allTags || isAttributeTag(r.tag)).map((r) => ({ value: r.tag, label: t(r.tag), count: r.count }))
      },
      { key: 'maker', label: t('ブランド・サークル'), kind: 'maker', entries: data.makers.map((r) => ({ value: r.maker, label: r.maker, count: r.count })) }
    ];
    // 役割ごとにまとめる。同じ人が同じタブに二度出るとき（声優と出演の両方など）は多いほうの数にする
    const groups = new Map<string, Map<string, number>>();
    for (const c of data.creators) {
      if (MAKER_ROLES.has(c.role)) continue;
      const key = CAST_ROLES.has(c.role) ? 'cast' : `role:${c.role}`;
      const names = groups.get(key) ?? new Map<string, number>();
      names.set(c.name, Math.max(names.get(c.name) ?? 0, c.count));
      groups.set(key, names);
    }
    const toEntries = (names: Map<string, number>): Entry[] =>
      [...names].map(([name, count]) => ({ value: name, label: name, count }));
    const cast = groups.get('cast');
    if (cast) tabsOut.push({ key: 'cast', label: t('声優・出演'), kind: 'creator', entries: toEntries(cast) });
    const others = [...groups].filter(([key]) => key !== 'cast').sort((a, b) => b[1].size - a[1].size);
    for (const [key, names] of others) {
      tabsOut.push({ key, label: storedLabel(key.slice('role:'.length)), kind: 'creator', entries: toEntries(names) });
    }
    return tabsOut;
  }, [data, allTags, isAttributeTag]);

  const tab = tabs.find((x) => x.key === tabKey) ?? tabs[0];
  const active = tab?.kind === 'tag' ? activeTags : tab?.kind === 'maker' ? activeMakers : activeCreators;

  const shown = useMemo(() => {
    if (!tab) return [];
    const q = search.trim().toLowerCase();
    const rows = q ? tab.entries.filter((e) => e.label.toLowerCase().includes(q) || e.value.toLowerCase().includes(q)) : [...tab.entries];
    return rows.sort((a, b) => (sort === 'count' ? b.count - a.count : 0) || a.label.localeCompare(b.label, 'ja'));
  }, [tab, search, sort]);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={t('索引')}>
      <div className="modal__panel modal__panel--scroll modal__panel--index">
        <div className="modal__head">
          <h3>{t('索引')}</h3>
          <button className="detail__close" onClick={onClose} aria-label={t('閉じる')}>
            ×
          </button>
        </div>

        <div className="index__tabs" role="tablist">
          {tabs.map((x) => (
            <button
              key={x.key}
              role="tab"
              aria-selected={x.key === tab?.key}
              className={`index__tab ${x.key === tab?.key ? 'index__tab--on' : ''}`}
              onClick={() => setTabKey(x.key)}
            >
              {x.label}
              <span className="index__tabCount">{x.entries.length.toLocaleString()}</span>
            </button>
          ))}
        </div>

        <div className="index__controls">
          <input
            className="input input--sm index__search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={tab ? t('{0}を探す…', { 0: tab.label }) : ''}
            aria-label={t('名前で探す')}
          />
          <select className="select" value={category} onChange={(e) => setCategory(e.target.value as Category | '')} aria-label={t('区分')}>
            <option value="">{t('すべての区分')}</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(CATEGORY_LABELS[c])}
              </option>
            ))}
          </select>
          {tab?.kind === 'tag' && (
            <label className="toolbar__regex" title={t('旧作・セール・対応OS・評価など、作品の属性でないタグも出します')}>
              <input type="checkbox" checked={allTags} onChange={(e) => setAllTags(e.target.checked)} />
              {t('属性以外のタグも出す')}
            </label>
          )}
          <div className="segmented">
            <button className={sort === 'count' ? 'on' : ''} onClick={() => setSort('count')}>
              {t('作品数順')}
            </button>
            <button className={sort === 'name' ? 'on' : ''} onClick={() => setSort('name')}>
              {t('名前順')}
            </button>
          </div>
        </div>

        {error && <p role="alert">{error}</p>}
        <div className="modal__scroll">
          {!data && !error && <p className="muted">{t('読み込み中…')}</p>}
          {data && shown.length === 0 && <p className="muted">{t('見つかりません。')}</p>}
          <div className="index__grid">
            {shown.map((e) => (
              <button
                key={e.value}
                className={`index__item ${active.includes(e.value) ? 'index__item--active' : ''}`}
                title={t('「{tag}」で絞り込む', { tag: e.label })}
                onClick={() => tab && onPick(tab.kind, e.value)}
              >
                <span className="index__name">{e.label}</span>
                <span className="index__count">{e.count.toLocaleString()}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
