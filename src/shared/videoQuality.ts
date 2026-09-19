import type { ProductLink } from './types';

/**
 * 動画のダウンロードの画質。導線（ProductLink.quality）から、画質ごとにまとめて選ぶ。
 * 画質の印は API の値そのまま（'300'・'6000'・'4k' など）。'4k' を数として読むと 4 になり最低画質に見えるので、
 * 並びは API の quality_order を使い、無いときだけ印から決める。
 */

export interface VideoQualityOption {
  key: string;
  /** サイトの呼び名（「FullHD (1080p60)」など）。取れていなければ null */
  name: string | null;
  /** 全パートの合計（MB）。分からなければ null */
  sizeMb: number | null;
  parts: number;
  /** 大きいほど高画質 */
  order: number;
  /** 縦の画素数。分からなければ null */
  height: number | null;
}

/**
 * 画質の既定・指定。
 * - 'best': いちばん高い画質
 * - 'h:<縦の画素数>': その高さまでの、いちばん高い画質（無ければいちばん低い画質）
 * - 'q:<画質の印>': その画質（無ければ 'best'）
 */
export type VideoQualityPref = string;

export const VIDEO_QUALITY_PREFS: VideoQualityPref[] = ['best', 'h:1080', 'h:720', 'h:576', 'h:432', 'h:288', 'h:144'];

/** 画質の印（'6000' など）。導線に quality が無い古いデータは、ラベルの「ダウンロード 6000k」から読む */
export function qualityKeyOf(link: ProductLink): string | null {
  if (link.quality?.key) return link.quality.key;
  const m = /^ダウンロード\s+(\d+|4k)k?(?:（|$)/i.exec(link.label);
  return m ? m[1].toLowerCase() : null;
}

/** 印だけのときの縦の画素数（サイトの呼び名に合わせた目安） */
const HEIGHT_BY_KEY: Record<string, number> = { '300': 144, '500': 240, '1000': 288, '1500': 360, '2000': 432, '3000': 576, '4000': 720, '6000': 1080, '4k': 2160 };

function orderOf(link: ProductLink, key: string): number {
  if (typeof link.quality?.order === 'number') return link.quality.order;
  if (key === '4k') return 1_000_000;
  return Number(key) || 0;
}

function heightOf(link: ProductLink, key: string): number | null {
  const m = /(\d{3,4})p/.exec(link.quality?.name ?? '');
  if (m) return Number(m[1]);
  return HEIGHT_BY_KEY[key] ?? null;
}

/** 動画のダウンロード導線を、画質ごとにまとめる（高い順） */
export function videoQualityOptions(links: ProductLink[]): VideoQualityOption[] {
  const groups = new Map<string, VideoQualityOption>();
  for (const link of links) {
    if (link.kind !== 'download') continue;
    const key = qualityKeyOf(link);
    if (!key) continue;
    const g = groups.get(key) ?? { key, name: link.quality?.name ?? null, sizeMb: null, parts: 0, order: orderOf(link, key), height: heightOf(link, key) };
    g.parts++;
    if (typeof link.quality?.sizeMb === 'number') g.sizeMb = (g.sizeMb ?? 0) + link.quality.sizeMb;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.order - a.order);
}

/** 既定・指定から、落とす画質を 1 つ選ぶ */
export function pickVideoQuality(options: VideoQualityOption[], pref: VideoQualityPref | null | undefined): VideoQualityOption | null {
  if (options.length === 0) return null;
  if (pref?.startsWith('q:')) {
    const exact = options.find((o) => o.key === pref.slice(2));
    if (exact) return exact;
  }
  if (pref?.startsWith('h:')) {
    const max = Number(pref.slice(2));
    const fit = options.find((o) => o.height !== null && o.height <= max);
    return fit ?? options[options.length - 1];
  }
  return options[0];
}
