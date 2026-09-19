import { t } from './i18n';

/** サービスからの確定結果と通信・解析失敗を区別する。UIの前回値とは別に扱う。 */
export type AuthResult =
  | { state: 'authenticated'; message: null }
  | { state: 'unauthenticated'; message: null }
  | { state: 'unknown'; message: string };

export const authenticated = (): AuthResult => ({ state: 'authenticated', message: null });
export const unauthenticated = (): AuthResult => ({ state: 'unauthenticated', message: null });
export const authUnknown = (reason: unknown): AuthResult => ({
  state: 'unknown', message: reason instanceof Error ? reason.message : String(reason)
});

/** 既存rendererのサービス状態契約への変換。unknownはfalseにしない。 */
export function authValue(result: AuthResult): boolean | null {
  return result.state === 'unknown' ? null : result.state === 'authenticated';
}

/**
 * 画面に出す文言。adapter が返す reason は例外の文面や HTTP 状態で、そのままでは意味が伝わらないので
 * ここ（IPC の境界）で説明文にする。確定した結果には文言を付けない。
 */
export function authStatusMessage(label: string, result: AuthResult): string | null {
  if (result.state !== 'unknown') return null;
  const reason = result.message.trim();
  return reason
    ? t('{label} のログイン状態を確かめられませんでした（{reason}）', { label, reason })
    : t('{label} のログイン状態を確かめられませんでした', { label });
}
