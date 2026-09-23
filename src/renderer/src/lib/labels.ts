import type { JobKind } from '@shared/types';
import { t } from '@shared/i18n';

/** 後処理ジョブの呼び名 */
export const JOB_LABELS: Record<JobKind, string> = {
  extract: t('展開'),
  flac: 'FLAC',
  move: t('移動'),
  lossy: t('MP3だけ残す'),
  pdf: t('PDFを消す'),
  sfxzip: t('exe を zip に')
};

/**
 * メインプロセスが日本語のまま保存している呼び名（リンク・ダウンロードの行・人の役割・区分など）を、表示のときに訳す。
 * 番号などが入った形も、決まった形なら訳す。辞書に無ければそのまま。
 */
export function storedLabel(label: string): string {
  let m = label.match(/^(.*)（(\d+)\/(\d+)）$/);
  if (m) return `${storedLabel(m[1])} (${m[2]}/${m[3]})`;
  m = label.match(/^ダウンロード (\d+)k$/);
  if (m) return t('ダウンロード {rate}k', { rate: m[1] });
  // 動画の画質の呼び名（サイトの表記のまま）
  m = label.match(/^ダウンロード (.+\(\d+p\d*\))$/);
  if (m) return `${t('ダウンロード')} ${m[1]}`;
  m = label.match(/^再生（パート (\d+)）$/);
  if (m) return t('再生（パート {n}）', { n: m[1] });
  m = label.match(/^再生（別形式 (\d+)）$/);
  if (m) return t('再生（別形式 {n}）', { n: m[1] });
  m = label.match(/^付録（(.+)）$/);
  if (m) return t('付録（{format}）', { format: m[1] });
  m = label.match(/^ダウンロードページ (\d+)$/);
  if (m) return t('ダウンロードページ {n}', { n: m[1] });
  m = label.match(/^移動 (\d+) 件$/);
  if (m) return t('移動 {length} 件', { length: m[1] });
  return t(label);
}
