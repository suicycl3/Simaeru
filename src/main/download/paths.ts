import path from 'node:path';
import type { Product } from '@shared/types';
import { DEFAULT_TEMPLATE, LEGACY_DEFAULT_TEMPLATE, expandTemplate, sanitizeSegment } from '@shared/folderTemplate';

/**
 * 保存先のフォルダの決定。トークンの展開は @shared/folderTemplate（設定画面の例と同じもの）、
 * ここではパスの連結と Windows のパス長の調整をする。
 */
export { DEFAULT_TEMPLATE, LEGACY_DEFAULT_TEMPLATE, sanitizeSegment };

/** Windowsのパス長（260）に収まるよう、長いところから削る */
function fitWindowsPath(root: string, segments: string[], fileName: string): string[] {
  const LIMIT = 240; // ファイル名ぶんの余裕を見て短めに切る
  const out = [...segments];
  for (let guard = 0; guard < 8; guard++) {
    const full = path.join(root, ...out, fileName);
    if (full.length <= LIMIT) return out;
    // いちばん長いセグメントを削る。全部短いのにあふれるならこれ以上は詰められない
    let longest = 0;
    for (let i = 1; i < out.length; i++) if (out[i].length > out[longest].length) longest = i;
    if (out[longest].length <= 12) return out;
    out[longest] = out[longest].slice(0, Math.max(12, out[longest].length - 24)).trimEnd();
  }
  return out;
}

/**
 * 作品の保存先フォルダを作る。
 * @param template 設定のテンプレート。空なら既定
 * @param fileName パス長の計算に使う（実際の連結はしない）
 */
export function productFolder(
  root: string,
  template: string,
  product: Product,
  fileName = ''
): string {
  const segments = expandTemplate(template, product);
  return path.join(root, ...fitWindowsPath(root, segments, fileName));
}

/** 同名ファイルがあるときに (2), (3)… を付ける */
export function uniqueFileName(exists: (p: string) => boolean, dir: string, name: string): string {
  const target = path.join(dir, name);
  if (!exists(target)) return target;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 100; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!exists(candidate)) return candidate;
  }
  return path.join(dir, `${base} (${Date.now()})${ext}`);
}
