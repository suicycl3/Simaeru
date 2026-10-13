import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  /** ♡「使った」の切り替え */
  onToggleUsed: (product: Product) => void;
  /** プレイリストに入れる小窓を開く */
  onAddToPlaylist: (product: Product) => void;
  /** ★の切り替え */
  onToggleFavorite: (product: Product) => void;
  /** 選んでダウンロードするモード。カードを押すと選択を切り替える */
  selecting: boolean;
  checkedIds: Set<number>;
  /** index は一覧での位置（Shift で範囲選択するため） */
  onToggleCheck: (id: number, index: number, range: boolean) => void;
  /** カードにタグ・ブランド・出演者を出す（押すと一覧をそれで絞り込む） */
  showTags: boolean;
  /** カードに出すタグか（作品の属性だけ。旧作・セールなどは出さない） */
  isShownTag: (tag: string, product: Product) => boolean;
  /** グリッドのカードの大きさ（列の数が変わる） */
  cardSize: CardSize;
  activeTags: string[];
  onToggleTag: (tag: string) => void;
  activeMakers: string[];
  onToggleMaker: (maker: string) => void;
  activeCreators: string[];
  onToggleCreator: (name: string) => void;
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

export type CardSize = 'small' | 'medium' | 'large';

const PAD = 16;
const GAP = 14;
/** カードの最小の幅。この幅が入るだけ列を並べ、余りは各列で分ける */
const MIN_COL: Record<CardSize, number> = { small: 145, medium: 190, large: 270 };
const GRID_BODY_H = 92; // タイトル2行＋メタ＋日付＋余白
const GRID_BODY_H_TAGS_BASE = 54; // タグを出すグリッド: 余白＋タイトル2行（タグ・ブランド/出演者の段はチップの数で足す）
const LIST_ROW_H = 76;
const LIST_ROW_H_TAGS_MIN = 100; // タグを出すリスト: 表紙（90px）が収まる高さ

/** チップ（.cardtag）の寸法。CSS と合わせる */
const CHIP_H = 20; // 行の高さ16＋上下の余白1＋枠1
const CHIP_GAP = 4;
const CHIP_PAD = 18; // 左右の余白8＋枠1
/** チップの段の高さ（上の間 6px を含む）。0 段なら 0 */
const chipBlock = (lines: number, marginTop = 6): number => (lines > 0 ? marginTop + lines * CHIP_H + (lines - 1) * CHIP_GAP : 0);

/**
 * チップの幅を文字の幅から求める。カードの高さを先に決めて仮想化するので、描かずに段の数を知る必要がある。
 * 少し広めに見積もる（狭く見積もると最後のチップが切れる）。
 */
let measureCtx: CanvasRenderingContext2D | null | undefined;
const chipWidths = new Map<string, number>();
function chipWidth(label: string): number {
  let w = chipWidths.get(label);
  if (w === undefined) {
    if (measureCtx === undefined) {
      measureCtx = document.createElement('canvas').getContext('2d');
      if (measureCtx) measureCtx.font = `11px ${getComputedStyle(document.body).fontFamily}`;
    }
    w = Math.ceil(measureCtx ? measureCtx.measureText(label).width : label.length * 11) + CHIP_PAD + 2;
    chipWidths.set(label, w);
  }
  return w;
}

/** 幅 width に折り返して並べたときの段の数（flex-wrap と同じ詰め方） */
function chipLines(labels: string[], width: number): number {
  let lines = 0;
  let x = 0;
  for (const label of labels) {
    const w = Math.min(chipWidth(label), width); // 1 つで幅を超えるチップは省略記号で切れる
    if (lines === 0 || x + CHIP_GAP + w > width) {
      lines++;
      x = w;
    } else x += CHIP_GAP + w;
  }
  return lines;
}

/** 出演者として出す役割（声優・俳優） */
const CAST_ROLES = new Set(['声優', '出演', 'CV']);

/** カードに出す出演者。PCゲームは声優を出さない */
const castNames = (p: Product): string[] =>
  p.category === 'game' ? [] : [...new Set(p.creators.filter((c) => CAST_ROLES.has(c.role)).map((c) => c.name))];

/** 押すと絞り込むチップ。選ぶモード中はカードの選択を優先して、ただの文字にする */
function FilterChip({
  label,
  kind,
  active,
  interactive,
  onToggle
}: {
  label: string;
  kind: 'tag' | 'maker' | 'cast';
  active: boolean;
  interactive: boolean;
  onToggle: () => void;
}): JSX.Element {
  const className = `cardtag cardtag--${kind} ${active ? 'cardtag--active' : ''}`;
  if (!interactive) return <span className={className}>{label}</span>;
  return (
    <button
      className={className}
      title={active ? t('「{tag}」の絞り込みを外す', { tag: label }) : t('「{tag}」で絞り込む', { tag: label })}
      onClick={(e) => {
        e.stopPropagation(); // カード選択と二重に反応させない
        onToggle();
      }}
    >
      {label}
    </button>
  );
}
const OVERSCAN_ROWS = 3;

interface Layout {
  cols: number;
  colW: number;
  /** 行ごとの上端とカードの高さ（タグを出すときは、その行でいちばん多いカードに合わせる） */
  rowTops: number[];
  rowHeights: number[];
  /** タグを出すグリッドで、行ごとの本文の高さ（表紙の大きさをそろえるため本文で高さを吸う） */
  bodyHeights: number[] | null;
  totalHeight: number;
}

/** 行の位置を、上から積んで決める */
function stackRows(heights: number[], gap: number): { rowTops: number[]; totalHeight: number } {
  const rowTops: number[] = [];
  let y = 0;
  for (const h of heights) {
    rowTops.push(y);
    y += h + gap;
  }
  return { rowTops, totalHeight: Math.max(0, y - gap) };
}

/** scrollTop を含む行（rowTops は昇順） */
function rowAt(rowTops: number[], y: number): number {
  let lo = 0;
  let hi = rowTops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rowTops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
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
  onToggleUsed,
  onAddToPlaylist,
  selecting,
  checkedIds,
  onToggleCheck,
  showTags,
  isShownTag,
  cardSize,
  activeTags,
  onToggleTag,
  activeMakers,
  onToggleMaker,
  activeCreators,
  onToggleCreator
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
  /** カードに出すタグ（属性だけ。訳すと同じ名前になるものは 1 つ） */
  const shownTags = useCallback(
    (p: Product): string[] => {
      const seen = new Set<string>();
      return p.tags.filter((tag) => {
        if (!isShownTag(tag, p)) return false;
        const label = t(tag);
        if (seen.has(label)) return false;
        seen.add(label);
        return true;
      });
    },
    [isShownTag]
  );
  // タグを出すときは、どのタグも切らずに出すため、カードごとにチップの段の数を数えて行の高さを決める
  const layout = useMemo((): Layout => {
    if (view === 'list') {
      const colW = inner;
      // 本文の幅: カードの枠・表紙 120px・間 12px・本文の左右の余白
      const chipWidthMax = Math.max(40, Math.floor(colW - 2 - 120 - 12 - 20));
      const heights = items.map((p) =>
        showTags
          ? Math.max(LIST_ROW_H_TAGS_MIN, LIST_ROW_H + chipBlock(chipLines([...castNames(p), ...shownTags(p).map((tag) => t(tag))], chipWidthMax), 4))
          : LIST_ROW_H
      );
      return { cols: 1, colW, rowHeights: heights, bodyHeights: null, ...stackRows(heights, 2) };
    }
    const cols = Math.max(1, Math.floor((inner + GAP) / (MIN_COL[cardSize] + GAP)));
    const colW = cols > 0 ? (inner - GAP * (cols - 1)) / cols : inner;
    const thumbH = Math.round((colW * 3) / 4);
    const rowCount = Math.ceil(items.length / cols);
    if (!showTags) {
      const heights = new Array<number>(rowCount).fill(thumbH + GRID_BODY_H);
      return { cols, colW, rowHeights: heights, bodyHeights: null, ...stackRows(heights, GAP) };
    }
    const chipWidthMax = Math.max(40, Math.floor(colW - 2 - 20)); // カードの枠・本文の左右の余白
    const bodyHeights: number[] = [];
    for (let r = 0; r < rowCount; r++) {
      let body = GRID_BODY_H_TAGS_BASE;
      for (const p of items.slice(r * cols, (r + 1) * cols)) {
        const tagLines = chipLines(shownTags(p).map((tag) => t(tag)), chipWidthMax);
        const peopleLines = chipLines([...(p.maker ? [p.maker] : []), ...castNames(p)], chipWidthMax);
        body = Math.max(body, GRID_BODY_H_TAGS_BASE + chipBlock(tagLines) + chipBlock(peopleLines));
      }
      bodyHeights.push(body);
    }
    const heights = bodyHeights.map((b) => thumbH + b);
    return { cols, colW, rowHeights: heights, bodyHeights, ...stackRows(heights, GAP) };
  }, [items, view, showTags, inner, cardSize, shownTags]);

  const rowCount = layout.rowTops.length;
  const firstRow = rowCount === 0 ? 0 : Math.max(0, rowAt(layout.rowTops, scrollTop) - OVERSCAN_ROWS);
  const lastRow = rowCount === 0 ? -1 : Math.min(rowCount - 1, rowAt(layout.rowTops, scrollTop + size.height) + OVERSCAN_ROWS);
  const start = firstRow * layout.cols;
  const end = Math.min(items.length, (lastRow + 1) * layout.cols);

  // 末尾が見えてきたら追加読み込み。再入は onLoadMore 側でも防いでいる。
  useEffect(() => {
    if (!hasMore || loading) return;
    if (items.length === 0 || end >= items.length - layout.cols) onLoadMore();
  }, [hasMore, loading, end, items.length, layout.cols, onLoadMore]);

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
    <div className={`library library--${view} ${showTags ? 'library--tags' : ''}`} ref={scrollRef} onScroll={onScroll}>
      <div className="vport" style={{ height: layout.totalHeight }}>
        {visible.map((p, i) => {
          const index = start + i;
          const row = Math.floor(index / layout.cols);
          const col = index % layout.cols;
          // タグを出すとき: 出演者（緑）とタグ（灰）、グリッドではブランド（橙）も。押すとそれで絞り込む
          const castChips = showTags
            ? castNames(p).map((name) => (
                <FilterChip
                  key={`cast:${name}`}
                  label={name}
                  kind="cast"
                  active={activeCreators.includes(name)}
                  interactive={!selecting}
                  onToggle={() => onToggleCreator(name)}
                />
              ))
            : [];
          const tagChips = showTags
            ? shownTags(p).map((tag) => (
                <FilterChip
                  key={`tag:${tag}`}
                  label={t(tag)}
                  kind="tag"
                  active={activeTags.includes(tag)}
                  interactive={!selecting}
                  onToggle={() => onToggleTag(tag)}
                />
              ))
            : [];
          const gridTags = showTags && view === 'grid';
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
                top: layout.rowTops[row],
                left: col * (layout.colW + GAP),
                width: layout.colW,
                height: layout.rowHeights[row]
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
                <button
                  className={`used ${p.viewedAt ? 'used--on' : ''}`}
                  hidden={selecting}
                  title={p.viewedAt ? t('使った') : t('使ってない')}
                  aria-label={p.viewedAt ? t('使った') : t('使ってない')}
                  aria-pressed={!!p.viewedAt}
                  onClick={(e) => {
                    e.stopPropagation(); // カード選択と二重に反応させない
                    onToggleUsed(p);
                  }}
                >
                  {p.viewedAt ? '♥' : '♡'}
                </button>
                {/* プレイリストへ。押すと入れ先を選ぶ小窓が出る（その場で作れる） */}
                <button
                  className="toPlaylist"
                  hidden={selecting}
                  title={t('プレイリストに追加')}
                  aria-label={t('プレイリストに追加')}
                  onClick={(e) => {
                    e.stopPropagation(); // カード選択と二重に反応させない
                    onAddToPlaylist(p);
                  }}
                >
                  ＋
                </button>
                {/* 手元の状態は表紙の左下に重ねる（表紙の下に流すとタイトルに重なる） */}
                {(p.hasLocalFile || p.needsInstall) && (
                  <span className="card__badges">
                    {p.hasLocalFile && <span className="chip chip--have">{t('DL済み')}</span>}
                    {p.needsInstall && (
                      <span className="chip chip--install" title={t('ダウンロード済み・インストール（起動の紐付け）がまだです')}>
                        {t('未導入')}
                      </span>
                    )}
                  </span>
                )}
                {p.isUnavailable && <span className="chip chip--warn">{t('配信終了')}</span>}
                {(p.productType === 'set' || p.isCompilation) && (
                  <span className="chip chip--set" title={t('複数の作品を収録したセット・総集編です（詳細に収録作品が出ます）')}>
                    {p.category === 'game' || p.productType === 'set' ? t('セット') : t('総集編')}
                  </span>
                )}
                {p.parentProductId && <span className="chip chip--child">{t('セット収録')}</span>}
                {/* タグを出すグリッドでは、日付の行の代わりに表紙の右下へ購入日を出す */}
                {gridTags && p.purchasedAt && <span className="card__stamp">{p.purchasedAt.slice(0, 10)}</span>}
              </div>
              <div className="card__body" style={layout.bodyHeights ? { height: layout.bodyHeights[row] } : undefined}>
                <div className="card__title" title={p.title}>
                  {p.title}
                </div>
                {gridTags ? (
                  <>
                    <div className="card__tags">{tagChips}</div>
                    <div className="card__people">
                      {p.maker && (
                        <FilterChip
                          label={p.maker}
                          kind="maker"
                          active={activeMakers.includes(p.maker)}
                          interactive={!selecting}
                          onToggle={() => onToggleMaker(p.maker as string)}
                        />
                      )}
                      {castChips}
                    </div>
                  </>
                ) : (
                  <>
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
                    {/* タグを出すリストでは、出演者とタグを 1 段に並べる（ブランドはメタの行にある） */}
                    {showTags && (
                      <div className="card__tags card__tags--line">
                        {castChips}
                        {tagChips}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {loading && <div className="loading">{t('読み込み中…')}</div>}
    </div>
  );
}
