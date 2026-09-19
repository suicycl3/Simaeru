import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { t } from '@shared/i18n';
import { exeFromCommand } from './dmmGamePlayer';

/**
 * DMM Player（動画の公式プレイヤー）。ダウンロードした DRM 付きの動画（.dcv）は、これで開く。
 * 入っているかは .dcv の関連付け（HKCR\.dcv → ProgID → shell\open\command）で調べる。
 * **アプリでは復号しない。** ファイルを DMM Player に渡すだけ。
 */

export interface DmmPlayerStatus {
  installed: boolean;
  exe: string | null;
}

/** DMM Player に渡すファイル */
export const DMM_PLAYER_FILE = /\.(dcv|dmmmp4)$/i;

/** reg.exe の出力（コンソールのコードページ）を読む。日本語のパスが化けないよう Shift_JIS として読む */
function regQueryValue(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('reg.exe', ['query', key, '/ve'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      const buf = Buffer.concat(chunks);
      try {
        resolve(new TextDecoder('shift_jis').decode(buf));
      } catch {
        resolve(buf.toString('utf8'));
      }
    });
  });
}

/** `(既定)    REG_SZ    DMM.Player.v2.dcv` から値を取り出す */
export function regDefaultValue(output: string | null): string | null {
  const m = output?.match(/REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

const exists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false);

export async function dmmPlayerStatus(): Promise<DmmPlayerStatus> {
  const candidates: string[] = [];
  const progId = regDefaultValue(await regQueryValue('HKCR\\.dcv'));
  if (progId) {
    const exe = exeFromCommand(await regQueryValue(`HKCR\\${progId}\\shell\\open\\command`));
    if (exe) candidates.push(exe);
  }
  // 関連付けが外れていても、既定の場所に入っていれば使う
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'DMM Player v2', 'DMM Player v2.exe'));
  for (const exe of candidates) {
    if (await exists(exe)) return { installed: true, exe };
  }
  return { installed: false, exe: null };
}

/** DMM Player でファイルを開く */
export async function openInDmmPlayer(filePath: string): Promise<void> {
  const status = await dmmPlayerStatus();
  if (!status.exe) throw new Error(t('DMM Player が見つかりません。DMM の公式サイトから DMM Player を入れてください。'));
  if (!(await exists(filePath))) throw new Error(t('ファイルが見つかりません: {path}', { path: filePath }));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(status.exe!, [filePath], { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
