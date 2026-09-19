import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export class ReplacementCleanupError extends Error {
  constructor(public destination: string, public journal: string, cause: unknown) {
    super(`置換後の旧ファイルを処理できません。新ファイルと復旧記録を保持しました: ${journal}`, { cause });
  }
}

/**
 * 同じボリューム内で完成品を公開する。旧版は公開成功まで別名で保持する。
 * 中断時は .replacement-*.json と .previous-* を残すので、元データを復元できる。
 * ごみ箱が使えない場合は完全削除へ切り替えず、新旧両方を保持する。
 */
export async function safeReplace(
  incoming: string, destination: string, originals: string[],
  dispose: (backup: string, original: string) => Promise<void>
): Promise<void> {
  if (!originals.some((p) => path.resolve(p).toLowerCase() === path.resolve(destination).toLowerCase()) && await fs.stat(destination).then(() => true, () => false)) {
    throw new Error(`置換対象外のファイルが存在します: ${destination}`);
  }
  const id = randomUUID();
  const journal = `${destination}.replacement-${id}.json`;
  const entries = originals.map((original) => ({ original, backup: `${original}.previous-${id}` }));
  await fs.writeFile(journal, JSON.stringify({ incoming, destination, entries }, null, 2), { flag: 'wx' });
  const staged: typeof entries = [];
  try {
    for (const entry of entries) {
      await fs.rename(entry.original, entry.backup);
      staged.push(entry);
    }
    await fs.rename(incoming, destination);
  } catch (error) {
    // 完成品の公開前の失敗。元の名前に戻す。戻せない場合もバックアップは消さない。
    for (const entry of staged.reverse()) await fs.rename(entry.backup, entry.original).catch(() => undefined);
    throw error;
  }
  try {
    for (const entry of entries) await dispose(entry.backup, entry.original);
  } catch (error) {
    throw new ReplacementCleanupError(destination, journal, error);
  }
  await fs.unlink(journal);
}
