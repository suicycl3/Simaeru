import type { Repo } from '../db/repo';

/**
 * 店舗ページの自由記述の欄（DMM の PC ゲームの「ゲームジャンル」）で見た語の控え（設定 `stats.blurbTags`）。
 * ブランドが作品ごとに書く文句は形が決まっていないので、語の形ではなく「どの欄にあったか」で宣伝文句と分かるようにする。
 * 作品の詳細を取るたびに足していく。統計で数えないためだけに使い、ライブラリのタグはそのまま。
 */
export const BLURB_TAGS_SETTING = 'stats.blurbTags';
/** 控えの上限（古いほうから捨てる）。今の台帳で約 300 種 */
const LIMIT = 5000;

export function knownBlurbTags(repo: Pick<Repo, 'getSetting'>): string[] {
  try {
    const list = JSON.parse(repo.getSetting(BLURB_TAGS_SETTING) ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberBlurbTags(repo: Pick<Repo, 'getSetting' | 'setSetting'>, tags: string[] | undefined): void {
  const fresh = (tags ?? []).map((t) => t.trim()).filter(Boolean);
  if (fresh.length === 0) return;
  const known = knownBlurbTags(repo);
  const set = new Set(known);
  const added = fresh.filter((t) => !set.has(t));
  if (added.length === 0) return;
  repo.setSetting(BLURB_TAGS_SETTING, JSON.stringify([...known, ...added].slice(-LIMIT)));
}
