import type { DB } from './database';
import type { LocalFile } from '@shared/types';

export class LocalFileStore {
  constructor(private db: DB) {}

  // ── 手元のファイル ─────────────────────────────────────

  addLocalFile(input: {
    productRef: number | null;
    path: string;
    sizeBytes: number | null;
    kind: string | null;
    source: string;
    derivedFrom?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO local_files (product_ref, path, size_bytes, kind, source, added_at, derived_from)
         VALUES (@product_ref, @path, @size_bytes, @kind, @source, @added_at, @derived_from)
         ON CONFLICT(path) DO UPDATE SET
           product_ref=@product_ref, size_bytes=@size_bytes, kind=@kind, source=@source, missing_at=NULL,
           derived_from=coalesce(@derived_from, derived_from)`
      )
      .run({
        product_ref: input.productRef,
        path: input.path,
        size_bytes: input.sizeBytes,
        kind: input.kind,
        source: input.source,
        added_at: Date.now(),
        derived_from: input.derivedFrom ?? null
      });
  }

  /** 台帳の1行の大きさを付け直す（FLAC 変換でフォルダが縮んだときなど） */
  updateLocalFileSize(filePath: string, sizeBytes: number | null): void {
    this.db.prepare('UPDATE local_files SET size_bytes = ? WHERE path = ?').run(sizeBytes, filePath);
  }

  /** そのアーカイブを展開してできたフォルダ（まだ在るもの） */
  extractedFrom(archivePath: string): LocalFile | null {
    const row = this.db
      .prepare(
        `SELECT id FROM local_files WHERE derived_from = ? AND missing_at IS NULL ORDER BY added_at DESC LIMIT 1`
      )
      .get(archivePath) as { id: number } | undefined;
    if (!row) return null;
    return this.getLocalFileById(row.id);
  }

  getLocalFileById(id: number): LocalFile | null {
    const r = this.db
      .prepare(
        `SELECT id, product_ref, path, size_bytes, kind, source, added_at, missing_at, derived_from
           FROM local_files WHERE id = ?`
      )
      .get(id) as LocalFileRaw | undefined;
    return r ? toLocalFile(r) : null;
  }

  /** 台帳にあって実在する全パス。mylib:// で読ませてよい範囲の判定に使う */
  allLocalPaths(): string[] {
    return (
      this.db.prepare('SELECT path FROM local_files WHERE missing_at IS NULL').all() as Array<{
        path: string;
      }>
    ).map((r) => r.path);
  }

  /** 台帳の中身から作る印。ファイルの増減・移動・大きさの変化で変わる（中身の見取り図を作り直す合図） */
  localFileSignature(productRef: number): string {
    const rows = this.db
      .prepare(
        `SELECT path, size_bytes, kind, derived_from, missing_at IS NOT NULL AS missing
           FROM local_files WHERE product_ref = ? ORDER BY path`
      )
      .all(productRef) as Array<{ path: string; size_bytes: number | null; kind: string | null; derived_from: string | null; missing: number }>;
    return JSON.stringify(rows.map((r) => [r.path, r.size_bytes, r.kind, r.derived_from, r.missing]));
  }

  getContentCache(productRef: number): { signature: string; indexJson: string; installJson: string; updatedAt: number } | null {
    const row = this.db
      .prepare('SELECT signature, index_json, install_json, updated_at FROM content_cache WHERE product_ref = ?')
      .get(productRef) as { signature: string; index_json: string; install_json: string; updated_at: number } | undefined;
    return row ? { signature: row.signature, indexJson: row.index_json, installJson: row.install_json, updatedAt: row.updated_at } : null;
  }

  setContentCache(productRef: number, signature: string, indexJson: string, installJson: string): void {
    this.db
      .prepare(
        `INSERT INTO content_cache (product_ref, signature, index_json, install_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(product_ref) DO UPDATE SET signature=excluded.signature, index_json=excluded.index_json,
           install_json=excluded.install_json, updated_at=excluded.updated_at`
      )
      .run(productRef, signature, indexJson, installJson, Date.now());
  }

  deleteContentCache(productRef: number): void {
    this.db.prepare('DELETE FROM content_cache WHERE product_ref = ?').run(productRef);
  }

  /** 台帳にある全ファイル（移動の計画用） */
  allLocalFiles(): LocalFile[] {
    return (
      this.db
        .prepare(
          `SELECT id, product_ref, path, size_bytes, kind, source, added_at, missing_at, derived_from
             FROM local_files ORDER BY product_ref, path`
        )
        .all() as LocalFileRaw[]
    ).map(toLocalFile);
  }

  /**
   * ファイル・フォルダを移したあとに、パスを参照しているところをまとめて付け替える。
   * 台帳・展開元の記録・ダウンロード履歴の保存先・インストールの場所（配下の exe を含む）。
   */
  relocatePath(from: string, to: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE local_files SET path = ? WHERE path = ?').run(to, from);
      this.db.prepare('UPDATE local_files SET derived_from = ? WHERE derived_from = ?').run(to, from);
      this.db.prepare('UPDATE downloads SET save_path = ? WHERE save_path = ?').run(to, from);
      const prefix = from.endsWith('\\') ? from : `${from}\\`;
      const rows = this.db
        .prepare('SELECT id, install_path, executable_path FROM installations')
        .all() as Array<{ id: number; install_path: string | null; executable_path: string | null }>;
      const swap = (p: string | null): string | null => {
        if (!p) return p;
        if (p.toLowerCase() === from.toLowerCase()) return to;
        if (p.toLowerCase().startsWith(prefix.toLowerCase())) return to + p.slice(from.length);
        return p;
      };
      const upd = this.db.prepare('UPDATE installations SET install_path = ?, executable_path = ? WHERE id = ?');
      for (const r of rows) {
        const ip = swap(r.install_path);
        const ep = swap(r.executable_path);
        if (ip !== r.install_path || ep !== r.executable_path) upd.run(ip, ep, r.id);
      }
    });
    tx();
  }

  /**
   * 台帳に載っているフォルダの中にあるファイルの行を外す（そのフォルダの一部なので、個別の行は要らない）。
   * 以前の取り込みスキャンが、展開したゲームの中の exe や readme を別々に拾っていたのを片付ける。
   * @returns 外した件数
   */
  removeNestedLocalFiles(isInside: (child: string, folder: string) => boolean): number {
    const rows = this.allLocalFiles();
    const folders = rows.filter((f) => f.kind === 'folder');
    const nested = rows.filter((f) =>
      folders.some((d) => d.id !== f.id && d.productRef === f.productRef && isInside(f.path, d.path))
    );
    const del = this.db.prepare('DELETE FROM local_files WHERE id = ?');
    for (const f of nested) del.run(f.id);
    return nested.length;
  }

  setLocalFileMissing(id: number, missingAt: number | null): void {
    this.db.prepare('UPDATE local_files SET missing_at = ? WHERE id = ?').run(missingAt, id);
  }

  removeLocalFile(filePath: string): void {
    this.db.prepare('DELETE FROM local_files WHERE path = ?').run(filePath);
  }

  localFiles(productRef: number): LocalFile[] {
    const rows = this.db
      .prepare(
        `SELECT id, product_ref, path, size_bytes, kind, source, added_at, missing_at, derived_from
           FROM local_files WHERE product_ref = ? ORDER BY added_at`
      )
      .all(productRef) as LocalFileRaw[];
    return rows.map(toLocalFile);
  }

  /** すでに台帳にあるパス（無視したものを含む）。再提示しないために使う */
  knownLocalPaths(): Set<string> {
    const rows = this.db.prepare('SELECT path FROM local_files').all() as Array<{ path: string }>;
    return new Set(rows.map((r) => r.path));
  }

  /** 実体が消えたファイルに印を付ける（行は消さない） */
  markMissingFiles(check: (path: string) => boolean): number {
    const rows = this.db
      .prepare('SELECT id, path, missing_at FROM local_files')
      .all() as Array<{ id: number; path: string; missing_at: number | null }>;
    const now = Date.now();
    let changed = 0;
    const setMissing = this.db.prepare('UPDATE local_files SET missing_at = ? WHERE id = ?');
    for (const r of rows) {
      const exists = check(r.path);
      if (!exists && r.missing_at === null) {
        setMissing.run(now, r.id);
        changed++;
      } else if (exists && r.missing_at !== null) {
        setMissing.run(null, r.id);
        changed++;
      }
    }
    return changed;
  }

  /** markMissingFiles の非同期版（メインプロセスを止めないため、確認は並べて投げる） */
  async markMissingFilesAsync(check: (path: string) => Promise<boolean>): Promise<number> {
    const rows = this.db
      .prepare('SELECT id, path, missing_at FROM local_files')
      .all() as Array<{ id: number; path: string; missing_at: number | null }>;
    const results = await Promise.all(rows.map((r) => check(r.path)));
    const now = Date.now();
    let changed = 0;
    const setMissing = this.db.prepare('UPDATE local_files SET missing_at = ? WHERE id = ?');
    rows.forEach((r, i) => {
      if (!results[i] && r.missing_at === null) {
        setMissing.run(now, r.id);
        changed++;
      } else if (results[i] && r.missing_at !== null) {
        setMissing.run(null, r.id);
        changed++;
      }
    });
    return changed;
  }

  /** 作品ごとの「手元にあるか」。一覧のバッジ用 */
  productsWithFiles(): Set<number> {
    const rows = this.db
      .prepare('SELECT DISTINCT product_ref FROM local_files WHERE product_ref IS NOT NULL')
      .all() as Array<{ product_ref: number }>;
    return new Set(rows.map((r) => r.product_ref));
  }
}
interface LocalFileRaw {
  id: number;
  product_ref: number | null;
  path: string;
  size_bytes: number | null;
  kind: string | null;
  source: string;
  added_at: number;
  missing_at: number | null;
  derived_from: string | null;
}

function toLocalFile(r: LocalFileRaw): LocalFile {
  return {
    id: r.id,
    productRef: r.product_ref,
    path: r.path,
    sizeBytes: r.size_bytes,
    kind: r.kind,
    source: r.source,
    addedAt: r.added_at,
    missingAt: r.missing_at,
    derivedFrom: r.derived_from
  };
}

