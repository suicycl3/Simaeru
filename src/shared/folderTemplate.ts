import { CATEGORY_LABELS, WORK_TYPE_LABELS, type Product } from './types';

/**
 * 保存先のフォルダ構成。テンプレート文字列をトークン展開して作る。
 * 区切りはテンプレート中の `/` だけ。トークンの中身に `/` が入っていても階層にはしない。
 * 本体（保存先の決定）と設定画面（例の表示）の両方で使う。パスの連結・長さの調整は本体の download/paths.ts
 */

/**
 * 既定のフォルダ構成。サークル・ブランドの下を種別（ボイス・ASMR / マンガ・コミック…）で分ける。
 * 同じサークルがボイスとマンガを両方出していることがあり、混ぜると探しにくいため。
 */
export const DEFAULT_TEMPLATE = '{site}/{category}/{maker}/{workType}/[{maker}] {title}';

/** 以前の既定。これを保存したままの設定は、新しい既定として扱う */
export const LEGACY_DEFAULT_TEMPLATE = '{site}/{category}/{maker}/[{maker}] {title}';

/** トークンの展開に使う作品の情報 */
export type TemplateProduct = Pick<Product, 'siteId' | 'floorId' | 'category' | 'workType' | 'maker' | 'title' | 'productId' | 'purchasedAt' | 'releasedAt'>;

/**
 * 設定画面に並べるトークン（並びは画面の順）。label は t() に通す（i18n-extra の folderTokens）。
 * `{floor}`（サイト内部の売り場の名前）も展開はできるが、意味が分かりにくいので並べない
 */
export const FOLDER_TOKENS: Array<{ token: string; label: string }> = [
  { token: 'site', label: '購入サイト' },
  { token: 'category', label: '区分' },
  { token: 'maker', label: 'サークル・ブランド' },
  { token: 'workType', label: '種別' },
  { token: 'title', label: 'タイトル' },
  { token: 'productId', label: '作品ID' },
  { token: 'year', label: '購入年' },
  { token: 'month', label: '購入月' }
];

const KNOWN_TOKENS = new Set([...FOLDER_TOKENS.map((x) => x.token), 'floor']);

const SITE_LABELS: Record<string, string> = { dmm: 'DMM', dlsite: 'DLsite' };

/** 設定画面の例に使う、架空の作品 */
export const SAMPLE_PRODUCT: TemplateProduct = {
  siteId: 'dlsite',
  floorId: 'doujin',
  category: 'doujin',
  workType: 'voice',
  maker: 'サンプルサークル',
  title: 'サンプル作品のタイトル',
  productId: 'RJ00000000',
  purchasedAt: '2024-06-02 10:00',
  releasedAt: null
};

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

export function tokenValue(token: string, product: TemplateProduct): string {
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

/** テンプレートを展開して、フォルダの階層ごとの名前にする（Windows で使えない文字は落とす） */
export function expandTemplate(template: string, product: TemplateProduct): string[] {
  return (template || DEFAULT_TEMPLATE)
    .split('/')
    .map((part) => part.replace(/\{(\w+)\}/g, (_, token: string) => tokenValue(token, product)))
    .map(sanitizeSegment);
}

/** 使えないトークン（展開すると空になる）。綴りの間違いを画面で知らせるため */
export function unknownTokens(template: string): string[] {
  const found = [...template.matchAll(/\{(\w*)\}/g)].map((m) => m[1]).filter((name) => !KNOWN_TOKENS.has(name));
  return [...new Set(found)];
}
