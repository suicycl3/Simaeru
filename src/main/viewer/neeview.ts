import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 漫画・CG集のビューアは自作せず、[NeeView](https://github.com/neelabo/NeeView)（MIT）に任せる。
 * WPF製なのでアプリには埋め込めないが、パスを渡して**別プロセスで起動**すれば足りる。
 *
 *   NeeView.exe [Options...] [File or Folder...]
 *
 * 同梱はしない。入っていれば使い、無ければ内蔵ビューア（または既定のアプリ）に回す。
 */

/** よくある導入先。UWP版はここには出ないので、その場合は設定でパスを指定してもらう */
function candidatePaths(): string[] {
  const dirs = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
    process.env.APPDATA
  ].filter((d): d is string => !!d);
  const out: string[] = [];
  for (const dir of dirs) {
    out.push(path.join(dir, 'NeeView', 'NeeView.exe'));
    out.push(path.join(dir, 'Programs', 'NeeView', 'NeeView.exe'));
  }
  return out;
}

/**
 * NeeView の場所を探す。
 * @param configured 設定で指定されたパス。あればそれを優先する
 */
export function findNeeView(configured?: string | null): string | null {
  if (configured && fs.existsSync(configured)) return configured;
  for (const candidate of candidatePaths()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * NeeView でファイル（またはフォルダ）を開く。
 * 起動できたかどうかだけ返し、終了は待たない。
 */
export function openInNeeView(exePath: string, target: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile(exePath, [target], (err) => {
      if (err) resolve(false);
    });
    child.unref();
    // 起動直後にエラーが来なければ成功とみなす（ビューアの終了は待たない）
    setTimeout(() => resolve(true), 300);
  });
}
