import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 「ユーザーデータを削除して終了」の後始末。
 * データのフォルダ（台帳・設定・ログイン状態・キャッシュ・入れたツール）は、アプリが動いている間は開いているので消せない。
 * アプリが終わるのを待ってフォルダを消す小さな処理（PowerShell）を残し、そのあとでアプリを終える。
 * ダウンロードした作品のファイルはこのフォルダの外にあるので消さない。
 */

/**
 * 消してよいデータのフォルダか。環境変数 SIMAERU_USER_DATA で別のフォルダを指していることもあるので、
 * 台帳（library.db）があり、ドライブの直下・ホーム・ホームの直下の決まったフォルダ（ドキュメントなど）でないものだけにする
 */
export function isRemovableUserData(dir: string): boolean {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(path.join(resolved, 'library.db'))) return false;
  if (resolved === path.parse(resolved).root) return false; // ドライブの直下
  const home = path.resolve(os.homedir()).toLowerCase();
  const lower = resolved.toLowerCase();
  if (lower === home) return false;
  if (path.dirname(lower) === home) return false; // ドキュメント・デスクトップ・ダウンロードなど
  return true;
}

/** PowerShell の単一引用符の中に入れる形 */
const quote = (text: string): string => `'${text.replace(/'/g, "''")}'`;

/**
 * pid のプロセスが終わるのを待ってから dir を消す処理を、アプリと切り離して起動する。
 * 消せないファイルが残っていれば、1 秒おきに 30 回までやり直す（Electron の子プロセスが少し遅れて終わるため）
 */
export function scheduleUserDataRemoval(dir: string, pid: number = process.pid): ChildProcess {
  const script = [
    `$dir = ${quote(path.resolve(dir))}`,
    `try { Wait-Process -Id ${Math.trunc(pid)} -Timeout 120 -ErrorAction SilentlyContinue } catch {}`,
    'for ($i = 0; $i -lt 30; $i++) {',
    '  if (-not (Test-Path -LiteralPath $dir)) { break }',
    '  try { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop } catch { Start-Sleep -Seconds 1 }',
    '}'
  ].join('\n');
  // 日本語のパスや引用符を壊さないよう、UTF-16LE の Base64 で渡す
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  // cmd の start で起動して、アプリから切り離す。
  // そのまま子として起動すると、アプリが終わるときに一緒に止められることがある（detached の PowerShell は何もせずに終わる）
  const child = spawn('cmd.exe', ['/d', '/c', 'start', '""', '/b', 'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  return child;
}
