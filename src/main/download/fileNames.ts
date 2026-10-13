import fs from 'node:fs';

/**
 * ダウンロードの保存名を決める・直すための小さな部品（通信なし。tools/test-download-names.mjs で確かめる）。
 *
 * Chromium は、応答から名前が分からないと既定の「download」（拡張子なし）を付ける。
 * DMM 同人で、1 回目の応答が中身の無いもの（大きさ 0）だったとき、その名前で保存先が決まり、
 * やり直しで本物の zip を受け取っても「download」のまま完了していた（d_657954、2026-10-12）。
 */

const HAS_EXTENSION = /\.[a-z0-9]{2,5}$/i;

export const hasExtension = (name: string): boolean => HAS_EXTENSION.test(name);

/** 種類（MIME）から付ける拡張子。分からなければ空 */
export function extensionFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (/zip/.test(m)) return '.zip';
  if (/rar/.test(m)) return '.rar';
  if (/7z/.test(m)) return '.7z';
  if (/msdownload|x-msdos-program|x-dosexec/.test(m)) return '.exe';
  if (/pdf/.test(m)) return '.pdf';
  if (/mp4/.test(m)) return '.mp4';
  return '';
}

/**
 * 保存名。Chromium の名前に拡張子があればそれを使う。無ければ（既定の「download」など）、
 * 行き先の URL の最後の部分（`…/d_000001.zip`）、それも無ければ作品 ID と種類から作る。
 */
export function downloadFileName(suggested: string, urlChain: string[], mime: string, fallbackBase: string): string {
  if (suggested && hasExtension(suggested)) return suggested;
  for (const url of [...urlChain].reverse()) {
    try {
      const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
      if (hasExtension(last)) return last;
    } catch {
      /* 読めない URL は飛ばす */
    }
  }
  // 種類も分からなければ .bin（完了したあと、先頭のバイトで zip などに直す: sniffExtension）
  return `${fallbackBase}${extensionFromMime(mime) || '.bin'}`;
}

/** ファイルの先頭の数バイトから、拡張子を見分ける（zip・rar・7z・exe・pdf）。分からなければ null */
export function extensionFromMagic(head: Buffer): string | null {
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07)) return '.zip';
  if (head.length >= 4 && head.toString('latin1', 0, 4) === 'Rar!') return '.rar';
  if (head.length >= 6 && head[0] === 0x37 && head[1] === 0x7a && head[2] === 0xbc && head[3] === 0xaf && head[4] === 0x27 && head[5] === 0x1c) return '.7z';
  if (head.length >= 4 && head.toString('latin1', 0, 4) === '%PDF') return '.pdf';
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return '.exe';
  return null;
}

/** ファイルの先頭を読んで拡張子を見分ける（読めなければ null） */
export async function sniffExtension(file: string): Promise<string | null> {
  const handle = await fs.promises.open(file, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const head = Buffer.alloc(8);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return extensionFromMagic(head.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
