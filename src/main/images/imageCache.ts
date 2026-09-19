import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app, net, protocol } from 'electron';
import type { Repo } from '../db/repo';
import { dmmSession } from '../sites/dmm/client';

export const COVER_SCHEME = 'libcover';

function coversDir(): string {
  const dir = path.join(app.getPath('userData'), 'covers');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** libcover://<filename> をローカルの covers ディレクトリから返す */
export function registerCoverProtocol(): void {
  protocol.handle(COVER_SCHEME, (request) => {
    const name = path.basename(decodeURIComponent(new URL(request.url).hostname || ''));
    const file = path.join(coversDir(), name);
    if (!name || !fs.existsSync(file)) return new Response('not found', { status: 404 });
    return net.fetch(`file://${file.replace(/\\/g, '/')}`);
  });
}

function fileNameFor(url: string): string {
  const hash = crypto.createHash('sha1').update(url).digest('hex');
  const ext = (url.match(/\.(jpe?g|png|webp|gif)(?:\?|$)/i)?.[1] ?? 'jpg').toLowerCase();
  return `${hash}.${ext}`;
}

async function download(url: string): Promise<Buffer | null> {
  try {
    const res = await dmmSession().fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

let running = false;

/**
 * 表紙画像をローカルへ落とす。一覧描画のたびに外部へ取りに行かないための先読みで、
 * 同期後にバックグラウンドで少しずつ進める。
 */
export async function cacheCovers(
  repo: Repo,
  onBatch: (done: number) => void,
  isCancelled: () => boolean = () => false
): Promise<void> {
  if (running) return;
  running = true;
  try {
    let done = 0;
    for (;;) {
      if (isCancelled()) break;
      const pending = repo.productsMissingCover(40);
      if (pending.length === 0) break;
      for (const row of pending) {
        if (isCancelled()) break;
        const name = fileNameFor(row.cover_url);
        const file = path.join(coversDir(), name);
        if (!fs.existsSync(file)) {
          const buf = await download(row.cover_url);
          if (!buf) {
            // 落とせなかった画像を毎回引き当てないよう、空文字で「試行済み」を記録する
            repo.setCoverFile(row.id, '');
            continue;
          }
          fs.writeFileSync(file, buf);
        }
        repo.setCoverFile(row.id, name);
        done++;
      }
      onBatch(done);
    }
  } finally {
    running = false;
  }
}

export function coverUrlFor(file: string | null): string | null {
  return file ? `${COVER_SCHEME}://${file}` : null;
}
