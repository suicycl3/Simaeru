import { useEffect, useState } from 'react';
import { t } from '@shared/i18n';

/**
 * 画像ビューアの操作の好み。見た目の好みなので、このPCのこの画面にだけ持つ（localStorage）。
 * 設定画面とビューアの両方から変えられるので、変えたら知らせ合う。
 */
/**
 * 画像の合わせ方。全体: 画面に収める（小さい画像は引き伸ばさない）/ 全体（拡大）: 小さい画像も画面に収まるまで拡大 /
 * 幅合わせ: 幅を画面に合わせて縦にスクロール / 高さ合わせ: 高さを画面に合わせて横にスクロール / 原寸
 */
export type ImageFit = 'contain' | 'fill' | 'width' | 'height' | 'original';
/** 合わせ方の一覧（この順でリストに並べ、F キーでもこの順に送る） */
export const IMAGE_FITS: Array<{ value: ImageFit; label: string }> = [
  { value: 'contain', label: t('全体') },
  { value: 'fill', label: t('全体（拡大）') },
  { value: 'width', label: t('幅合わせ') },
  { value: 'height', label: t('高さ合わせ') },
  { value: 'original', label: t('原寸') }
];
const isImageFit = (v: unknown): v is ImageFit => IMAGE_FITS.some((f) => f.value === v);

export interface ViewerPrefs {
  /** 画像ビューアを開いたときの合わせ方 */
  imageFit: ImageFit;
  /** ホイールを上に回すと次のページ */
  wheelInvert: boolean;
  /** ホイールを回し続けたり、キーを押し続けたりしたときの、ページをめくる最短の間隔（ミリ秒） */
  pageInterval: number;
  /** 拡大の補間方式。smooth: バイキュービック（Chromium の標準） / pixelated: ニアレストネイバー（ドット絵・細かい文字向け） */
  smoothing: 'smooth' | 'pixelated';
  /** シャープ化の強さ（0: 切） */
  sharpen: 0 | 1 | 2 | 3;
  /** PDF の表示。scroll: 縦に並べてスクロール / page: 1 ページずつめくる */
  pdfMode: 'scroll' | 'page';
  /** PDF の見開き。off: 単ページ / on: 見開き / cover: 見開き（表紙は単独） */
  pdfSpread: 'off' | 'on' | 'cover';
  /** PDF の綴じ方向。true: 右綴じ（右から左へ読む。マンガなど） */
  pdfRtl: boolean;
}

/** シャープ化の強さごとの係数（0 は使わない） */
export const SHARPEN_LEVELS = [0, 0.15, 0.3, 0.6];
export const SHARPEN_LABELS = [t('切'), t('弱'), t('中'), t('強')];

const KEY = 'viewer.prefs';
const EVENT = 'viewer-prefs';

export const PAGE_SPEEDS: Array<{ ms: number; label: string }> = [
  { ms: 0, label: t('とても速い') },
  { ms: 120, label: t('速い') },
  { ms: 250, label: t('ふつう') },
  { ms: 450, label: t('ゆっくり') },
  { ms: 800, label: t('とてもゆっくり') }
];

export const DEFAULT_VIEWER_PREFS: ViewerPrefs = { imageFit: 'contain', wheelInvert: false, pageInterval: 250, smoothing: 'smooth', sharpen: 0, pdfMode: 'scroll', pdfSpread: 'off', pdfRtl: false };

export function readViewerPrefs(): ViewerPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<ViewerPrefs>;
    return {
      imageFit: isImageFit(raw.imageFit) ? raw.imageFit : DEFAULT_VIEWER_PREFS.imageFit,
      wheelInvert: typeof raw.wheelInvert === 'boolean' ? raw.wheelInvert : DEFAULT_VIEWER_PREFS.wheelInvert,
      pageInterval:
        typeof raw.pageInterval === 'number' && raw.pageInterval >= 0 ? raw.pageInterval : DEFAULT_VIEWER_PREFS.pageInterval,
      smoothing: raw.smoothing === 'pixelated' ? 'pixelated' : 'smooth',
      sharpen: raw.sharpen === 1 || raw.sharpen === 2 || raw.sharpen === 3 ? raw.sharpen : 0,
      pdfMode: raw.pdfMode === 'page' ? 'page' : 'scroll',
      pdfSpread: raw.pdfSpread === 'on' || raw.pdfSpread === 'cover' ? raw.pdfSpread : 'off',
      pdfRtl: raw.pdfRtl === true
    };
  } catch {
    return DEFAULT_VIEWER_PREFS;
  }
}

export function writeViewerPrefs(next: Partial<ViewerPrefs>): ViewerPrefs {
  const merged = { ...readViewerPrefs(), ...next };
  try {
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    // 保存できなくても、開いている間は効かせる
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: merged }));
  return merged;
}

export function useViewerPrefs(): [ViewerPrefs, (next: Partial<ViewerPrefs>) => void] {
  const [prefs, setPrefs] = useState(readViewerPrefs);
  useEffect(() => {
    const on = (e: Event): void => setPrefs((e as CustomEvent<ViewerPrefs>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return [prefs, (next) => setPrefs(writeViewerPrefs(next))];
}
