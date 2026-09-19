import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import type { InstallAnalysis, InstalledProgram } from '@shared/types';
import { judgeInstall, titleSimilarity } from '@shared/contentRules';
import type { Repo } from '../db/repo';
import { walkFolder } from '../content/contentIndex';
import { isUnder } from '../content/localProtocol';
import { launchDgp } from './dmmGamePlayer';
import { t } from '@shared/i18n';

/**
 * PCゲーム・同人ゲームの「展開したあと」と、インストール管理（Phase 2）。
 * DESIGN-download.md §8 と、既存導入との紐付けは必ずユーザーが選ぶ方針
 * （同名でも購入元が違えば別物になり得るため）に沿う。
 *
 * **インストーラの自動実行・サイレントインストールはしない。** ボタンを押したときに
 * `shell.openPath` で起動するだけで、UAC や規約同意は通常どおりユーザーが操作する。
 */

/** 作品の展開済みフォルダ（とフォルダとして取り込んだもの）を解析する */
export async function analyzeProduct(repo: Repo, productRef: number): Promise<InstallAnalysis[]> {
  const out: InstallAnalysis[] = [];
  for (const f of repo.localFiles(productRef)) {
    // アーカイブ本体は開かない（大きな新しいファイルは Defender の検査を待たされる）。見るのはフォルダだけ
    if (f.missingAt || (f.kind !== null && f.kind !== 'folder')) continue;
    const stat = await fs.promises.stat(f.path).catch(() => null);
    if (!stat?.isDirectory()) continue;
    out.push(await analyzeFolder(f.path));
  }
  return out;
}

export async function analyzeFolder(folder: string): Promise<InstallAnalysis> {
  const judged = judgeInstall(await walkFolder(folder));
  const abs = (rel: string): string => path.join(folder, ...rel.split('/'));
  return {
    folder,
    type: judged.type,
    reasons: judged.reasons,
    installers: judged.installers.map((i) => ({ path: abs(i.rel), size: i.size })),
    executables: judged.executables.slice(0, 30).map((e) => ({ path: abs(e.rel), size: e.size, depth: e.depth })),
    htmlEntries: judged.htmlEntries.slice(0, 5).map(abs),
    readmes: judged.readmes.slice(0, 10).map(abs)
  };
}

/** 作品の手元のフォルダ配下にあるか（レンダラから渡されたパスをそのまま起動しないため） */
export function isProductPath(repo: Repo, productRef: number, target: string): boolean {
  const roots = repo
    .localFiles(productRef)
    .filter((f) => !f.missingAt)
    .map((f) => f.path);
  return isUnder(target, roots);
}

export async function runInstaller(repo: Repo, productRef: number, installer: string): Promise<string> {
  if (!['.exe', '.msi'].includes(path.extname(installer).toLowerCase())) {
    throw new Error(t('インストーラとして起動できないファイルです'));
  }
  if (!isProductPath(repo, productRef, installer)) throw new Error(t('この作品のファイルではありません'));
  return shell.openPath(installer);
}

// ── 導入済みプログラムの一覧（レジストリの Uninstall キー） ──

let programCache: { at: number; list: Omit<InstalledProgram, 'score'>[] } | null = null;

const PROGRAMS_SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$paths = @(
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$list = foreach ($p in $paths) {
  Get-ItemProperty $p -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -and -not $_.SystemComponent -and -not $_.ParentKeyName } |
    ForEach-Object {
      [pscustomobject]@{
        key = ($_.PSPath -replace '^Microsoft\\.PowerShell\\.Core\\\\Registry::', '')
        displayName = [string]$_.DisplayName
        publisher = [string]$_.Publisher
        installLocation = [string]$_.InstallLocation
        displayIcon = [string]$_.DisplayIcon
        version = [string]$_.DisplayVersion
      }
    }
}
ConvertTo-Json -Compress -InputObject @($list)
`;

export function readInstalledPrograms(): Promise<Omit<InstalledProgram, 'score'>[]> {
  if (programCache && Date.now() - programCache.at < 60_000) return Promise.resolve(programCache.list);
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PROGRAMS_SCRIPT],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(t('導入済みプログラムの一覧を読めませんでした: {0}', { 0: stderr.slice(0, 200) })));
      try {
        const raw = JSON.parse(stdout.trim() || '[]') as Array<Record<string, string>>;
        const seen = new Set<string>();
        const list = raw
          .map((r) => ({
            key: r.key,
            displayName: r.displayName,
            publisher: r.publisher || null,
            installLocation: r.installLocation || null,
            displayIcon: r.displayIcon || null,
            version: r.version || null
          }))
          .filter((r) => {
            const k = `${r.displayName}|${r.installLocation ?? ''}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        programCache = { at: Date.now(), list };
        resolve(list);
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** 作品名・ブランド名に近い順に並べる。**候補を出すだけで、決めるのはユーザー** */
export async function rankPrograms(title: string, maker: string | null): Promise<InstalledProgram[]> {
  return scorePrograms(await readInstalledPrograms(), title, maker);
}

/** 読んである一覧を、作品名・ブランド名に近い順に並べる（まとめて候補を探すときに一覧を読み直さない） */
export function scorePrograms(list: Omit<InstalledProgram, 'score'>[], title: string, maker: string | null): InstalledProgram[] {
  return list
    .map((p) => {
      const byTitle = titleSimilarity(title, p.displayName);
      const byMaker = maker && p.publisher ? titleSimilarity(maker, p.publisher) : 0;
      return { ...p, score: Math.min(1, byTitle + byMaker * 0.15) };
    })
    .sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName, 'ja'));
}

/** DisplayIcon（"C:\\Game\\game.exe,0" など）から実行ファイルを取り出す */
export function exeFromDisplayIcon(icon: string | null): string | null {
  if (!icon) return null;
  const cleaned = icon.replace(/^"|"$/g, '').replace(/,\s*-?\d+$/, '').replace(/^"|"$/g, '');
  return /\.exe$/i.test(cleaned) ? cleaned : null;
}

// ── 起動 ─────────────────────────────────────────────────

/**
 * 紐付けた実行ファイルを起動する。作業フォルダは exe の場所にする
 * （カレントに依存してデータを読むゲームが多い）。
 * 管理者権限を要求する exe は spawn では起動できないので、そのときは ShellExecute に回す（UAC が出る）。
 */
export async function launchProduct(repo: Repo, productRef: number): Promise<void> {
  const product = repo.getProduct(productRef);
  if (product?.installation?.kind === 'dmm_game_player') {
    await launchDgp(product.installation.uninstallKey);
    repo.markLaunched(productRef);
    return;
  }
  const exe = product?.installation?.executablePath;
  if (!exe) throw new Error(t('起動するファイルが紐付けられていません'));
  if (!(await fs.promises.stat(exe).catch(() => null))) throw new Error(t('起動するファイルが見つかりません: {exe}', { exe }));

  if (!/\.exe$/i.test(exe)) {
    // index.html（ブラウザで遊ぶ作品）や .bat などは既定のアプリで開く
    const err = await shell.openPath(exe);
    if (err) throw new Error(err);
    repo.markLaunched(productRef);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', (err: NodeJS.ErrnoException) => {
      // EACCES / 740(要昇格) は ShellExecute 経由でなら起動できる
      void shell.openPath(exe).then((msg) => (msg ? reject(new Error(msg)) : resolve()));
      void err;
    });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
  repo.markLaunched(productRef);
}
