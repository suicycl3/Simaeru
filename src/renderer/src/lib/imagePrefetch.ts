/**
 * 画像ビューアの先読み（NeeView の先読みにならう）。
 *
 * 以前は前後 3 ページを `new Image().src` で取りに行くだけで、表示できる形にする（デコード）のはめくった時だった。
 * 大きな画像では、めくった瞬間に一瞬待たされていた。
 * - 近い順に読む: 進む向きの次の見開き → 戻る向きの見開き → さらに先 …
 * - デコードまで済ませて持っておく。同じ画面の <img> は、同じ URL なら読み直さずにこれを使う（実測）
 * - 一度に読むのは 2 枚まで（いま表示するページの読み込みを邪魔しない）
 * - ページを飛ばしたら、範囲から外れたものは読みかけでも手放す
 */

/** 進む向きに先読みするページ数（見開きでもページ単位で数える） */
export const PREFETCH_AHEAD = 5;
/** 戻る向きに先読みするページ数 */
export const PREFETCH_BEHIND = 2;
/** 先読みで持っておくファイルの大きさの合計の上限（いちばん近い 1 枚は上限を超えても読む） */
export const PREFETCH_BYTES = 200 * 1024 * 1024;

/**
 * 先読みする順番（ページ番号）。いま出ているページは含めない。
 * @param dir 最後にめくった向き（1 = 進む、-1 = 戻る）
 */
export function prefetchOrder(page: number, step: number, count: number, dir: 1 | -1, sizes?: (i: number) => number): number[] {
  const ahead: number[] = [];
  const behind: number[] = [];
  // 進む向き: いま出ている見開きの次から
  for (let k = 0; k < PREFETCH_AHEAD; k++) ahead.push(dir > 0 ? page + step + k : page - 1 - k);
  for (let k = 0; k < PREFETCH_BEHIND; k++) behind.push(dir > 0 ? page - 1 - k : page + step + k);
  // 次の見開き → 前の見開き → 残りの先 → 残りの後ろ
  const order = [...ahead.slice(0, step), ...behind.slice(0, step), ...ahead.slice(step), ...behind.slice(step)];
  const seen = new Set<number>();
  const out: number[] = [];
  let bytes = 0;
  for (const i of order) {
    if (i < 0 || i >= count || seen.has(i)) continue;
    seen.add(i);
    const size = sizes?.(i) ?? 0;
    if (out.length > 0 && bytes + size > PREFETCH_BYTES) break;
    bytes += size;
    out.push(i);
  }
  return out;
}

export class ImagePrefetcher {
  /** 読み込み中・読み終えたもの（URL → 画像）。持っている間は、ブラウザがデコード済みのまま置いておく */
  private held = new Map<string, HTMLImageElement>();
  private queue: string[] = [];
  private running = 0;

  constructor(private readonly parallel = 2) {}

  /** 先読みしておきたい URL を近い順に渡す。前に渡して今回含まれないものは手放す */
  want(urls: string[]): void {
    const keep = new Set(urls);
    for (const [url, img] of this.held) {
      if (keep.has(url)) continue;
      this.held.delete(url);
      // 読みかけなら止める（src を外すと、その読み込みは打ち切られる）
      if (!img.complete) img.removeAttribute('src');
    }
    this.queue = urls.filter((u) => !this.held.has(u));
    this.pump();
  }

  /** いま持っているか（テスト・確認用） */
  has(url: string): boolean {
    return this.held.has(url);
  }

  clear(): void {
    this.want([]);
  }

  private pump(): void {
    while (this.running < this.parallel && this.queue.length > 0) {
      const url = this.queue.shift() as string;
      const img = new Image();
      img.decoding = 'async';
      this.held.set(url, img);
      this.running++;
      img.src = url;
      img
        .decode()
        .catch(() => {
          // 読めなかったものは持たない（表示するときに、表示側がやり直す）
          if (this.held.get(url) === img) this.held.delete(url);
        })
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }
}
