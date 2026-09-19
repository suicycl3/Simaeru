import fs from 'node:fs';
import path from 'node:path';
import { APP_ID, LEGACY_APP_ID } from '@shared/appInfo';

/**
 * データの置き場所（userData）を決める。
 *
 * 表示名を MyLibrary から Simaeru に変えたとき、置き場所も `%APPDATA%\dmm-library` から
 * `%APPDATA%\simaeru` に移す。中身（台帳・ログイン状態・表紙・ツール）はそのまま使いたいので、
 * **起動のいちばん最初に、まだ何も開いていない状態でフォルダごと改名する**。
 * 同じドライブの中の改名なので、途中で終わって片方だけ残ることはない。
 *
 * 改名できないとき（別のプロセスが掴んでいる・権限が無いなど）は、**古いフォルダをそのまま使う**。
 * 新しい名前で空から始めてしまうと、購入履歴もログインも消えたように見えるため。
 */
export function resolveUserDataDir(appDataDir: string, override?: string | null): string {
  if (override) return override;
  const isDir = (p: string): boolean => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const current = path.join(appDataDir, APP_ID);
  const legacy = path.join(appDataDir, LEGACY_APP_ID);
  if (isDir(current)) return current;
  if (!isDir(legacy)) return current;
  try {
    fs.renameSync(legacy, current);
    console.log(`[userData] 置き場所を引き継ぎました: ${legacy} → ${current}`);
    return current;
  } catch (err) {
    console.warn(
      `[userData] 引き継ぎに失敗したので、これまでの置き場所を使います: ${legacy}`,
      err instanceof Error ? err.message : err
    );
    return legacy;
  }
}
