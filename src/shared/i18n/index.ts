import { en } from './en';
import { zh } from './zh';

/**
 * 画面の言語（多言語化）。
 *
 * - 文言は日本語をそのままキーにする: `t('ダウンロード')`。辞書に無ければ日本語のまま出す。
 * - 差し込み: `t('{count} 件', { count })`。false / null / undefined は空文字になる（`cond && t(...)` を差し込めるように）。
 * - 言語はメインプロセスが設定から決め、レンダラには preload が同期で渡す（`window.api.lang`）。
 *   モジュールの読み込み時に作る定数（ラベルの表など）でも正しい言語になるよう、読み込んだ時点で決める。
 *   言語を変えたら画面を読み直す。
 */

/** zh: 简体中文 */
export type Lang = 'ja' | 'en' | 'zh';

export const LANGS: Array<{ value: Lang; label: string }> = [
  { value: 'ja', label: '日本語' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: '简体中文' }
];

const DICTS: Record<Exclude<Lang, 'ja'>, Record<string, string>> = { en, zh };

export function normalizeLang(value: string | null | undefined): Lang | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v.startsWith('ja')) return 'ja';
  if (v.startsWith('en')) return 'en';
  if (v.startsWith('zh')) return 'zh';
  return null;
}

function detect(): Lang {
  const g = globalThis as { api?: { lang?: string } };
  return normalizeLang(g.api?.lang) ?? 'ja';
}

let current: Lang = detect();

/** 辞書に無かった文言（日本語以外で表示しているときだけ集める。開発中の確認用） */
export const missing = new Set<string>();

export function setLang(lang: Lang): void {
  current = lang;
}

export function getLang(): Lang {
  return current;
}

/** 日付・数値の書式に使うロケール */
export function locale(): string {
  return current === 'en' ? 'en-US' : current === 'zh' ? 'zh-CN' : 'ja-JP';
}

export function t(ja: string, vars?: Record<string, unknown>): string {
  let text = ja;
  if (current !== 'ja') {
    const hit = DICTS[current][ja];
    if (hit === undefined) missing.add(ja);
    else text = hit;
  }
  if (vars) {
    text = text.replace(/\{(\w+)\}/g, (m, key: string) => {
      if (!(key in vars)) return m;
      const v = vars[key];
      return v === false || v === null || v === undefined ? '' : String(v);
    });
  }
  return text;
}
