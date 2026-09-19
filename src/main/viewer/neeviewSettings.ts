import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * NeeView の初期設定（見開き・サブフォルダーを読み込む）。
 *
 * ZIP 版の NeeView は、`NeeView.settings.json` の `UseLocalApplicationData` が false なら
 * exe の隣の `Profile\UserSetting.json` に設定を持つ（46.3 で確認）。
 * - 見開き: `Config.BookSetting.PageMode = "WidePage"`
 * - サブフォルダーを読み込む: `Config.BookSetting.IsRecursiveFolder = true`
 * `BookSetting` は開いている本の設定、`BookSettingDefault` は新しく開く本の既定なので、両方に入れる。
 *
 * NeeView は `Format`（例 `NeeView/46.3.4312`）が無い設定ファイルを読まない（例外になる）ので、exe の版から作る。
 * NeeView は終了するときに設定を書き戻すので、起動中は書かない。
 */

export const NEEVIEW_BOOK_DEFAULTS = { PageMode: 'WidePage', IsRecursiveFolder: true } as const;

export type NeeViewDefaultsResult = 'created' | 'merged' | 'unchanged';

/** 設定ファイルの場所。ZIP 版の置き方でなければ null（インストーラ版は触らない） */
export async function neeViewSettingFile(exe: string): Promise<string | null> {
  const dir = path.dirname(exe);
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'NeeView.settings.json'), 'utf8')) as { UseLocalApplicationData?: boolean };
    if (raw.UseLocalApplicationData !== false) return null;
  } catch {
    return null;
  }
  return path.join(dir, 'Profile', 'UserSetting.json');
}

/** exe の版情報（FileVersion）から、設定ファイルの Format を作る。例: `NeeView/46.3.4312` */
export async function neeViewFormat(exe: string): Promise<string | null> {
  const buf = await fs.readFile(exe);
  const key = Buffer.from('FileVersion\0', 'utf16le');
  const at = buf.indexOf(key);
  if (at < 0) return null;
  const tail = buf.subarray(at + key.length, at + key.length + 96).toString('utf16le');
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(tail);
  return m ? `NeeView/${m[1]}.${m[2]}.${m[3]}` : null;
}

/** NeeView が起動中か */
export function isNeeViewRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq NeeView.exe', '/NH'], { windowsHide: true }, (err, stdout) => {
      resolve(!err && /NeeView\.exe/i.test(stdout));
    });
  });
}

/**
 * 見開き・サブフォルダーを読み込む設定を入れる。
 * 設定ファイルが無ければ作り、あれば2つの項目だけを書き換える（ほかの設定はそのまま）。
 */
export async function applyNeeViewDefaults(
  exe: string,
  opts: { onlyCreate?: boolean; language?: string } = {}
): Promise<NeeViewDefaultsResult> {
  const file = await neeViewSettingFile(exe);
  if (!file) throw new Error('unsupported');
  let current: Record<string, unknown> | null = null;
  try {
    current = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (!current) {
    const format = await neeViewFormat(exe);
    if (!format) throw new Error('format');
    const created = {
      Format: format,
      Config: {
        // 言語を入れないと、NeeView は起動した環境の言語で始まる（アプリと合わせる）
        ...(opts.language ? { System: { Language: opts.language } } : {}),
        BookSetting: { ...NEEVIEW_BOOK_DEFAULTS },
        BookSettingDefault: { ...NEEVIEW_BOOK_DEFAULTS }
      }
    };
    await writeJson(file, created);
    return 'created';
  }

  // 入れたときは、すでにある設定（入れ直し・更新で引き継いだもの）を変えない
  if (opts.onlyCreate) return 'unchanged';
  const config = (current.Config ??= {}) as Record<string, Record<string, unknown>>;
  let changed = false;
  for (const section of ['BookSetting', 'BookSettingDefault']) {
    const target = (config[section] ??= {});
    for (const [k, v] of Object.entries(NEEVIEW_BOOK_DEFAULTS)) {
      if (target[k] !== v) {
        target[k] = v;
        changed = true;
      }
    }
  }
  if (!changed) return 'unchanged';
  await writeJson(file, current);
  return 'merged';
}

/** NeeView と同じ形（2 字下げ・CRLF・BOM なし）で、作業用の名前に書いてから置き換える */
async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const text = JSON.stringify(data, null, 2).replace(/\n/g, '\r\n');
  const temp = `${file}.writing`;
  await fs.writeFile(temp, text, 'utf8');
  await fs.rename(temp, file);
}
