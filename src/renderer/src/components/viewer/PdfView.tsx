import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { t } from '@shared/i18n';
import { useViewerPrefs } from '../../lib/viewerPrefs';
import { rowIndexOf, spreadRows } from '../../lib/pdfSpread';

// pdf.js（Apache-2.0）。重い描画はワーカーに任せる
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * 日本語の PDF で、フォントを埋め込まずに定義済みの CMap（UniJIS-UCS2-H など）を使っているものは、
 * pdf.js の CMap が無いと文字を正しく読めない。標準の 14 フォント（Symbol など）も同じ。
 * どちらも pdfjs-dist に入っているので、ビルドに同梱して名前から引く。
 */
const CMAP_URLS = import.meta.glob('../../../../../node_modules/pdfjs-dist/cmaps/*.bcmap', {
  query: '?url',
  import: 'default',
  eager: true
}) as Record<string, string>;
// フォントの実体だけを取り込む。ライセンス文（LICENSE_FOXIT など）まで拾うと、
// 拡張子の無いファイルが `名前-ハッシュ.` の形で出力され、Windows が扱えない名前になる
const FONT_URLS = import.meta.glob('../../../../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', {
  query: '?url',
  import: 'default',
  eager: true
}) as Record<string, string>;
const byBaseName = (urls: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(urls).map(([file, url]) => [file.split('/').pop() ?? file, url]));
const cmapUrls = byBaseName(CMAP_URLS);
const fontUrls = byBaseName(FONT_URLS);

async function fetchBytes(url: string | undefined, what: string): Promise<Uint8Array> {
  if (!url) throw new Error(`${what} が見つかりません`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${what} を読めませんでした（HTTP ${res.status}）`);
  return new Uint8Array(await res.arrayBuffer());
}

class BundledCMapReaderFactory {
  constructor(_opts: { baseUrl?: string | null; isCompressed?: boolean }) {}
  async fetch({ name }: { name: string }): Promise<{ cMapData: Uint8Array; isCompressed: boolean }> {
    return { cMapData: await fetchBytes(cmapUrls.get(`${name}.bcmap`), `CMap ${name}`), isCompressed: true };
  }
}

class BundledStandardFontDataFactory {
  constructor(_opts: { baseUrl?: string | null }) {}
  async fetch({ filename }: { filename: string }): Promise<Uint8Array> {
    return fetchBytes(fontUrls.get(filename), `フォント ${filename}`);
  }
}

/**
 * 描く密度。画面の画素 1 つに 1 画素で描くと、細い線の文字（MS ゴシックなど）がギザギザに見えるので、
 * 画面の密度が低いときは 2 倍で描いてブラウザに縮めさせる（なめらかな縮小になる）。
 * 大きく拡大したときにキャンバスが大きくなりすぎないよう、1 ページの画素数に上限を設ける
 */
const MIN_RENDER_DENSITY = 2;
const MAX_CANVAS_PIXELS = 40_000_000;

/** 読んでいた位置。ページ（1 から）と、そのページのどこまでスクロールしていたか（0〜1）、倍率 */
export interface PdfPosition {
  page: number;
  offset: number;
  zoom: number;
}

interface Props {
  url: string;
  /** 開いたときに戻す位置（ボイスプレイヤーでタブを切り替えて戻ってきたとき） */
  position?: PdfPosition | null;
  /** 位置が変わったら知らせる（持っておくのは呼び出し側） */
  onPosition?: (position: PdfPosition) => void;
  /** アーカイブの中のファイルは Range で読めないので、まとめて読ませる */
  inArchive?: boolean;
  /**
   * ページ送りのキー操作（← → PageUp PageDown Space Home End）を受け持つか。
   * ボイスプレイヤーの台本欄では ← → が再生位置の移動なので、受け持たない
   */
  keyboard?: boolean;
}

/**
 * PDF の表示。設定で「縦にスクロール」（見えているページだけ描く）と「ページ送り」（1 ページずつ）を切り替える。
 */
export default function PdfView({ url, inArchive, keyboard = false, position = null, onPosition }: Props): JSX.Element {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  /** 1 ページ目の縦横比。まだ描いていないページの高さの見込みに使う（戻す位置がずれないように） */
  const [firstRatio, setFirstRatio] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(position?.zoom ?? 1);
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 600, height: 800 });
  const [prefs, setPrefs] = useViewerPrefs();
  const [page, setPage] = useState(position?.page ?? 1);
  const lastFlip = useRef(0);
  const paged = prefs.pdfMode === 'page';
  /** 戻す位置（最初の 1 回だけ使う） */
  const restore = useRef<PdfPosition | null>(position);
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;
  /** スクロールしている間の、いま上に見えているページと位置 */
  const scrollPos = useRef({ page: position?.page ?? 1, offset: position?.offset ?? 0 });

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setFirstRatio(null);
    setError(null);
    // 最初に開いたときは戻す位置、別の PDF に切り替えたときは 1 ページ目から
    setPage(restore.current?.page ?? 1);
    const task = pdfjs.getDocument({
      url,
      disableRange: !!inArchive,
      disableStream: !!inArchive,
      // pdf.js が使うのは constructor と fetch だけ。同梱した CMap・フォントを画面側で読んで渡す
      CMapReaderFactory: BundledCMapReaderFactory,
      StandardFontDataFactory: BundledStandardFontDataFactory,
      useWorkerFetch: false
    });
    task.promise
      .then(async (d) => {
        if (cancelled) return;
        const first = await d.getPage(1).catch(() => null);
        if (cancelled) return;
        if (first) {
          const vp = first.getViewport({ scale: 1 });
          setFirstRatio(vp.height / vp.width);
        }
        setDoc(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [url, inArchive]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    // ページ送りのときは、スクロールする親（ビューアの枠）の高さに合わせる
    const scroller = (el.parentElement ?? el) as HTMLElement;
    const measure = (): void =>
      setSize({ width: Math.max(200, el.clientWidth - 24), height: Math.max(200, scroller.clientHeight - 64) });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(scroller);
    measure();
    return () => ro.disconnect();
  }, []);

  const pages = doc?.numPages ?? 0;
  const rows = useMemo(() => spreadRows(pages, prefs.pdfSpread), [pages, prefs.pdfSpread]);
  const spread = prefs.pdfSpread !== 'off';
  const rtl = prefs.pdfRtl;
  /** いま表示している組（ページ送り） */
  const rowIndex = rowIndexOf(rows, page);
  const currentRow = rows[rowIndex] ?? [page];

  // ページ送り: めくったら知らせる
  useEffect(() => {
    if (!doc || !paged) return;
    onPositionRef.current?.({ page, offset: 0, zoom });
  }, [doc, paged, page, zoom]);

  // 縦にスクロール: 戻す位置へスクロールし、そのあとは上に見えているページを知らせる
  useEffect(() => {
    const el = hostRef.current;
    if (!doc || paged || !el) return;
    const scroller = scrollParent(el);
    if (!scroller) return;
    const pageEls = (): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('.pdf__page')];
    const top = (node: HTMLElement): number => node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;

    const target = restore.current;
    restore.current = null;
    if (target && (target.page > 1 || target.offset > 0)) {
      // ページの枠が並んでから（1 フレーム待つ）
      requestAnimationFrame(() => {
        const node = pageEls()[Math.min(pages, Math.max(1, target.page)) - 1];
        if (node) scroller.scrollTop = top(node) + target.offset * node.offsetHeight;
      });
    }

    let frame = 0;
    const onScroll = (): void => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const list = pageEls();
        const y = scroller.scrollTop;
        let index = list.findIndex((node) => top(node) + node.offsetHeight > y);
        if (index < 0) index = list.length - 1;
        const node = list[index];
        if (!node) return;
        const offset = Math.min(1, Math.max(0, (y - top(node)) / Math.max(1, node.offsetHeight)));
        scrollPos.current = { page: index + 1, offset };
        onPositionRef.current?.({ page: index + 1, offset, zoom });
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [doc, paged, pages, zoom]);

  // 倍率を変えたときも、スクロールの位置と一緒に知らせる
  useEffect(() => {
    if (!doc || paged) return;
    onPositionRef.current?.({ ...scrollPos.current, zoom });
  }, [doc, paged, zoom]);
  /** めくる。押し続け・回し続けのときは、設定の間隔より速くはめくらない */
  const flip = useCallback(
    (delta: number, throttle = false): void => {
      if (!pages) return;
      const now = Date.now();
      if (throttle && now - lastFlip.current < prefs.pageInterval) return;
      lastFlip.current = now;
      // 見開きでは組ごとにめくる。表示しているのは組のいちばん若いページ
      setPage((p) => {
        const next = Math.min(rows.length - 1, Math.max(0, rowIndexOf(rows, p) + delta));
        return rows[next]?.[0] ?? p;
      });
    },
    [pages, prefs.pageInterval, rows]
  );

  useEffect(() => {
    if (!keyboard || !paged) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLElement && e.target.closest('input,select,textarea')) return;
      const key = e.key;
      // 右綴じでは ← が次（読み進める向き）
      const nextKey = rtl ? 'ArrowLeft' : 'ArrowRight';
      const prevKey = rtl ? 'ArrowRight' : 'ArrowLeft';
      if (key === nextKey || key === 'PageDown' || (key === ' ' && !e.shiftKey)) flip(1, e.repeat);
      else if (key === prevKey || key === 'PageUp' || (key === ' ' && e.shiftKey)) flip(-1, e.repeat);
      else if (key === 'Home') setPage(1);
      else if (key === 'End') setPage(pages || 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keyboard, paged, flip, pages, rtl]);

  const onWheel = (e: React.WheelEvent): void => {
    // ページ送りで、拡大していないとき（ページが枠に収まっているとき）は、ホイールでめくる
    if (!paged || e.ctrlKey || zoom > 1 || e.deltaY === 0) return;
    const forward = prefs.wheelInvert ? e.deltaY < 0 : e.deltaY > 0;
    flip(forward ? 1 : -1, true);
  };

  return (
    <div className={`pdf ${paged ? 'pdf--paged' : ''}`} ref={hostRef} onWheel={onWheel}>
      <div className="pdf__bar">
        {paged && doc ? (
          <>
            {/* 右綴じでは、左のボタンが次へ */}
            <button
              className="btn btn--xs"
              disabled={rtl ? rowIndex >= rows.length - 1 : rowIndex <= 0}
              onClick={() => flip(rtl ? 1 : -1)}
              aria-label={rtl ? t('次のページ') : t('前のページ')}
              title={rtl ? t('次のページ') : t('前のページ')}
            >
              ◀
            </button>
            <input
              className="pdf__page-input"
              type="number"
              min={1}
              max={pages}
              value={page}
              onChange={(e) => setPage(Math.min(pages, Math.max(1, Number(e.target.value) || 1)))}
            />
            <span className="muted">
              {currentRow.length > 1 ? `–${currentRow[currentRow.length - 1]} ` : ''}/ {pages}
            </span>
            <button
              className="btn btn--xs"
              disabled={rtl ? rowIndex <= 0 : rowIndex >= rows.length - 1}
              onClick={() => flip(rtl ? -1 : 1)}
              aria-label={rtl ? t('前のページ') : t('次のページ')}
              title={rtl ? t('前のページ') : t('次のページ')}
            >
              ▶
            </button>
          </>
        ) : (
          <span className="muted">{doc ? t('{numPages} ページ', { numPages: doc.numPages }) : error ? '' : t('読み込み中…')}</span>
        )}
        <button className="btn btn--xs" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}>
          −
        </button>
        <span className="muted">{Math.round(zoom * 100)}%</span>
        <button className="btn btn--xs" onClick={() => setZoom((z) => Math.min(3, z + 0.25))}>
          {t('＋')}
        </button>
        <button
          className="btn btn--xs btn--ghost"
          title={t('表示のしかたを切り替える（設定の「画像・CG」でも変えられます）')}
          onClick={() => setPrefs({ pdfMode: paged ? 'scroll' : 'page' })}
        >
          {paged ? t('縦にスクロール') : t('ページ送り')}
        </button>
        <select
          className="select select--xs"
          value={prefs.pdfSpread}
          title={t('見開き')}
          onChange={(e) => setPrefs({ pdfSpread: e.target.value === 'on' || e.target.value === 'cover' ? e.target.value : 'off' })}
        >
          <option value="off">{t('単ページ')}</option>
          <option value="on">{t('見開き')}</option>
          <option value="cover">{t('見開き（表紙は単独）')}</option>
        </select>
        {spread && (
          <button className={`btn btn--xs ${rtl ? 'btn--on' : ''}`} onClick={() => setPrefs({ pdfRtl: !rtl })} title={t('綴じ方向')}>
            {rtl ? t('右綴じ') : t('左綴じ')}
          </button>
        )}
      </div>
      {error && <div className="banner banner--error">{t('PDF を開けませんでした: {error}', { error })}</div>}
      {doc && paged && (
        <div className={`pdf__row ${rtl ? 'pdf__row--rtl' : ''}`}>
          {currentRow.map((n, slot) => (
            <PdfPage
              key={`${url}:page:${slot}`}
              doc={doc}
              pageNumber={n}
              fit={{ width: pageWidth(size.width * zoom, spread), height: zoom > 1 ? Infinity : size.height }}
              initialRatio={firstRatio}
              eager
            />
          ))}
        </div>
      )}
      {doc &&
        !paged &&
        rows.map((row) => (
          <div key={`${url}:row:${row[0]}`} className={`pdf__row ${rtl ? 'pdf__row--rtl' : ''}`}>
            {row.map((n) => (
              <PdfPage
                key={`${url}:${n}`}
                doc={doc}
                pageNumber={n}
                fit={{ width: pageWidth(size.width * zoom, spread), height: Infinity }}
                initialRatio={firstRatio}
              />
            ))}
          </div>
        ))}
    </div>
  );
}

/** 見開きの 1 ページぶんの幅（2 ページとすき間で、表示できる幅を分ける） */
const SPREAD_GAP = 4;
function pageWidth(width: number, spread: boolean): number {
  return spread ? Math.max(100, (width - SPREAD_GAP) / 2) : width;
}

/** いちばん近いスクロールする親（無ければ null = 画面） */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}

function PdfPage({
  doc,
  pageNumber,
  fit,
  initialRatio,
  eager = false
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  /** この幅・高さに収める（高さが Infinity なら幅に合わせる） */
  fit: { width: number; height: number };
  /** まだ描いていないときの縦横比の見込み（1 ページ目の縦横比） */
  initialRatio?: number | null;
  /** 見えているかを待たずに描く（ページ送り） */
  eager?: boolean;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  /** 近くにあって描いておくか（遠く離れたら画素を捨てて、近づいたら描き直す） */
  const [visible, setVisible] = useState(eager || pageNumber <= 2);
  const [ratio, setRatio] = useState(initialRatio ?? 1.414);
  const width = Math.min(fit.width, fit.height / ratio);

  useEffect(() => {
    if (eager) return;
    const el = boxRef.current;
    if (!el) return;
    // 近づいたら描き、画面から大きく離れたら捨てる（2 倍の密度で全ページを持つとメモリを食う）。
    // 余白（rootMargin）は基準の枠にしか効かないので、ページを切り取っているスクロールの枠を基準にする
    const root = scrollParent(el);
    const near = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setVisible(true);
    }, { root, rootMargin: '1200px 0px' });
    const far = new IntersectionObserver((entries) => {
      if (entries.every((e) => !e.isIntersecting)) setVisible(false);
    }, { root, rootMargin: '4000px 0px' });
    near.observe(el);
    far.observe(el);
    return () => {
      near.disconnect();
      far.disconnect();
    };
  }, [eager]);

  useEffect(() => {
    if (!visible) {
      const canvas = canvasRef.current;
      if (canvas && canvas.width > 0) {
        canvas.width = 0;
        canvas.height = 0;
      }
      return;
    }
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;
    void doc.getPage(pageNumber).then((page) => {
      if (cancelled || !canvasRef.current) return;
      const base = page.getViewport({ scale: 1 });
      const nextRatio = base.height / base.width;
      setRatio(nextRatio);
      const drawWidth = Math.min(fit.width, fit.height / nextRatio);
      const density = Math.max(window.devicePixelRatio || 1, MIN_RENDER_DENSITY);
      let scale = (drawWidth / base.width) * density;
      const pixels = base.width * scale * base.height * scale;
      if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      renderTask = page.render({ canvasContext: ctx, viewport });
      renderTask.promise.catch(() => undefined);
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [doc, pageNumber, fit.width, fit.height, visible]);

  return (
    <div className="pdf__page" ref={boxRef} style={{ width, height: width * ratio }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}
