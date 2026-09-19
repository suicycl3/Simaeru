import type { DgpGame, InstalledProgram, LinkCandidate, Product } from '@shared/types';
import { dgpKey, isDgpOnly, rankDgpGames } from './dmmGamePlayer';
import { scorePrograms } from './installService';

/**
 * 起動の紐付けができそうな相手を、まだ紐付けていない作品ごとに1つ探す（「紐付け候補あり」に数える）。
 * **紐付けはしない。** 決めるのはユーザー（DESIGN-download.md §3-7 の方針のまま）。
 *
 * - 「DMM GAMES PLAYER専用」の作品: DMM GAMES PLAYER に入っているゲームから
 * - それ以外のゲーム・ツール: 導入済みプログラム（Windows の「プログラムと機能」）から
 * すでに別の作品に紐付けている相手は候補にしない。
 */

/** DMM GAMES PLAYER のゲームを候補にする近さ（詳細の選択肢で「★近い」を付けるのと同じ） */
export const DGP_MIN_SCORE = 0.4;
/** 導入済みプログラムを候補にする近さ。名前が短く似ているだけのものを拾わないよう高めにする */
export const PROGRAM_MIN_SCORE = 0.6;

export function findLinkCandidates(
  targets: Array<Pick<Product, 'id' | 'title' | 'maker' | 'productId' | 'tags'>>,
  sources: {
    dgpGames: Omit<DgpGame, 'score'>[];
    programs: Omit<InstalledProgram, 'score'>[];
    /** すでに紐付けに使っている相手のキー */
    linkedKeys: Set<string>;
  }
): Map<number, LinkCandidate | null> {
  const dgpGames = sources.dgpGames.filter((g) => !sources.linkedKeys.has(dgpKey(g)));
  const programs = sources.programs.filter((p) => !sources.linkedKeys.has(p.key));
  const out = new Map<number, LinkCandidate | null>();
  for (const target of targets) {
    let candidate: LinkCandidate | null = null;
    if (isDgpOnly({ tags: target.tags, description: null })) {
      const best = rankDgpGames(dgpGames, target).reduce<DgpGame | null>((b, g) => (!b || g.score > b.score ? g : b), null);
      if (best && best.score >= DGP_MIN_SCORE) {
        candidate = { kind: 'dgp', name: (best.path ?? '').split(/[\\/]/).filter(Boolean).pop() ?? best.productId, score: round(best.score) };
      }
    } else {
      const best = scorePrograms(programs, target.title, target.maker)[0];
      if (best && best.score >= PROGRAM_MIN_SCORE) candidate = { kind: 'program', name: best.displayName, score: round(best.score) };
    }
    out.set(target.id, candidate);
  }
  return out;
}

const round = (n: number): number => Math.round(n * 100) / 100;
