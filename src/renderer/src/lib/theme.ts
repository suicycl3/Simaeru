import { t } from '@shared/i18n';

/**
 * 画面のテーマ（配色）。styles.css の :root の変数を、<html data-theme> で差し替える。
 * 覚えるのはこの PC のこの窓の保存場所（localStorage）。ビューアの別ウィンドウも同じ場所を読むので、そろって切り替わる。
 */
export type Theme = 'dark' | 'light' | 'pastel' | 'ivory';

export const THEMES: Array<{ value: Theme; label: string }> = [
  { value: 'dark', label: t('ダーク') },
  { value: 'light', label: t('ライト') },
  { value: 'pastel', label: t('パステル') },
  { value: 'ivory', label: t('アイボリー') }
];

const KEY = 'app.theme';

export function savedTheme(): Theme {
  try {
    // 「ベージュ」は色合いを変えて「アイボリー」にした
    const saved = localStorage.getItem(KEY)?.replace(/^beige$/, 'ivory');
    return THEMES.some((x) => x.value === saved) ? (saved as Theme) : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* 保存できない環境では、この窓だけ切り替える */
  }
  applyTheme(theme);
}

/** 起動時に当て、ほかの窓（設定を変えた窓）で切り替えたら追いかける */
export function installTheme(): void {
  applyTheme(savedTheme());
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) applyTheme(savedTheme());
  });
}
