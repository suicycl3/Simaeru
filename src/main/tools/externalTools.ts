import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolSource, ToolStatus } from '@shared/types';

/**
 * 外部ツール（7-Zip / ffmpeg / NeeView）の場所を探す。
 *
 * どれも**アプリには同梱しない**。リンクせず別プロセスで呼ぶだけにして、ライセンスをアプリ側に持ち込まない。
 * 探す順番:
 *  1. 設定で指定したパス
 *  2. 設定画面から入れたもの（userData/tools 配下）
 *  3. PC にインストール済みのもの（Program Files / PATH）
 */

const cache = new Map<string, string | null>();

/** PATH 上のコマンドを探す（where.exe）。見つからなければ null */
function which(command: string): string | null {
  try {
    const res = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (res.status !== 0) return null;
    const first = res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && fs.existsSync(l));
    return first ?? null;
  } catch {
    return null;
  }
}

function firstExisting(candidates: Array<string | undefined>): string | null {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function programDirs(): string[] {
  return [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['ProgramW6432']].filter(
    (d): d is string => !!d
  );
}

/** 設定画面から入れたツールの置き場所 */
export function bundledPaths(toolsDir: string): { sevenZip: string; ffmpeg: string; ffprobe: string; neeview: string } {
  return {
    sevenZip: path.join(toolsDir, '7zip', '7z.exe'),
    ffmpeg: path.join(toolsDir, 'ffmpeg', 'ffmpeg.exe'),
    ffprobe: path.join(toolsDir, 'ffmpeg', 'ffprobe.exe'),
    neeview: path.join(toolsDir, 'NeeView', 'NeeView.exe')
  };
}

function resolve(
  key: string,
  configured: string | null | undefined,
  bundled: string | null,
  system: () => string | null
): { path: string | null; source: ToolSource } {
  if (configured && fs.existsSync(configured)) return { path: configured, source: 'configured' };
  if (bundled && fs.existsSync(bundled)) return { path: bundled, source: 'bundled' };
  if (!cache.has(key)) cache.set(key, system());
  const found = cache.get(key) ?? null;
  return { path: found, source: found ? 'system' : null };
}

export function findSevenZip(configured?: string | null, toolsDir?: string): string | null {
  return resolveSevenZip(configured, toolsDir).path;
}

function resolveSevenZip(configured?: string | null, toolsDir?: string): { path: string | null; source: ToolSource } {
  return resolve('7z', configured, toolsDir ? bundledPaths(toolsDir).sevenZip : null, () =>
    firstExisting(programDirs().map((d) => path.join(d, '7-Zip', '7z.exe'))) ?? which('7z')
  );
}

function resolveFfmpeg(configured?: string | null, toolsDir?: string): { path: string | null; source: ToolSource } {
  const local = process.env.LOCALAPPDATA;
  return resolve('ffmpeg', configured, toolsDir ? bundledPaths(toolsDir).ffmpeg : null, () =>
    which('ffmpeg') ??
    firstExisting([
      local ? path.join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe') : undefined,
      ...programDirs().map((d) => path.join(d, 'ffmpeg', 'bin', 'ffmpeg.exe'))
    ])
  );
}

export function findFfmpeg(configured?: string | null, toolsDir?: string): string | null {
  return resolveFfmpeg(configured, toolsDir).path;
}

/** ffprobe は ffmpeg の隣にあることが多い。無ければ PATH を見る */
export function findFfprobe(ffmpeg: string | null): string | null {
  if (ffmpeg) {
    const sibling = path.join(path.dirname(ffmpeg), 'ffprobe.exe');
    if (fs.existsSync(sibling)) return sibling;
  }
  if (!cache.has('ffprobe')) cache.set('ffprobe', which('ffprobe'));
  return cache.get('ffprobe') ?? null;
}

function resolveNeeView(configured?: string | null, toolsDir?: string): { path: string | null; source: ToolSource } {
  return resolve('neeview', configured, toolsDir ? bundledPaths(toolsDir).neeview : null, () => {
    const dirs = [...programDirs(), process.env.LOCALAPPDATA, process.env.APPDATA].filter((d): d is string => !!d);
    return firstExisting(
      dirs.flatMap((d) => [path.join(d, 'NeeView', 'NeeView.exe'), path.join(d, 'Programs', 'NeeView', 'NeeView.exe')])
    );
  });
}

export function findNeeView(configured?: string | null, toolsDir?: string): string | null {
  return resolveNeeView(configured, toolsDir).path;
}

export function toolStatus(
  settings: { sevenZipPath?: string; ffmpegPath?: string; neeviewPath?: string },
  toolsDir?: string
): ToolStatus {
  const sevenZip = resolveSevenZip(settings.sevenZipPath, toolsDir);
  const ffmpeg = resolveFfmpeg(settings.ffmpegPath, toolsDir);
  const neeview = resolveNeeView(settings.neeviewPath, toolsDir);
  return {
    sevenZip: sevenZip.path,
    ffmpeg: ffmpeg.path,
    ffprobe: findFfprobe(ffmpeg.path),
    neeview: neeview.path,
    sources: { sevenZip: sevenZip.source, ffmpeg: ffmpeg.source, neeview: neeview.source },
    toolsDir: toolsDir ?? null
  };
}

/** 設定を変えた・ツールを入れたときに探し直させる */
export function clearToolCache(): void {
  cache.clear();
}
