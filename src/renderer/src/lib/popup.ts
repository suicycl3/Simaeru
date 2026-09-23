/**
 * 別ウィンドウ（ポップアップ）で開いたビューアかどうかの判定。
 * ビューアの部品から参照するので、部品を読み込まない小さなモジュールに分けてある（循環を避ける）。
 */

/** 別ウィンドウで開くビューアの指定（main の viewer/popups.ts と同じ形） */
export interface PopupSpec {
  kind: 'images' | 'pdf' | 'video' | 'voice' | 'text';
  productId: number;
  entryUrl?: string | null;
  title?: string | null;
}

/** URL の `#popup=…` から指定を読む。ポップアップでなければ null */
export function readPopupSpec(hash: string): PopupSpec | null {
  const m = /[#&]popup=([^&]+)/.exec(hash);
  if (!m) return null;
  try {
    const spec = JSON.parse(decodeURIComponent(m[1])) as PopupSpec;
    return spec && typeof spec.productId === 'number' && typeof spec.kind === 'string' ? spec : null;
  } catch {
    return null;
  }
}

/** いまポップアップの中で動いているか（ビューアの「別ウィンドウで開く」を出さないため） */
export const IN_POPUP = typeof window !== 'undefined' && readPopupSpec(window.location.hash) !== null;
