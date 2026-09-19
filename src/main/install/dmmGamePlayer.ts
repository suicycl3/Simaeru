import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { shell } from 'electron';
import type { DgpGame, DgpStatus, Product } from '@shared/types';
import { titleSimilarity } from '@shared/contentRules';
import { t } from '@shared/i18n';

/**
 * DMM GAMES PLAYER 専用の作品を、DMM GAMES PLAYER に起動してもらう。
 *
 * DMM GAMES PLAYER は `dmmgameplayer://play/{gameType}/{productId}/{cl|main}/win` という URL を受け付ける
 * （本体の app.asar にある、ショートカット作成と同じ形。GCL/ACL は cl、GMAIN/AMAIN は main）。
 * この URL を OS に渡すだけにして、**DMM GAMES PLAYER のログイン情報（トークン）は読まない・使わない**。
 * 認証・更新・DRM の確認は DMM GAMES PLAYER がいつもどおり行う。
 *
 * 読むのは、どのゲームがどこに入っているかの設定ファイル（dmmgame.cnf）だけ。書き換えない。
 */

const PROTOCOL_KEY = 'HKCU\\Software\\Classes\\dmmgameplayer\\shell\\open\\command';
const PROTOCOL_KEY_MACHINE = 'HKLM\\Software\\Classes\\dmmgameplayer\\shell\\open\\command';

/** 「DMM GAMES PLAYER専用」の作品か（店舗ページのタグ・説明文から） */
export function isDgpOnly(product: Pick<Product, 'tags' | 'description'>): boolean {
  return product.tags.some((tItem) => tItem.includes('DMM GAMES PLAYER専用'));
}

function regQuery(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('reg.exe', ['query', key, '/ve'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('latin1')));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out : null));
  });
}

/** `"C:\...\DMMGamePlayer.exe" %1` や `C:\Program Files\...\DMMGamePlayer.exe %1` から exe を取り出す */
export function exeFromCommand(output: string | null): string | null {
  if (!output) return null;
  const m = output.match(/REG_(?:EXPAND_)?SZ\s+"?([^"\r\n]+?\.exe)"?(?:\s|$)/i);
  return m ? m[1].replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? `%${name}%`) : null;
}

export function dgpLaunchUrl(gameType: string, productId: string): string {
  const kind = /MAIN$/i.test(gameType) ? 'main' : 'cl';
  return `dmmgameplayer://play/${encodeURIComponent(gameType)}/${encodeURIComponent(productId)}/${kind}/win`;
}

function configPath(): string {
  return path.join(process.env.APPDATA ?? '', 'dmmgameplayer5', 'dmmgame.cnf');
}

interface CnfContent {
  productId?: string;
  gameType?: string;
  detail?: { path?: string | null; version?: string | null; installed?: boolean };
}

export async function readDgpGames(): Promise<Omit<DgpGame, 'score'>[]> {
  const text = await fs.readFile(configPath(), 'utf8');
  const json = JSON.parse(text) as { contents?: CnfContent[] };
  return (json.contents ?? [])
    .filter((c) => typeof c.productId === 'string' && typeof c.gameType === 'string')
    .map((c) => ({
      productId: c.productId!,
      gameType: c.gameType!,
      path: c.detail?.path ?? null,
      version: c.detail?.version ?? null,
      installed: c.detail?.installed !== false
    }));
}

/**
 * 作品に近い順。DMM GAMES PLAYER 側の ID（gp_xxxx など）は作品IDと別物で、
 * 名前もフォルダ名（例: SampleSoft_GameName）しか分からないので、ブランド名・作品IDの頭・タイトルで大まかに並べる。
 * **決めるのはユーザー。**
 */
export function rankDgpGames(games: Omit<DgpGame, 'score'>[], product: Pick<Product, 'title' | 'maker' | 'productId'> | null): DgpGame[] {
  const norm = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
  return games
    .map((g) => {
      if (!product) return { ...g, score: 0 };
      const folder = path.basename(g.path ?? '') || g.productId;
      const hay = norm(`${folder} ${g.productId}`);
      let score = titleSimilarity(product.title, folder) * 0.6;
      const maker = norm(product.maker ?? '');
      if (maker.length >= 3 && hay.includes(maker)) score += 0.4;
      const prefix = norm(product.productId.split('_')[0] ?? '');
      if (prefix.length >= 3 && hay.includes(prefix)) score += 0.2;
      return { ...g, score: Math.min(1, score) };
    })
    .sort((a, b) => {
      // PCゲーム（MAIN）を先に。クライアントゲーム（CL）はオンラインゲームなので後ろ
      const main = Number(/MAIN$/i.test(b.gameType)) - Number(/MAIN$/i.test(a.gameType));
      return main || b.score - a.score || a.productId.localeCompare(b.productId);
    });
}

export async function dgpStatus(product: Pick<Product, 'title' | 'maker' | 'productId'> | null): Promise<DgpStatus> {
  const exe =
    exeFromCommand(await regQuery(PROTOCOL_KEY)) ??
    exeFromCommand(await regQuery(PROTOCOL_KEY_MACHINE)) ??
    exeFromCommand(await regQuery('HKCR\\dmmgameplayer\\shell\\open\\command'));
  const exeExists = exe ? await fs.access(exe).then(() => true, () => false) : false;
  let games: DgpGame[] = [];
  let message: string | null = null;
  try {
    games = rankDgpGames(await readDgpGames(), product);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    message =
      code === 'ENOENT'
        ? t('DMM GAMES PLAYER にゲームが入っていません')
        : t('DMM GAMES PLAYER の設定を読めませんでした: {message}', { message: (err as Error).message });
  }
  if (!exe || !exeExists) message = t('DMM GAMES PLAYER が見つかりません（インストールされていないようです）');
  return { installed: !!exe && exeExists, exe: exeExists ? exe : null, games, message };
}

/** 紐付けの記録（installations.uninstall_key）に入れる形。`dgp:{gameType}:{productId}` */
export function dgpKey(game: Pick<DgpGame, 'gameType' | 'productId'>): string {
  return `dgp:${game.gameType}:${game.productId}`;
}

export function parseDgpKey(key: string | null): { gameType: string; productId: string } | null {
  const m = key?.match(/^dgp:([^:]+):(.+)$/);
  return m ? { gameType: m[1], productId: m[2] } : null;
}

/** DMM GAMES PLAYER に起動を頼む。入っていなければ理由を投げる */
export async function launchDgp(key: string | null): Promise<void> {
  const linked = parseDgpKey(key);
  if (!linked) throw new Error(t('DMM GAMES PLAYER のゲームが紐付けられていません'));
  const status = await dgpStatus(null);
  if (!status.installed) throw new Error(t('DMM GAMES PLAYER が見つかりません。インストールしてから起動してください。'));
  const game = status.games.find((g) => g.productId === linked.productId);
  if (!game) {
    throw new Error(t('DMM GAMES PLAYER にこのゲームが入っていません。DMM GAMES PLAYER でインストールしてください。'));
  }
  // 種別は DMM GAMES PLAYER 側の今の値を使う（紐付けたあとに変わっていても起動できるように）
  await shell.openExternal(dgpLaunchUrl(game.gameType, game.productId));
}

/** DMM GAMES PLAYER 本体を開く（ゲームのインストールはそちらで行う） */
export async function openDgp(): Promise<void> {
  const status = await dgpStatus(null);
  if (!status.exe) throw new Error(t('DMM GAMES PLAYER が見つかりません'));
  const err = await shell.openPath(status.exe);
  if (err) throw new Error(err);
}
