import fs from 'node:fs/promises';
import { readZipIndex } from '../archive/zipReader';

/** 販売ページの作品容量は使わず、転送行のContent-Lengthだけと比較する。 */
export async function verifyTransfer(file: string, expected: number | null, finalName: string): Promise<number> {
  const size = (await fs.stat(file)).size;
  if (size <= 0 || (expected !== null && expected > 0 && size !== expected)) {
    throw new Error('転送サイズが一致しません。ファイルを保持して検証を停止しました。');
  }
  // 中央ディレクトリと終端が読めないZIPは完成扱いにしない。
  // 分割ZIPは単独では検証できないため、展開ジョブ側の全巻検査に任せる。
  if (/\.zip$/i.test(finalName)) await readZipIndex(file);
  return size;
}
