/**
 * 画像の一覧（サムネイル）用に縮めた画像を用意する。
 *
 * 一覧に原寸の画像を並べると、数千ピクセルの画像を何十枚も読んでは縮めることになり重かった。
 * - 置き場（メインプロセス側。アプリを閉じても残る）にあればそれを使う
 * - 無ければ元の画像を取ってきて縮め（デコードと縮小は createImageBitmap が裏のスレッドで行う）、置き場へ渡す
 * - 一度に縮めるのは 3 枚まで。後から頼まれたもの（いま画面に出てきたもの）を先にする
 * - 小さな画像はそのまま使う（縮めても軽くならない）
 * 縮められなかったときは元の URL を返す（一覧は今までどおり出る）。
 */

/** 縮めた画像の高さ（一覧の枠は 180px。高精細の画面でも粗く見えないよう 2 倍） */
export const THUMB_HEIGHT = 360;
/** 縮めた画像の幅の上限（横長の画像が大きくなりすぎないように） */
export const THUMB_MAX_WIDTH = 480;
/** これより小さいファイルはそのまま使う */
export const THUMB_MIN_SOURCE_BYTES = 200 * 1024;
const PARALLEL = 3;
/** 作ったものを覚えておく枚数（ビューアを開き直しても作り直さない） */
const MEMORY_LIMIT = 1500;

type Job = { url: string; resolve: (v: string) => void; canceled: boolean };

const made = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
const waiting: Job[] = [];
let running = 0;

/** 縮めた画像の URL（blob:）。小さい画像・縮められない画像は元の URL */
export function thumbnailUrl(url: string, size: number, signal?: AbortSignal): Promise<string> {
  if (size > 0 && size < THUMB_MIN_SOURCE_BYTES) return Promise.resolve(url);
  const hit = made.get(url);
  if (hit) {
    made.delete(url);
    made.set(url, hit);
    return Promise.resolve(hit);
  }
  const pending = inflight.get(url);
  if (pending) return pending;
  const job: Job = { url, resolve: () => undefined, canceled: false };
  const done = new Promise<string>((resolve) => {
    job.resolve = resolve;
  }).finally(() => inflight.delete(url));
  inflight.set(url, done);
  // 画面から外れたら、まだ始まっていなければ取りやめる（元の URL を返す）
  signal?.addEventListener('abort', () => {
    const i = waiting.indexOf(job);
    if (i < 0) return;
    waiting.splice(i, 1);
    job.canceled = true;
    job.resolve(url);
  });
  waiting.push(job);
  pump();
  return done;
}

function pump(): void {
  while (running < PARALLEL && waiting.length > 0) {
    // 後から頼まれたもの（いまスクロールして出てきたもの）から
    const job = waiting.pop() as Job;
    running++;
    void make(job.url)
      .then((made) => job.resolve(made), () => job.resolve(job.url))
      .finally(() => {
        running--;
        pump();
      });
  }
}

async function make(url: string): Promise<string> {
  const stored = await window.api.thumbs.get(url).catch(() => null);
  if (stored) return remember(url, new Blob([stored as BlobPart], { type: mimeOf(stored) }));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const small = await shrink(blob);
  const bytes = new Uint8Array(await small.arrayBuffer());
  void window.api.thumbs.put(url, bytes).catch(() => undefined);
  return remember(url, small);
}

/** 高さ THUMB_HEIGHT（幅は THUMB_MAX_WIDTH まで）に縮めて WebP にする。透過はそのまま残る */
export async function shrink(blob: Blob): Promise<Blob> {
  let bitmap = await createImageBitmap(blob, { resizeHeight: THUMB_HEIGHT, resizeQuality: 'medium' });
  try {
    let { width, height } = bitmap;
    if (width > THUMB_MAX_WIDTH) {
      height = Math.max(1, Math.round((height * THUMB_MAX_WIDTH) / width));
      width = THUMB_MAX_WIDTH;
      const narrower = await createImageBitmap(bitmap, { resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' });
      bitmap.close();
      bitmap = narrower;
    }
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context is not available');
    ctx.drawImage(bitmap, 0, 0);
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
  } finally {
    bitmap.close();
  }
}

function remember(url: string, blob: Blob): string {
  const objectUrl = URL.createObjectURL(blob);
  made.set(url, objectUrl);
  while (made.size > MEMORY_LIMIT) {
    const [oldest, oldUrl] = made.entries().next().value as [string, string];
    made.delete(oldest);
    URL.revokeObjectURL(oldUrl);
  }
  return objectUrl;
}

function mimeOf(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  return 'image/webp';
}
