import { APP_NAME } from '@shared/appInfo';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { InstalledToolInfo, ToolInstallProgress, ToolName } from '@shared/types';
import { isReadable, openEntry, readZipIndex } from '../archive/zipReader';
import { clearToolCache } from './externalTools';
import { applyNeeViewDefaults, isNeeViewRunning } from '../viewer/neeviewSettings';
import { getLang, t } from '@shared/i18n';

/**
 * 設定画面の「自動で入れる」。配布元の GitHub リリースから取得して userData/tools 配下に置く。
 *
 * | ツール | 取得元 | 取るもの |
 * |---|---|---|
 * | ffmpeg | BtbN/FFmpeg-Builds | `ffmpeg-n<版>-latest-win64-lgpl-shared-<版>.zip`（LGPL 版。bin だけ取り出す） |
 * | NeeView | neelabo/NeeView | `NeeView<版>.zip`（.NET 同梱の自己完結版） |
 * | 7-Zip | ip7z/7zip | `7zr.exe` と `7z<版>-x64.exe`。後者はインストーラを**実行せず**、7zr で中身だけ取り出す |
 *
 * **sha256 を照合できないものは入れない。** GitHub がアセットごとに付けている digest と突き合わせる。
 * 置き場所は `tools/<名前>.installing` に作ってから入れ替えるので、途中で落ちても前の版は壊れない。
 */

const API = 'https://api.github.com/repos';

export interface ReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
  digest?: string | null;
}

interface Release {
  tag_name: string;
  assets: ReleaseAsset[];
}

interface ToolSpec {
  label: string;
  releaseUrl: string;
  /** 取得するアセット（1〜2本） */
  pick: (assets: ReleaseAsset[]) => ReleaseAsset[];
  version: (release: Release, picked: ReleaseAsset[]) => string;
  /** 取得したファイルから dest を作る */
  install: (files: Map<string, string>, dest: string, work: string) => Promise<void>;
  /** 入れたあとに必ずあるはずのファイル */
  expect: string[];
}

function versionOf(name: string): number[] {
  return (name.match(/\d+/g) ?? []).map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
  ffmpeg: {
    label: 'ffmpeg (LGPL)',
    releaseUrl: `${API}/BtbN/FFmpeg-Builds/releases/tags/latest`,
    pick: (assets) => {
      const candidates = assets
        .filter((a) => /^ffmpeg-n\d+(\.\d+)*-latest-win64-lgpl-shared-[\d.]+\.zip$/.test(a.name))
        .sort((a, b) => compareVersions(versionOf(b.name), versionOf(a.name)));
      return candidates.slice(0, 1);
    },
    version: (_r, picked) => /-lgpl-shared-([\d.]+)\.zip$/.exec(picked[0]?.name ?? '')?.[1] ?? 'latest',
    install: async (files, dest) => {
      const zip = [...files.values()][0];
      // bin の中身（exe と DLL）とライセンス表記だけを取り出す
      await extractZip(zip, dest, (name) => {
        const m = /^[^/]+\/bin\/([^/]+)$/.exec(name);
        if (m) return m[1];
        const lic = /^[^/]+\/(LICENSE[^/]*)$/i.exec(name);
        return lic ? lic[1] : null;
      });
    },
    expect: ['ffmpeg.exe', 'ffprobe.exe']
  },
  neeview: {
    label: 'NeeView',
    releaseUrl: `${API}/neelabo/NeeView/releases/latest`,
    pick: (assets) => assets.filter((a) => /^NeeView[\d.]+\.zip$/.test(a.name)).slice(0, 1),
    version: (r) => r.tag_name,
    install: async (files, dest) => {
      const zip = [...files.values()][0];
      const index = await readZipIndex(zip);
      // 全体が1つのフォルダに入っていれば、その中身を直下に置く
      const tops = new Set(index.entries.map((e) => e.name.split('/')[0]));
      const single = tops.size === 1 && index.entries.some((e) => e.name.includes('/')) ? [...tops][0] : null;
      await extractZip(zip, dest, (name) => (single ? (name.startsWith(`${single}/`) ? name.slice(single.length + 1) || null : null) : name));
    },
    expect: ['NeeView.exe']
  },
  sevenZip: {
    label: '7-Zip',
    releaseUrl: `${API}/ip7z/7zip/releases/latest`,
    pick: (assets) => {
      const sfx = assets.filter((a) => /^7z\d+-x64\.exe$/.test(a.name)).slice(0, 1);
      const zr = assets.filter((a) => a.name === '7zr.exe');
      return [...zr, ...sfx];
    },
    version: (r) => r.tag_name,
    install: async (files, dest, work) => {
      const zr = files.get('7zr.exe');
      const installer = [...files.entries()].find(([n]) => n !== '7zr.exe')?.[1];
      if (!zr || !installer) throw new Error(t('7-Zip の取得物が揃っていません'));
      // インストーラは実行しない。中身（7z.exe / 7z.dll など）を 7zr で取り出すだけ
      await runProcess(zr, ['x', '-y', `-o${dest}`, installer], work);
    },
    expect: ['7z.exe', '7z.dll']
  }
};

export interface ToolInstallerOptions {
  toolsDir: string;
  workDir: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  onProgress: (p: ToolInstallProgress) => void;
  /** テスト用: API の URL を差し替える */
  specs?: Partial<Record<ToolName, ToolSpec>>;
}

export class ToolInstaller {
  private busy = new Set<ToolName>();

  constructor(private opts: ToolInstallerOptions) {}

  private spec(tool: ToolName): ToolSpec {
    return this.opts.specs?.[tool] ?? TOOL_SPECS[tool];
  }

  async installed(tool: ToolName): Promise<InstalledToolInfo | null> {
    try {
      const raw = await fs.readFile(path.join(this.opts.toolsDir, folderOf(tool), 'installed.json'), 'utf8');
      return JSON.parse(raw) as InstalledToolInfo;
    } catch {
      return null;
    }
  }

  /** 取得前に「何を・どれくらい」落とすかを見せるための情報 */
  async plan(tool: ToolName): Promise<{ version: string; assets: Array<{ name: string; size: number }>; source: string }> {
    const spec = this.spec(tool);
    const release = await this.release(spec);
    const picked = spec.pick(release.assets);
    if (picked.length === 0) throw new Error(t('{label} の配布ファイルが見つかりませんでした', { label: spec.label }));
    return {
      version: spec.version(release, picked),
      assets: picked.map((a) => ({ name: a.name, size: a.size })),
      source: spec.releaseUrl.replace(`${API}/`, 'github.com/').replace(/\/releases.*$/, '')
    };
  }

  async install(tool: ToolName): Promise<InstalledToolInfo> {
    if (this.busy.has(tool)) throw new Error(t('取得中です'));
    // 起動中の NeeView は、入れ替えられない（ファイルが使用中）うえ、終了時に古い設定を書き戻す
    if (tool === 'neeview' && (await isNeeViewRunning())) throw new Error(t('NeeView を終了してから、もう一度お試しください。'));
    this.busy.add(tool);
    const spec = this.spec(tool);
    const report = (p: Omit<ToolInstallProgress, 'tool'>): void => this.opts.onProgress({ tool, ...p });
    const work = path.join(this.opts.workDir, `tool-${tool}-${Date.now()}`);
    const dest = path.join(this.opts.toolsDir, folderOf(tool));
    const staging = `${dest}.installing`;
    try {
      report({ phase: 'resolving', receivedBytes: 0, totalBytes: null, message: t('配布元を確認しています') });
      const release = await this.release(spec);
      const picked = spec.pick(release.assets);
      if (picked.length === 0) throw new Error(t('{label} の配布ファイルが見つかりませんでした', { label: spec.label }));
      const version = spec.version(release, picked);
      for (const a of picked) {
        if (!a.digest || !/^sha256:[0-9a-f]{64}$/i.test(a.digest)) {
          throw new Error(t('{name} にチェックサムが付いていないため、安全に確かめられません。取得を中止しました。', { name: a.name }));
        }
      }

      await fs.mkdir(work, { recursive: true });
      const total = picked.reduce((s, a) => s + a.size, 0);
      let received = 0;
      const files = new Map<string, string>();
      const hashes: string[] = [];
      for (const asset of picked) {
        const file = path.join(work, asset.name);
        const hash = await this.download(asset.browser_download_url, file, (n) => {
          received += n;
          report({ phase: 'downloading', receivedBytes: received, totalBytes: total, message: t('{name} を取得中', { name: asset.name }), version });
        });
        report({ phase: 'verifying', receivedBytes: received, totalBytes: total, message: t('{name} を照合中', { name: asset.name }), version });
        const expected = asset.digest!.slice(7).toLowerCase();
        if (hash !== expected) {
          throw new Error(t('{name} のチェックサムが一致しません（改ざん・破損の可能性）。取得を中止しました。', { name: asset.name }));
        }
        files.set(asset.name, file);
        hashes.push(`${asset.name}:${hash}`);
      }

      report({ phase: 'extracting', receivedBytes: total, totalBytes: total, message: t('展開しています'), version });
      await fs.rm(staging, { recursive: true, force: true });
      await fs.mkdir(staging, { recursive: true });
      await spec.install(files, staging, work);
      for (const name of spec.expect) {
        await fs.access(path.join(staging, name)).catch(() => {
          throw new Error(t('{name} が見つかりません（配布物の構成が変わった可能性があります）', { name }));
        });
      }
      const info: InstalledToolInfo = {
        tool,
        version,
        source: picked.map((a) => a.browser_download_url).join(' '),
        sha256: hashes.join(' '),
        installedAt: Date.now()
      };
      await fs.writeFile(path.join(staging, 'installed.json'), JSON.stringify(info, null, 1), 'utf8');
      if (tool === 'neeview') {
        // 入れ直し・更新で、NeeView 側で変えた設定（Profile）を消さない
        const profile = path.join(dest, 'Profile');
        if (await fs.access(profile).then(() => true, () => false)) await fs.rename(profile, path.join(staging, 'Profile'));
      }
      await fs.rm(dest, { recursive: true, force: true });
      await fs.rename(staging, dest);
      if (tool === 'neeview') {
        // 初めて入れたときは、見開き・サブフォルダーを読み込む設定で始める（設定ファイルがあれば触らない）
        await applyNeeViewDefaults(path.join(dest, 'NeeView.exe'), { onlyCreate: true, language: getLang() }).catch((err: unknown) =>
          console.warn('[tools] NeeView の初期設定を作れませんでした:', err)
        );
      }
      clearToolCache();
      report({ phase: 'done', receivedBytes: total, totalBytes: total, message: t('{label} {version} を入れました', { label: spec.label, version }), version });
      return info;
    } catch (err) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      const message = err instanceof Error ? err.message : String(err);
      report({ phase: 'error', receivedBytes: 0, totalBytes: null, message });
      throw err;
    } finally {
      this.busy.delete(tool);
      await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async uninstall(tool: ToolName): Promise<void> {
    await fs.rm(path.join(this.opts.toolsDir, folderOf(tool)), { recursive: true, force: true });
    clearToolCache();
  }

  private async release(spec: ToolSpec): Promise<Release> {
    const res = await this.opts.fetch(spec.releaseUrl, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': APP_NAME }
    });
    if (!res.ok) throw new Error(t('配布元の情報を取得できませんでした（HTTP {status}）', { status: res.status }));
    return (await res.json()) as Release;
  }

  /** ディスクへ流しながら sha256 を計算する（メモリに載せない） */
  private async download(url: string, file: string, onChunk: (n: number) => void): Promise<string> {
    const res = await this.opts.fetch(url, { headers: { 'User-Agent': APP_NAME } });
    if (!res.ok || !res.body) throw new Error(t('取得に失敗しました（HTTP {status}）', { status: res.status }));
    const hash = crypto.createHash('sha256');
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        onChunk(chunk.length);
        cb(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream), tap, createWriteStream(file));
    return hash.digest('hex');
  }
}

function folderOf(tool: ToolName): string {
  return tool === 'sevenZip' ? '7zip' : tool === 'neeview' ? 'NeeView' : 'ffmpeg';
}

/**
 * zip を展開する。rename が null を返したエントリは取り出さない。
 * 「..」でフォルダの外へ出るエントリは拒否する（zip slip 対策）。
 */
export async function extractZip(zip: string, dest: string, rename: (name: string) => string | null): Promise<number> {
  const index = await readZipIndex(zip);
  const root = path.resolve(dest);
  let count = 0;
  for (const entry of index.entries) {
    if (entry.isDir) continue;
    const rel = rename(entry.name);
    if (!rel) continue;
    const target = path.resolve(root, ...rel.split('/'));
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(t('不正なパスを含む zip です: {name}', { name: entry.name }));
    if (!isReadable(entry)) throw new Error(t('この zip の圧縮方式には対応していません: {name}', { name: entry.name }));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await pipeline(await openEntry(zip, entry), createWriteStream(target));
    count++;
  }
  return count;
}

function runProcess(exe: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(t('展開に失敗しました（code={code}）: {1}', { code, 1: stderr.slice(0, 200) })))));
  });
}
