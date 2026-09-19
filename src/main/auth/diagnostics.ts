/** 秘密値・URL・レスポンス本文を受け取らない認証診断記録。 */
type AuthEvent = {
  at: string;
  service: string;
  event: 'probe' | 'recovery-start' | 'recovery-wait' | 'recovery-end' | 'cookie-remove';
  state?: 'authenticated' | 'unauthenticated' | 'unknown';
  ok?: boolean;
  cookie?: { name: string; domain: string; path: string };
};
const events: AuthEvent[] = [];
export function recordAuth(event: Omit<AuthEvent, 'at'>): void {
  events.push({ ...event, at: new Date().toISOString() });
  if (events.length > 300) events.shift();
}
export function authDiagnostics(): string {
  return JSON.stringify({ version: 1, events }, null, 2);
}
