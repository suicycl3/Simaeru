import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CATEGORY_LABELS, type Product } from '@shared/types';
import { t } from '@shared/i18n';

interface Props {
  items: Product[];
  view: 'grid' | 'list';
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  selectedId: number | null;
  onSelect: (id: number) => void;
  /** ★の切り替え */
  onToggleFavorite: (product: Product) => void;
  /** 選んでダウンロードするモード。カードを押すと選択を切り替える */
  selecting: boolean;
  checkedIds: Set<number>;
  /** index は一覧での位置（Shift で範囲選択するため） */
  onToggleCheck: (id: number, index: number, range: boolean) => void;
}

export function coverSrc(product: Product): string | undefined {
  // cover_file は「取得を試みたが失敗」を空文字で表すので、その場合は元URLに落とす
  if (product.coverPath) return `libcover://${product.coverPath}`;
  return product.coverUrl ?? undefined;
}

/**
 * 表紙。ローカルキャッシュ（libcover://）が読めなかったときは元のURLに落とす。
 * キャッシュ待ち・キャッシュ失敗・ファイル欠けのどれでも、出せる絵があれば出す。
 *
 * loading="lazy" は付けない。一覧は自前で仮想化していて画面内の行しかDOMに無く、
 * さらに起動直後はスクロール領域の寸法が確定する前に描画されるため、
 * lazy だと「画面外」と判定された画像が読み込まれないまま白く残ることがある。
 */
export function Cover({ product, className }: { product: Product; className?: string }): JSX.Element {
  const primary = coverSrc(product);
  const [src, setSrc] = useState(primary);

  // 選択が変わって同じ img が使い回されたときのために、元に戻す
  useEffect(() => setSrc(primary), [primary]);

  if (!src) return <div className="card__thumb-empty">NO IMAGE</div>;
  return (
    <img
      className={className}
      src={src}
      alt=""
      decoding="async"
      onError={() => {
        if (product.coverUrl && src !== product.coverUrl) setSrc(product.coverUrl);
      }}
    />
  );
}

/** カード右下に出す購入サイト名 */
const SITE_LABELS: Record<string, string> = {
  dmm: 'DMM',
  dlsite: 'DLsite'
};

const PAD = 16;
const GAP = 14;
const MIN_COL = 190;
const GRID_BODY_H = 92; // タイトル2行＋メタ＋日付＋余白
const LIST_ROW_H = 76;
const OVERSCAN_ROWS = 3;

interface Metrics {
  cols: number;
  colW: number;
  /** 行の送り幅（カード高さ＋行間） */
  rowH: number;
  cardH: number;
}

/**
 * 蔵書は数千件になるため、全件をDOMに積むとレンダラが詰まって
 * サムネイルも表示されなくなる。見えている行＋前後数行だけを描画する。
 */
export default function LibraryGrid({
  items,
  view,
  loading,
  hasMore,
  onLoadMore,
  selectedId,
  onSelect,
  onToggleFavorite,
  selecting,
  checkedIds,
  onToggleCheck
}: Props): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const measure = (): void =>
      setSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback((): void => {
    const node = scrollRef.current;
    if (node) setScrollTop(node.scrollTop);
  }, []);

  const inner = Math.max(0, size.width - PAD * 2);
  let metrics: Metrics;
  if (view === 'list') {
    metrics = { cols: 1, colW: inner, rowH: LIST_ROW_H + 2, cardH: LIST_ROW_H };
  } else {
    const cols = Math.max(1, Math.floor((inner + GAP) / (MIN_COL + GAP)));
    const colW = cols > 0 ? (inner - GAP * (cols - 1)) / cols : inner;
    const cardH = Math.round((colW * 3) / 4) + GRID_BODY_H;
    metrics = { cols, colW, rowH: cardH + GAP, cardH };
  }

  const rowCount = Math.ceil(items.length / metrics.cols);
  const totalHeight = Math.max(0, rowCount * metrics.rowH - (metrics.rowH - metrics.cardH));

  const firstRow = Math.max(0, Math.floor(scrollTop / metrics.rowH) - OVERSCAN_ROWS);
  const lastRow = Math.min(
    rowCount - 1,
    Math.ceil((scrollTop + size.height) / metrics.rowH) + OVERSCAN_ROWS
  );
  const start = firstRow * metrics.cols;
  const end = Math.min(items.length, (lastRow + 1) * metrics.cols);

  // 末尾が見えてきたら追加読み込み。再入は onLoadMore 側でも防いでいる。
  useEffect(() => {
    if (!hasMore || loading) return;
    if (items.length === 0 || end >= items.length - metrics.cols) onLoadMore();
  }, [hasMore, loading, end, items.length, metrics.cols, onLoadMore]);

  if (items.length === 0 && !loading) {
    return (
      <div className="library" ref={scrollRef}>
        <div className="empty">
          <p>{t('表示できる作品がありません。')}</p>
          <p className="muted">
            {t('「購入履歴を同期」を実行すると、ログイン済みのサイトから購入履歴を取り込みます。')}
          </p>
        </div>
      </div>
    );
  }

  const visible = items.slice(start, end);

  return (
    <div className={`library library--${view}`} ref={scrollRef} onScroll={onScroll}>
      <div className="vport" style={{ height: totalHeight }}>
        {visible.map((p, i) => {
          const index = start + i;
          const row = Math.floor(index / metrics.cols);
          const col = index % metrics.cols;
          return (
            /* ★ボタンを中に置くので、カード自体は button ではなく div にする
               （button の入れ子は不正なHTMLになるため）。キーボード操作は自前で拾う。 */
            <div
              key={p.id}
              role="button"
              tabIndex={0}
              className={`card ${selectedId === p.id ? 'card--selected' : ''} ${checkedIds.has(p.id) ? 'card--checked' : ''}`}
              aria-pressed={selecting ? checkedIds.has(p.id) : undefined}
              style={{
                position: 'absolute',
                top: row * metrics.rowH,
                left: col * (metrics.colW + GAP),
                width: metrics.colW,
                height: metrics.cardH
              }}
              onClick={(e) => {
                // 選ぶモード中、または Ctrl+クリックは選択の切り替え（Shift で範囲）
                if (selecting || e.ctrlKey || e.metaKey) onToggleCheck(p.id, index, e.shiftKey);
                else onSelect(p.id);
              }}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (selecting) onToggleCheck(p.id, index, e.shiftKey);
                  else onSelect(p.id);
                }
              }}
            >
              <div className="card__thumb">
                <Cover product={p} />
                {selecting && (
                  <span className={`card__check ${checkedIds.has(p.id) ? 'card__check--on' : ''}`} aria-hidden>
                    {checkedIds.has(p.id) ? '✓' : ''}
                  </span>
                )}
                <button
                  className={`fav ${p.favoriteAt ? 'fav--on' : ''}`}
                  hidden={selecting}
                  title={p.favoriteAt ? t('お気に入りから外す') : t('お気に入りに入れる')}
                  aria-label={p.favoriteAt ? t('お気に入りから外す') : t('お気に入りに入れる')}
                  onClick={(e) => {
                    e.stopPropagation(); // カード選択と二重に反応させない
                    onToggleFavorite(p);
                  }}
                >
                  {p.favoriteAt ? '★' : '☆'}
                </button>
                {p.hasLocalFile && <span className="chip chip--have">{t('DL済み')}</span>}
                {p.needsInstall && (
                  <span className="chip chip--install" title={t('ダウンロード済み・インストール（起動の紐付け）がまだです')}>
                    {t('未導入')}
                  </span>
                )}
                {p.isUnavailable && <span className="chip chip--warn">{t('配信終了')}</span>}
                {(p.productType === 'set' || p.isCompilation) && (
                  <span className="chip chip--set" title={t('複数の作品を収録したセット・総集編です（詳細に収録作品が出ます）')}>
                    {p.category === 'game' || p.productType === 'set' ? t('セット') : t('総集編')}
                  </span>
                )}
                {p.parentProductId && <span className="chip chip--child">{t('セット収録')}</span>}
              </div>
              <div className="card__body">
                <div className="card__title" title={p.title}>
                  {p.title}
                </div>
                <div className="card__meta">
                  <span>{p.maker ?? '—'}</span>
                  {/* 区分（作品の種類）と、どのサイトで買ったかを両方出す */}
                  <span className="card__floor">
                    {CATEGORY_LABELS[p.category] ? t(CATEGORY_LABELS[p.category]) : p.category}
                    <span className="card__site">{SITE_LABELS[p.siteId] ?? p.siteId}</span>
                  </span>
                </div>
                <div className="card__date">
                  {p.purchasedAt ?? ''}
                  {p.releasedAt && (
                    <span className="card__released">{t('発売 {0}', { 0: p.releasedAt.slice(0, 10) })}</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {loading && <div className="loading">{t('読み込み中…')}</div>}
    </div>
  );
}
