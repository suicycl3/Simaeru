import { useEffect, useMemo, useRef, useState } from 'react';
import type { ContentEntry, Product } from '@shared/types';
import { dirName, extOf, PLAYABLE_VIDEO } from '@shared/contentRules';
import PdfView from './PdfView';
import ViewerPrefsFields from './ViewerPrefsFields';
import { SHARPEN_LEVELS, useViewerPrefs, type ViewerPrefs } from '../../lib/viewerPrefs';
import { t } from '@shared/i18n';
import { activeCueText } from '../../lib/format';
import { matchesMedia, useSubtitleCues } from '../../lib/useSubtitles';
import { IN_POPUP } from '../../lib/popup';

/** 同じ内容を別ウィンドウで開き、ここ（本体の中のビューア）は閉じる */
function popout(kind: 'images' | 'pdf' | 'video', product: Product, entryUrl: string | undefined, onClose: () => void): void {
  void window.api.viewer
    .popup({ kind, productId: product.id, entryUrl: entryUrl ?? null, title: product.title })
    .then(() => onClose());
}

export type ViewerMode = 'images' | 'pdf' | 'video';

interface Props {
  product: Product;
  mode: ViewerMode;
  entries: ContentEntry[];
  startIndex?: number;
  /** 動画に重ねる字幕の候補（作品の中の字幕ファイル） */
  subtitles?: ContentEntry[];
  onClose: () => void;
}

/**
 * 内蔵の簡易ビューア（DESIGN-download.md §6-4）。
 * 漫画・CG集をじっくり読むのは NeeView に任せ、ここは「とりあえず中を確認する」ための
 * ページ送り・見開き・綴じ方向・サムネイル一覧まで。
 */
export default function MediaViewer({ product, mode, entries, startIndex = 0, subtitles, onClose }: Props): JSX.Element {
  if (mode === 'pdf') return <PdfViewer product={product} entries={entries} startIndex={startIndex} onClose={onClose} />;
  if (mode === 'video') return <VideoViewer product={product} entries={entries} startIndex={startIndex} subtitles={subtitles} onClose={onClose} />;
  return <ImageViewer product={product} entries={entries} startIndex={startIndex} onClose={onClose} />;
}

function Shell({
  title,
  children,
  toolbar,
  onClose,
  onPopout
}: {
  title: string;
  children: React.ReactNode;
  toolbar?: React.ReactNode;
  onClose: () => void;
  /** 別ウィンドウで開く（ポップアップの中では出さない） */
  onPopout?: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  // 開いたらビューアにフォーカスを移す。詳細パネルの「画像を見る」ボタンにフォーカスが残っていると、
  // Space でそのボタンがもう一度押されてしまい、矢印キーもそちらに取られる
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="viewer" role="dialog" aria-modal="true" tabIndex={-1} ref={ref}>
      <header className="viewer__head">
        <div className="viewer__title" title={title}>
          {title}
        </div>
        <div className="viewer__tools">{toolbar}</div>
        {onPopout && !IN_POPUP && (
          <button className="btn btn--xs btn--ghost viewer__popout" onClick={onPopout} title={t('別ウィンドウで開く')} aria-label={t('別ウィンドウで開く')}>
            ⧉
          </button>
        )}
        <button className="detail__close viewer__close" onClick={onClose} aria-label={t('閉じる')}>
          ×
        </button>
      </header>
      {children}
    </div>
  );
}

// ── 画像 ─────────────────────────────────────────────────

/** ページをめくるキー（押し続けたときに間隔を空ける対象） */
const PAGE_KEYS = new Set(['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', ' ', 'PageDown', 'PageUp', 'Enter', 'Backspace']);

/** 表示の合わせ方。original: 原寸（画像の1ピクセルを画面の1ピクセルに） */
type Fit = 'contain' | 'width' | 'original';
const FIT_LABELS: Record<Fit, string> = { contain: t('全体'), width: t('幅合わせ'), original: t('原寸') };
const NEXT_FIT: Record<Fit, Fit> = { contain: 'width', width: 'original', original: 'contain' };
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.25;

/** シャープ化のフィルタ（SVG）。表示する大きさにしてから効くので、縮小表示でぼやけた細い線に効く */
function SharpenFilters(): JSX.Element {
  return (
    <svg className="sharpenDefs" width="0" height="0" aria-hidden="true">
      <defs>
        {SHARPEN_LEVELS.map((k, level) =>
          level === 0 ? null : (
            <filter key={level} id={`viewer-sharpen-${level}`} colorInterpolationFilters="sRGB">
              <feConvolveMatrix
                order="3"
                kernelMatrix={`0 ${-k} 0 ${-k} ${1 + 4 * k} ${-k} 0 ${-k} 0`}
                preserveAlpha="true"
                edgeMode="duplicate"
              />
            </filter>
          )
        )}
      </defs>
    </svg>
  );
}

function ImageViewer({ product, entries, startIndex, onClose }: Omit<Props, 'mode'>): JSX.Element {
  // フォルダ（差分・サイズ違いなど）で分ける
  const folders = useMemo(() => {
    const map = new Map<string, ContentEntry[]>();
    for (const e of entries) {
      const key = `${e.container}\u0000${dirName(e.relPath)}`;
      map.set(key, [...(map.get(key) ?? []), e]);
    }
    return [...map.entries()].map(([key, list]) => ({ key, label: key.split('\u0000')[1] || t('（ルート）'), list }));
  }, [entries]);

  const startFolder = Math.max(0, folders.findIndex((f) => f.list.includes(entries[startIndex ?? 0])));
  const [folderIdx, setFolderIdx] = useState(startFolder);
  const list = folders[folderIdx]?.list ?? [];
  const [page, setPage] = useState(() => Math.max(0, list.indexOf(entries[startIndex ?? 0])));
  const [spread, setSpread] = useState(() => localStorage.getItem('viewer.spread') === '1');
  // 漫画は右綴じが既定
  const [rtl, setRtl] = useState(() => {
    const saved = localStorage.getItem(`viewer.rtl.${product.workType ?? 'other'}`);
    return saved === null ? product.workType === 'manga' : saved === '1';
  });
  const [thumbs, setThumbs] = useState(false);
  const [fit, setFit] = useState<Fit>('contain');
  /** 合わせ方に対する倍率（1 = そのまま） */
  const [zoom, setZoom] = useState(1);
  const zoomBy = (factor: number): void => setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * factor * 100) / 100)));
  const [prefs] = useViewerPrefs();
  const [prefsOpen, setPrefsOpen] = useState(false);
  const prefsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!prefsOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (prefsRef.current && !prefsRef.current.contains(e.target as Node)) setPrefsOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [prefsOpen]);

  useEffect(() => localStorage.setItem('viewer.spread', spread ? '1' : '0'), [spread]);
  useEffect(() => localStorage.setItem(`viewer.rtl.${product.workType ?? 'other'}`, rtl ? '1' : '0'), [rtl, product.workType]);

  // 続きから（同じフォルダ構成のときだけ）
  useEffect(() => {
    if ((startIndex ?? 0) > 0) return;
    void window.api.content.getState(product.id).then((s) => {
      if (s?.imageIndex && s.imageIndex < list.length) setPage(s.imageIndex);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id, folderIdx]);

  useEffect(() => {
    const tItem = setTimeout(() => void window.api.content.setState(product.id, { imageIndex: page, updatedAt: Date.now() }), 800);
    return () => clearTimeout(tItem);
  }, [page, product.id]);

  const step = spread ? 2 : 1;
  /** 最後にページをめくった時刻。回し続け・押し続けのときに、設定の間隔より速くめくらない */
  const turnedAt = useRef(0);
  const go = (delta: number): void => {
    turnedAt.current = Date.now();
    setPage((p) => Math.max(0, Math.min(list.length - 1, p + delta)));
  };
  const forward = (): void => go(step);
  const back = (): void => go(-step);
  const tooSoon = (): boolean => Date.now() - turnedAt.current < prefs.pageInterval;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLElement && e.target.closest('input,select,textarea')) return;
      if (prefsOpen) {
        if (e.key === 'Escape') {
          setPrefsOpen(false);
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (thumbs && e.key !== 'Escape' && e.key.toLowerCase() !== 't') return;
      // 押し続けているときは、設定の間隔より速くめくらない
      if (e.repeat && PAGE_KEYS.has(e.key) && tooSoon()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      let handled = true;
      if (e.key === 'Escape') {
        if (thumbs) setThumbs(false);
        else onClose();
      } else if (e.key === 'ArrowRight') (rtl ? back : forward)();
      else if (e.key === 'ArrowLeft') (rtl ? forward : back)();
      else if (e.key === 'ArrowDown' || e.key === ' ' || e.key === 'PageDown' || e.key === 'Enter') {
        // 縦にはみ出しているとき（幅合わせ・拡大）は、下キーはまずスクロールに使う
        if (e.key === 'ArrowDown' && !atEdge(1)) handled = false;
        else forward();
      } else if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Backspace') {
        if (e.key === 'ArrowUp' && !atEdge(-1)) handled = false;
        else back();
      } else if (e.key === '+' || e.key === '=' || e.key === ';') zoomBy(ZOOM_STEP);
      else if (e.key === '-') zoomBy(1 / ZOOM_STEP);
      else if (e.key === '0') setZoom(1);
      else if (e.key.toLowerCase() === 'f') setFit((f) => NEXT_FIT[f]);
      else if (e.key === 'Home') setPage(0);
      else if (e.key === 'End') setPage(list.length - 1);
      else if (e.key.toLowerCase() === 't') setThumbs((v) => !v);
      else if (e.key.toLowerCase() === 's') setSpread((v) => !v);
      else handled = false;
      if (handled) {
        // 後ろにある一覧や詳細パネルのスクロール・ボタンに渡さない
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // ホイールでページ送り（下＝次へ）。トラックパッドの細かいイベントで何ページも飛ばないよう間引く
  const stageRef = useRef<HTMLDivElement>(null);
  const wheelAt = useRef(0);
  const wheelSum = useRef(0);
  /** 縦にスクロールできるとき、端まで来ているか（dir: 1=下, -1=上）。スクロールできなければ端とみなす */
  const atEdge = (dir: 1 | -1): boolean => {
    const el = stageRef.current;
    if (!el || el.scrollHeight <= el.clientHeight + 2) return true;
    return dir > 0 ? el.scrollTop + el.clientHeight >= el.scrollHeight - 2 : el.scrollTop <= 2;
  };
  // ページを変えたら先頭から見せる（右綴じは右端から）
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    el.scrollTop = 0;
    el.scrollLeft = rtl ? el.scrollWidth : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // 拡大・原寸で大きさを決めるのに、表示できる広さを見ておく
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [thumbs]);

  // Ctrl+ホイールで拡大・縮小。React のホイールは受け身（preventDefault できない）なので、自前で付ける
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onCtrlWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    };
    el.addEventListener('wheel', onCtrlWheel, { passive: false });
    return () => el.removeEventListener('wheel', onCtrlWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thumbs]);

  // 拡大して はみ出しているときは、ドラッグで動かす（動かしたときはクリックのページ送りをしない）
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);

  const onWheel = (e: React.WheelEvent): void => {
    if (e.ctrlKey) return;
    const dir = e.deltaY > 0 ? 1 : -1;
    const scrolling = !!stageRef.current && stageRef.current.scrollHeight > stageRef.current.clientHeight + 2;
    if (scrolling && !atEdge(dir)) return; // まずは縦にスクロールさせる
    const now = Date.now();
    if (now - wheelAt.current > Math.max(400, prefs.pageInterval + 200)) wheelSum.current = 0;
    wheelAt.current = now;
    wheelSum.current += e.deltaY;
    if (Math.abs(wheelSum.current) < 60 || tooSoon()) return;
    wheelSum.current = 0;
    // 反転は、ページ単位でめくっているときだけ。縦にスクロールしているときは、スクロールの向きに従う
    const pageDir = !scrolling && prefs.wheelInvert ? -dir : dir;
    if (pageDir > 0) forward();
    else back();
  };

  // 前後のページを先読みしておく
  useEffect(() => {
    for (const i of [page + step, page + step + 1, page - step]) {
      const e = list[i];
      if (e) new Image().src = e.url;
    }
  }, [page, list, step]);

  /** 大きさを自前で決める表示か（原寸・拡大縮小）。全体・幅合わせの等倍は CSS に任せる */
  const sized = fit === 'original' || zoom !== 1;
  const shown = spread ? list.slice(page, page + 2) : list.slice(page, page + 1);
  const ordered = rtl ? [...shown].reverse() : shown;

  const toolbar = (
    <>
      {folders.length > 1 && (
        <select
          className="select select--xs"
          value={folderIdx}
          onChange={(e) => {
            setFolderIdx(Number(e.target.value));
            setPage(0);
          }}
        >
          {folders.map((f, i) => (
            <option key={f.key} value={i}>
              {t('{label}（{length}）', { label: f.label, length: f.list.length })}
            </option>
          ))}
        </select>
      )}
      <span className="muted">
        {list.length ? `${page + 1}${shown.length > 1 ? `-${page + shown.length}` : ''} / ${list.length}` : '0'}
      </span>
      <button className={`btn btn--xs ${spread ? 'btn--on' : ''}`} onClick={() => setSpread((v) => !v)} title={t('見開き (S)')}>
        {t('見開き')}
      </button>
      <button className={`btn btn--xs ${rtl ? 'btn--on' : ''}`} onClick={() => setRtl((v) => !v)} title={t('綴じ方向')}>
        {rtl ? t('右綴じ') : t('左綴じ')}
      </button>
      <button className="btn btn--xs" onClick={() => setFit((f) => NEXT_FIT[f])} title={t('合わせ方 (F)：全体 → 幅合わせ → 原寸')}>
        {FIT_LABELS[fit]}
      </button>
      <span className="zoomCtl">
        <button className="btn btn--xs" onClick={() => zoomBy(1 / ZOOM_STEP)} title={t('縮小 (-)')} aria-label={t('縮小')}>
          −
        </button>
        <button className="btn btn--xs zoomCtl__value" onClick={() => setZoom(1)} title={t('倍率を戻す (0)。Ctrl+ホイールでも拡大・縮小できます')}>
          {Math.round(zoom * 100)}%
        </button>
        <button className="btn btn--xs" onClick={() => zoomBy(ZOOM_STEP)} title={t('拡大 (+)')} aria-label={t('拡大')}>
          ＋
        </button>
      </span>
      <button className={`btn btn--xs ${thumbs ? 'btn--on' : ''}`} onClick={() => setThumbs((v) => !v)} title={t('一覧 (T)')}>
        {t('一覧')}
      </button>
      <div className="popoverWrap" ref={prefsRef}>
        <button
          className={`btn btn--xs ${prefsOpen ? 'btn--on' : ''}`}
          onClick={() => setPrefsOpen((v) => !v)}
          title={t('表示とページ送りの設定')}
          aria-expanded={prefsOpen}
        >
          ⚙
        </button>
        {prefsOpen && (
          <div className="menu viewerPrefs settings">
            <ViewerPrefsFields />
          </div>
        )}
      </div>
    </>
  );

  return (
    <Shell
      title={t('{title} ・ {1}', { title: product.title, 1: list[page]?.name ?? '' })}
      toolbar={toolbar}
      onClose={onClose}
      onPopout={() => popout('images', product, list[page]?.url, onClose)}
    >
      {thumbs ? (
        <div className="thumbs">
          {list.map((e, i) => (
            <button
              key={e.url}
              className={`thumb ${i === page ? 'thumb--current' : ''}`}
              onClick={() => {
                setPage(i);
                setThumbs(false);
              }}
              title={e.relPath}
            >
              <img src={e.url} alt={e.name} loading="lazy" />
              <span>{i + 1}</span>
            </button>
          ))}
        </div>
      ) : (
        <div
          ref={stageRef}
          className={`stage stage--${sized ? 'sized' : fit}`}
          onWheel={onWheel}
          onPointerDown={(ev) => {
            const el = stageRef.current;
            if (!el || ev.button !== 0) return;
            drag.current = { x: ev.clientX, y: ev.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false };
          }}
          onPointerMove={(ev) => {
            const d = drag.current;
            const el = stageRef.current;
            if (!d || !el || (ev.buttons & 1) === 0) return;
            const dx = ev.clientX - d.x;
            const dy = ev.clientY - d.y;
            if (!d.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
            if (el.scrollWidth <= el.clientWidth + 2 && el.scrollHeight <= el.clientHeight + 2) return;
            d.moved = true;
            el.scrollLeft = d.left - dx;
            el.scrollTop = d.top - dy;
          }}
          onClick={(ev) => {
            const moved = drag.current?.moved;
            drag.current = null;
            if (moved) return;
            // 画面の左右をクリックしてページ送り（綴じ方向に合わせる）
            const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
            const left = ev.clientX - rect.left < rect.width / 2;
            if (left === rtl) forward();
            else back();
          }}
        >
          <SharpenFilters />
          {ordered.map((e) => (
            <StageImage
              key={e.url}
              url={e.url}
              name={e.name}
              half={spread}
              sizing={{ fit, zoom, w: stageSize.w, h: stageSize.h, sized }}
              prefs={prefs}
            />
          ))}
          {list.length === 0 && <p className="muted">{t('画像がありません。')}</p>}
        </div>
      )}
    </Shell>
  );
}

/**
 * 1ページぶんの画像。読み込みに失敗したら少し待って読み直す（最大3回）。
 * 開いた直後の1枚目は、アーカイブを初めて開く処理（Windows の検査・目次の読み込み）と重なって失敗したり遅れたりすることがあり、
 * そのまま何も出ない状態になっていた。読み込み中・失敗は分かるように出す。
 */
function StageImage({
  url,
  name,
  half,
  sizing,
  prefs
}: {
  url: string;
  name: string;
  half: boolean;
  /** 合わせ方・倍率と表示できる広さ。sized: 大きさを自前で決める（原寸・拡大縮小） */
  sizing: { fit: Fit; zoom: number; w: number; h: number; sized: boolean };
  prefs: ViewerPrefs;
}): JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<'loading' | 'slow' | 'ok' | 'error'>('loading');
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const style: React.CSSProperties = {
    filter: prefs.sharpen > 0 ? `url(#viewer-sharpen-${prefs.sharpen})` : undefined
  };
  if (natural && sizing.w > 0 && sizing.h > 0) {
    const dpr = window.devicePixelRatio || 1;
    const boxW = half ? sizing.w / 2 : sizing.w;
    const fitScale = Math.min(boxW / natural.w, sizing.h / natural.h);
    const base =
      sizing.fit === 'contain'
        ? // 等倍の「全体」は小さい画像を引き伸ばさない（CSS の max-width と同じ）
          sizing.sized
          ? fitScale
          : Math.min(1, fitScale)
        : sizing.fit === 'width'
          ? boxW / natural.w
          : 1 / dpr;
    const scale = base * (sizing.sized ? sizing.zoom : 1);
    if (sizing.sized) {
      style.width = Math.max(1, Math.round(natural.w * scale));
      style.height = Math.max(1, Math.round(natural.h * scale));
    }
    // ドットの補間は拡大して表示しているときだけ（縮小に使うとギザギザになる）
    if (prefs.smoothing === 'pixelated' && scale * dpr > 1.01) style.imageRendering = 'pixelated';
  }
  useEffect(() => {
    if (state !== 'loading') return;
    const timer = setTimeout(() => setState((s) => (s === 'loading' ? 'slow' : s)), 1500);
    return () => clearTimeout(timer);
  }, [state, attempt]);
  // 読み直しのたびに URL を変える（同じ URL だと、失敗した結果を使い回されることがある）
  const src = attempt === 0 ? url : `${url}?retry=${attempt}`;
  return (
    <>
      <img
        className={`stage__img ${half ? 'stage__img--half' : ''} ${state === 'ok' ? '' : 'stage__img--pending'}`}
        src={src}
        alt={name}
        style={style}
        draggable={false}
        onLoad={(ev) => {
          setNatural({ w: ev.currentTarget.naturalWidth, h: ev.currentTarget.naturalHeight });
          setState('ok');
        }}
        onError={() => {
          if (attempt < 3) {
            setTimeout(() => {
              setAttempt((a) => a + 1);
              setState('loading');
            }, 400 * (attempt + 1));
          } else {
            setState('error');
          }
        }}
      />
      {state === 'slow' && <span className="stage__status muted">{t('読み込み中…（初めて開くファイルは Windows の検査で時間がかかることがあります）')}</span>}
      {state === 'error' && (
        <span className="stage__status">
          {t('この画像を読み込めませんでした。')}
          <button
            className="btn btn--xs"
            onClick={(ev) => {
              ev.stopPropagation();
              setAttempt((a) => a + 1);
              setState('loading');
            }}
          >
            {t('もう一度読み込む')}
          </button>
        </span>
      )}
    </>
  );
}

// ── PDF ──────────────────────────────────────────────────

function PdfViewer({ product, entries, startIndex, onClose }: Omit<Props, 'mode'>): JSX.Element {
  const [idx, setIdx] = useState(startIndex ?? 0);
  const entry = entries[idx];
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <Shell
      title={t('{title} ・ {1}', { title: product.title, 1: entry?.name ?? '' })}
      onClose={onClose}
      onPopout={() => popout('pdf', product, entry?.url, onClose)}
      toolbar={
        entries.length > 1 && (
          <select className="select select--xs" value={idx} onChange={(e) => setIdx(Number(e.target.value))}>
            {entries.map((e, i) => (
              <option key={e.url} value={i}>
                {e.relPath}
              </option>
            ))}
          </select>
        )
      }
    >
      <div className="viewer__scroll">{entry && <PdfView url={entry.url} inArchive={entry.inArchive} keyboard />}</div>
    </Shell>
  );
}

// ── 動画 ─────────────────────────────────────────────────

function VideoViewer({ product, entries, startIndex, subtitles = [], onClose }: Omit<Props, 'mode'>): JSX.Element {
  const [idx, setIdx] = useState(startIndex ?? 0);
  const entry = entries[idx];
  const ref = useRef<HTMLVideoElement>(null);

  // ── 字幕。同じ名前の字幕があれば自動で重ね、ほかの字幕にも切り替えられる ──
  const matching = useMemo(
    () => (entry ? subtitles.filter((s) => matchesMedia(entry.name, s.name)) : []),
    [entry, subtitles]
  );
  /** 選んだ字幕（URL）。'' は字幕なし、null はまだ選んでいない（同じ名前のものを使う） */
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => setChosen(null), [entry?.url]);
  const subtitle = chosen === '' ? null : subtitles.find((s) => s.url === chosen) ?? matching[0] ?? null;
  const cues = useSubtitleCues(subtitle);
  const [time, setTime] = useState(0);
  // timeupdate は 1 秒に数回しか来ないので、再生中は描画のたびに位置を読む（字幕の出だしがずれないように）
  useEffect(() => {
    if (!subtitle) return;
    let frame = 0;
    const tick = (): void => {
      const v = ref.current;
      if (v) setTime(v.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [subtitle]);
  const caption = cues ? activeCueText(cues, time) : '';

  // 字幕は動画の下の方に重ねる。動画が枠より小さい（上下や左右が余る）と、枠の下に置くと動画の外に出るので、
  // 動画の実際の位置を測って、操作バーの少し上に来るようにする
  const [captionBottom, setCaptionBottom] = useState(64);
  useEffect(() => {
    const v = ref.current;
    const stage = v?.parentElement;
    if (!v || !stage) return;
    const measure = (): void => {
      const vr = v.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      // 52px は再生の操作バーの高さぶん
      setCaptionBottom(Math.max(8, sr.bottom - vr.bottom + 52));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(v);
    ro.observe(stage);
    v.addEventListener('loadedmetadata', measure);
    measure();
    return () => {
      ro.disconnect();
      v.removeEventListener('loadedmetadata', measure);
    };
  }, [entry?.url]);
  // アーカイブの中の動画も再生できる（無圧縮ならそのまま、圧縮されていれば初回だけ一時フォルダへ書き出す）
  const playable = entry ? PLAYABLE_VIDEO.includes(extOf(entry.name)) : false;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <Shell
      title={t('{title} ・ {1}', { title: product.title, 1: entry?.name ?? '' })}
      onClose={onClose}
      onPopout={() => popout('video', product, entry?.url, onClose)}
      toolbar={
        <>
          {entries.length > 1 && (
            <select className="select select--xs" value={idx} onChange={(e) => setIdx(Number(e.target.value))}>
              {entries.map((e, i) => (
                <option key={e.url} value={i}>
                  {e.relPath}
                </option>
              ))}
            </select>
          )}
          {subtitles.length > 0 && (
            <select
              className="select select--xs"
              value={chosen === '' ? '' : subtitle?.url ?? ''}
              onChange={(e) => setChosen(e.target.value)}
              title={t('字幕')}
              aria-label={t('字幕')}
            >
              <option value="">{t('字幕なし')}</option>
              {/* この動画と同じ名前のものを先に */}
              {[...matching, ...subtitles.filter((s) => !matching.includes(s))].map((s) => (
                <option key={s.url} value={s.url}>
                  {s.relPath}
                </option>
              ))}
            </select>
          )}
        </>
      }
    >
      <div className="stage">
        {playable ? (
          <>
            <video ref={ref} className="stage__video" src={entry.url} controls autoPlay onEnded={() => idx + 1 < entries.length && setIdx(idx + 1)} />
            {caption && (
              <div className="stage__caption" style={{ bottom: captionBottom }} aria-live="polite">
                {caption}
              </div>
            )}
          </>
        ) : (
          <div className="viewer__fallback">
            <p className="muted">
              {entry?.inArchive
                ? t('この形式はアプリ内で再生できません（アーカイブの中にあるため、既定のアプリでも直接は開けません）。')
                : t('この形式はアプリ内で再生できません。')}
            </p>
            {entry && !entry.inArchive && (
              <button className="btn" onClick={() => void window.api.openPath(`${entry.container}\\${entry.relPath.replace(/\//g, '\\')}`)}>
                {t('既定のアプリで開く')}
              </button>
            )}
          </div>
        )}
      </div>
    </Shell>
  );
}
