import fs from 'node:fs';
import path from 'node:path';
import { protocol } from 'electron';
import { entryResponse, fileResponse } from '../archive/archiveAccess';
import { retryTransient } from '../fsRetry';

/**
 * 手元のファイルをレンダラ（プレイヤー・ビューア）に読ませるためのスキーム。
 *
 *   mylib://f/<base64url(実パス)>                     … ファイル（Range 対応。音声のシークに要る）
 *   mylib://a/<base64url(アーカイブ)>/<base64url(中のパス)> … アーカイブの中の1ファイル（7-Zip で流す）
 *
 * **台帳（local_files）に載っているパスとその配下しか読ませない。**
 * レンダラから任意のファイルを読めてしまうと、ページに不正な内容が紛れたときの被害が大きいため。
 */

export const LOCAL_SCHEME = 'mylib';

export const LOCAL_SCHEME_PRIVILEGES = {
  scheme: LOCAL_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
};

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');

export function fileUrl(absPath: string): string {
  return `${LOCAL_SCHEME}://f/${b64(absPath)}`;
}

export function archiveEntryUrl(archivePath: string, entryPath: string): string {
  return `${LOCAL_SCHEME}://a/${b64(archivePath)}/${b64(entryPath)}`;
}

export function parseLocalUrl(
  url: string
): { kind: 'file'; path: string } | { kind: 'entry'; archive: string; entry: string } | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (u.hostname === 'f' && parts.length >= 1) return { kind: 'file', path: unb64(parts[0]) };
    if (u.hostname === 'a' && parts.length >= 2) {
      return { kind: 'entry', archive: unb64(parts[0]), entry: unb64(parts[1]) };
    }
  } catch {
    /* 形が違う */
  }
  return null;
}

const MIME: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/plain',
  '.lrc': 'text/plain',
  '.srt': 'text/plain',
  '.vtt': 'text/vtt',
  '.html': 'text/plain', // HTML は実行させず、文字として読む
  '.htm': 'text/plain',
  '.rtf': 'text/plain',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
};

export function mimeOf(p: string): string {
  return MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
}

/** 許可されたパスの配下か。Windows なので大文字小文字は区別しない */
export function isUnder(target: string, allowed: string[]): boolean {
  const t = path.resolve(target).toLowerCase();
  return allowed.some((a) => {
    const base = path.resolve(a).toLowerCase();
    return t === base || t.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
  });
}

export { parseRange, configureArchiveCache } from '../archive/archiveAccess';

export function registerLocalProtocol(opts: {
  allowedPaths: () => string[];
  sevenZip: () => string | null;
}): void {
  let cached: { at: number; list: string[] } = { at: 0, list: [] };
  const allowed = (): string[] => {
    if (Date.now() - cached.at > 2000) cached = { at: Date.now(), list: opts.allowedPaths() };
    return cached.list;
  };

  // **ファイル操作はすべて非同期で行う。** 同期で開くと、Defender がアーカイブを検査している間
  // （数百MBの zip で30秒ほど）メインプロセスごと止まり、ウィンドウが「応答なし」になる。
  protocol.handle(LOCAL_SCHEME, async (request) => withCors(await handle(request)));

  /**
   * 画面（file://）から見ると mylib:// は別のオリジン。ボイスプレイヤーは Web Audio で音を加工するので、
   * CORS の許可が無いと音が無音になる（メディアが「汚れた」扱いになる）。読むだけの許可を付ける。
   */
  function withCors(res: Response): Response {
    try {
      res.headers.set('Access-Control-Allow-Origin', '*');
      res.headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
      return res;
    } catch {
      // 見出しを変えられない Response（まれ）は作り直す
      const headers = new Headers(res.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
  }

  async function handle(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': 'Range' }
      });
    }
    const parsed = parseLocalUrl(request.url);
    if (!parsed) return new Response('bad request', { status: 400 });
    try {
      if (parsed.kind === 'file') {
        if (!isUnder(parsed.path, allowed())) return new Response('forbidden', { status: 403 });
        const stat = await retryTransient(() => fs.promises.stat(parsed.path)).catch(() => null);
        if (!stat || !stat.isFile()) return new Response('not found', { status: 404 });
        return await fileResponse(parsed.path, request.headers.get('Range'), mimeOf(parsed.path));
      }
      if (!isUnder(parsed.archive, allowed())) return new Response('forbidden', { status: 403 });
      return await entryResponse({
        archive: parsed.archive,
        entry: parsed.entry,
        rangeHeader: request.headers.get('Range'),
        mime: mimeOf(parsed.entry),
        sevenZip: opts.sevenZip()
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // 画面側では「再生できない」としか分からないので、理由はここに残す
      console.warn(`[mylib] ${request.headers.get('Range') ?? ''} ${code ?? ''} ${err instanceof Error ? err.message : String(err)}`);
      return new Response(err instanceof Error ? err.message : String(err), {
        status: code === 'ENOENT' ? 404 : 500
      });
    }
  }
}
