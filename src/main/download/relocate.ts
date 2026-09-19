import fs from 'node:fs/promises';
import path from 'node:path';
import type { RelocationItem, RelocationPlan } from '@shared/types';
import type { Repo } from '../db/repo';
import { isUnder } from '../content/localProtocol';
import { productFolder } from './paths';
import { retryTransient } from '../fsRetry';
import { t } from '@shared/i18n';

/**
 * 保存先やフォルダ構成を変えたときに、手元のファイルを新しい置き場所へ移す。
 *
 * - 動かすのは**このアプリの保存先（今の保存先・以前の保存先）の中にあるもの**だけ。
 *   取り込みで紐付けた、ユーザーが自分で整理しているフォルダのファイルは動かさない。
 * - 同じドライブなら名前の付け替え、別のドライブなら複製 → 大きさ・ファイル数を照らし合わせ → 元を削除。
 *   照らし合わせが合わなければ元を残して止める。
 * - 移したら台帳・展開元の記録・ダウンロード履歴・インストールの場所（配下の exe）を付け替える。
 */

export async function planRelocation(
  repo: Repo,
  root: string,
  template: string,
  knownRoots: string[]
): Promise<RelocationPlan> {
  const roots = [...new Set([root, ...knownRoots])];
  const rows = repo.allLocalFiles().filter((f) => !f.missingAt && f.productRef !== null);
  const items: RelocationItem[] = [];
  const skipped: RelocationPlan['skipped'] = [];
  const running = new Set(
    repo
      .listDownloads()
      .filter((d) => d.state === 'running' || d.state === 'paused' || d.state === 'queued')
      .map((d) => d.productRef)
  );

  for (const f of rows) {
    // 別の行（取り込んだフォルダなど）の中にあるものは、親と一緒に動くので個別には動かさない
    if (rows.some((o) => o !== f && isUnder(f.path, [o.path]) && o.path.toLowerCase() !== f.path.toLowerCase())) continue;
    if (!isUnder(f.path, roots)) continue;
    const product = repo.getProduct(f.productRef!);
    if (!product) continue;
    if (running.has(product.id)) {
      skipped.push({ path: f.path, reason: t('ダウンロード中・待機中のため動かしません') });
      continue;
    }
    const name = path.basename(f.path);
    const to = path.join(productFolder(root, template, product, name), name);
    if (to.toLowerCase() === f.path.toLowerCase()) continue;
    items.push({
      productRef: product.id,
      title: product.title,
      from: f.path,
      to,
      bytes: f.sizeBytes ?? 0,
      kind: f.kind === 'folder' ? 'folder' : 'file',
      crossDevice: path.parse(f.path).root.toLowerCase() !== path.parse(to).root.toLowerCase()
    });
  }
  return {
    root,
    template,
    items,
    totalBytes: items.reduce((s, i) => s + i.bytes, 0),
    crossDeviceBytes: items.filter((i) => i.crossDevice).reduce((s, i) => s + i.bytes, 0),
    skipped
  };
}

async function exists(p: string): Promise<boolean> {
  // 一時的に断られる（EPERM）ことがあるので、「無い」と決める前にやり直す
  return retryTransient(() => fs.access(p)).then(
    () => true,
    () => false
  );
}

async function uniquePath(p: string): Promise<string> {
  if (!(await exists(p))) return p;
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}

async function measure(p: string): Promise<{ files: number; bytes: number }> {
  const st = await fs.stat(p);
  if (!st.isDirectory()) return { files: 1, bytes: st.size };
  let files = 0;
  let bytes = 0;
  for (const item of await fs.readdir(p, { withFileTypes: true })) {
    const sub = await measure(path.join(p, item.name));
    files += sub.files;
    bytes += sub.bytes;
  }
  return { files, bytes };
}

/** 空になった親フォルダを、保存先の手前まで消していく */
async function pruneEmptyParents(from: string, roots: string[]): Promise<void> {
  let dir = path.dirname(from);
  for (let i = 0; i < 8; i++) {
    if (roots.some((r) => path.resolve(r).toLowerCase() === path.resolve(dir).toLowerCase())) return;
    if (!isUnder(dir, roots)) return;
    const items = await fs.readdir(dir).catch(() => null);
    if (!items || items.length > 0) return;
    await fs.rmdir(dir).catch(() => undefined);
    dir = path.dirname(dir);
  }
}

/** 1件を移す。戻り値は実際に置いた場所（同名があれば (2) などを付ける） */
export async function moveItem(item: RelocationItem, roots: string[], signal?: AbortSignal): Promise<string> {
  if (!(await exists(item.from))) throw new Error(t('移す元が見つかりません: {from}', { from: item.from }));
  const to = await uniquePath(item.to);
  await fs.mkdir(path.dirname(to), { recursive: true });
  try {
    await retryTransient(() => fs.rename(item.from, to));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw err;
    // 別のドライブ: 複製して、大きさとファイル数が合ってから元を消す
    const before = await measure(item.from);
    const staging = `${to}.moving`;
    await fs.rm(staging, { recursive: true, force: true });
    await fs.cp(item.from, staging, { recursive: true, preserveTimestamps: true, errorOnExist: true });
    if (signal?.aborted) {
      await fs.rm(staging, { recursive: true, force: true });
      throw new Error(t('中止しました'));
    }
    const after = await measure(staging);
    if (after.files !== before.files || after.bytes !== before.bytes) {
      await fs.rm(staging, { recursive: true, force: true });
      throw new Error(t('複製した中身が元と一致しません（{files}件/{bytes}B → {files2}件/{bytes2}B）。元はそのままです。', { files: before.files, bytes: before.bytes, files2: after.files, bytes2: after.bytes }));
    }
    await fs.rename(staging, to);
    await fs.rm(item.from, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
  }
  await pruneEmptyParents(item.from, roots);
  return to;
}
