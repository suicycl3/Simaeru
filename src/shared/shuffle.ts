/**
 * 一覧の「シャッフル」の並び。
 *
 * 一覧はページごとに読み込むので、毎回 ORDER BY random() にすると続きのページで重複・抜けが出る。
 * 作品の id と種（seed）から決まる値で並べ、同じ種のあいだは何ページ読んでも同じ並びにする。
 * 種を変えると並びが変わる。本体（SQLite の関数 shuffle_key）と見本（devMock）の両方で使う
 */

/** 32bit の値をよく混ぜる（murmur3 の仕上げ） */
function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** id と種から、並べるための値（0〜2^32-1）を作る */
export function shuffleKey(id: number, seed: number): number {
  return mix32((id >>> 0) ^ mix32(seed >>> 0) ^ 0x9e3779b9);
}

/** 新しい種。シャッフルを選んだとき・「もう一度シャッフル」で作る */
export function newShuffleSeed(): number {
  return Math.floor(Math.random() * 0x1_0000_0000);
}
