import path from 'node:path';
import { CATEGORY_LABELS, WORK_TYPE_LABELS, type Product } from '@shared/types';

/**
 * 保存先のフォルダ構成。テンプレート文字列をトークン展開して作る。
 * 区切りはテンプレート中の `/` だけ。トークンの中身に `/` が入っていても階層にはしない。
 */

/**
 * 既定のフォルダ構成。サークル・ブランドの下を種別（ボイス・ASMR / マンガ・コミック…）で分ける。
 * 同じサークルがボイスとマンガを両方出していることがあり、混ぜると探しにくいため。
 */
export const DEFAULT_TEMPLATE = '{site}/{category}/{maker}/{workType}/[{maker}] {title}';

/** 以前の既定。これを保存したままの設定は、新しい既定として扱う */
export const LEGACY_DEFAULT_TEMPLATE = '{site}/{category}/{maker}/[{maker}] {title}';

const SITE_LABELS: Record<string, string> = { dmm: 'DMM', dlsite: 'DLsite' };

/** Windowsで使えない文字と、末尾の空白・ドットを落とす */
export function sanitizeSegment(raw: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (!cleaned) return '_';
  // 予約名（CON, PRN, AUX, NUL, COM1…, LPT1…）はそのままだと作成できない
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned)) return `${cleaned}_`;
  return cleaned;
}

function tokenValue(token: string, product: Product): string {
  const purchased = product.purchasedAt ?? product.releasedAt ?? '';
  switch (token) {
    case 'site':
      return SITE_LABELS[product.siteId] ?? product.siteId;
    case 'category':
      return CATEGORY_LABELS[product.category] ?? product.category;
    case 'workType':
      return product.workType ? (WORK_TYPE_LABELS[product.workType] ?? product.workType) : 'その他';
    case 'maker':
      return product.maker ?? '不明';
    case 'title':
      return product.title || product.productId;
    case 'productId':
      return product.productId;
    case 'floor':
      return product.floorId;
    case 'year':
      return purchased.slice(0, 4) || '0000';
    case 'month':
      return purchased.slice(5, 7) || '00';
    default:
      return '';
  }
}

/** Windowsのパス長（260）に収まるよう、長いところから削る */
function fitWindowsPath(root: string, segments: string[], fileName: string): string[] {
  const LIMIT = 240; // ファイル名ぶんの余裕を見て短めに切る
  const out = [...segments];
  for (let guard = 0; guard < 8; guard++) {
    const full = path.join(root, ...out, fileName);
    if (full.length <= LIMIT) return out;
    // いちばん長いセグメントを削る。全部短いのにあふれるならこれ以上は詰められない
    let longest = 0;
    for (let i = 1; i < out.length; i++) if (out[i].length > out[longest].length) longest = i;
    if (out[longest].length <= 12) return out;
    out[longest] = out[longest].slice(0, Math.max(12, out[longest].length - 24)).trimEnd();
  }
  return out;
}

/**
 * 作品の保存先フォルダを作る。
 * @param template 設定のテンプレート。空なら既定
 * @param fileName パス長の計算に使う（実際の連結はしない）
 */
export function productFolder(
  root: string,
  template: string,
  product: Product,
  fileName = ''
): string {
  const segments = (template || DEFAULT_TEMPLATE)
    .split('/')
    .map((part) =>
      part.replace(/\{(\w+)\}/g, (_, token: string) => tokenValue(token, product))
    )
    .map(sanitizeSegment)
    .filter((seg) => seg !== '_' || true);

  return path.join(root, ...fitWindowsPath(root, segments, fileName));
}

/** 同名ファイルがあるときに (2), (3)… を付ける */
export function uniqueFileName(exists: (p: string) => boolean, dir: string, name: string): string {
  const target = path.join(dir, name);
  if (!exists(target)) return target;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 100; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!exists(candidate)) return candidate;
  }
  return path.join(dir, `${base} (${Date.now()})${ext}`);
}
