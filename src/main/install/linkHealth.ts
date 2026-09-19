import fs from 'node:fs';
import type { Repo } from '../db/repo';
import type { InstallKind, InstallState } from '@shared/types';
import { dgpKey, readDgpGames } from './dmmGamePlayer';

export interface LinkHealthTarget {
  productRef: number;
  kind: InstallKind;
  installPath: string | null;
  executablePath: string | null;
  uninstallKey: string | null;
  state: InstallState;
}

/**
 * 紐付けが生きているか。
 * - DMM GAMES PLAYER: dmmgame.cnf に同じゲームがあり、入っている（`installed` が false でない）こと。
 *   dmmgame.cnf が無い（DMM GAMES PLAYER ごと消した）ときも切れているとみなす。読めない（壊れている等）ときは判断しない
 * - それ以外: 起動ファイルがあればそれ、無ければインストール先のフォルダが残っていること
 * @returns 'installed' / 'broken'、判断できなければ null
 */
export function judgeLinkHealth(
  target: LinkHealthTarget,
  env: { exists: (p: string) => boolean; dgpKeys: Set<string> | 'missing' | null }
): 'installed' | 'broken' | null {
  if (target.kind === 'dmm_game_player') {
    if (env.dgpKeys === null) return null;
    if (env.dgpKeys === 'missing') return 'broken';
    return target.uninstallKey && env.dgpKeys.has(target.uninstallKey) ? 'installed' : 'broken';
  }
  const file = target.executablePath ?? target.installPath;
  if (!file) return null;
  return env.exists(file) ? 'installed' : 'broken';
}

/**
 * 紐付け済み・リンク切れの作品を見回り、状態を付け直す。
 * @returns 状態が変わった作品
 */
export async function refreshLinkHealth(repo: Repo): Promise<number[]> {
  const targets = repo.linkHealthTargets();
  if (targets.length === 0) return [];
  let dgpKeys: Set<string> | 'missing' | null = null;
  if (targets.some((tg) => tg.kind === 'dmm_game_player')) {
    try {
      dgpKeys = new Set((await readDgpGames()).filter((g) => g.installed).map((g) => dgpKey(g)));
    } catch (err) {
      dgpKeys = (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : null;
    }
  }
  // 同期の fs は Defender の照会で止まることがあるので、先に非同期で確かめておく
  const paths = [...new Set(targets.map((tg) => tg.executablePath ?? tg.installPath).filter((p): p is string => !!p))];
  const present = new Set<string>();
  await Promise.all(
    paths.map(async (p) => {
      if (await fs.promises.access(p).then(() => true, () => false)) present.add(p);
    })
  );
  const changed: number[] = [];
  for (const target of targets) {
    const next = judgeLinkHealth(target, { exists: (p) => present.has(p), dgpKeys });
    if (next && next !== target.state) {
      repo.setInstallationState(target.productRef, next);
      changed.push(target.productRef);
    }
  }
  return changed;
}
