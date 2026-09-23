import type { Database as DB } from 'better-sqlite3';
import type { Playlist } from '@shared/types';

/**
 * プレイリスト（自分で作る一覧）。
 *
 * お気に入り（★）やタグと違い、**並び順を持てる**のと、同じ作品をいくつの一覧にも入れられるのが違い。
 * 作品を消しても一覧の行が残らないよう、外部キーは ON DELETE CASCADE。
 */
export class PlaylistStore {
  constructor(private db: DB) {}

  /** すべてのプレイリスト（作品数つき・新しい順） */
  listPlaylists(): Playlist[] {
    return this.db
      .prepare(
        `SELECT pl.id, pl.name, pl.created_at AS createdAt, pl.updated_at AS updatedAt,
                (SELECT count(*) FROM playlist_items pi WHERE pi.playlist_ref = pl.id) AS count
           FROM playlists pl
          ORDER BY pl.updated_at DESC, pl.id DESC`
      )
      .all() as Playlist[];
  }

  getPlaylist(id: number): Playlist | null {
    return (this.listPlaylists().find((p) => p.id === id) ?? null) as Playlist | null;
  }

  /** 作る。同じ名前があればそれを返す（二重に作らない） */
  createPlaylist(name: string): Playlist {
    const trimmed = name.trim();
    const existing = this.db.prepare('SELECT id FROM playlists WHERE name = ?').get(trimmed) as { id: number } | undefined;
    if (existing) return this.getPlaylist(existing.id) as Playlist;
    const now = Date.now();
    const info = this.db.prepare('INSERT INTO playlists (name, created_at, updated_at) VALUES (?, ?, ?)').run(trimmed, now, now);
    return this.getPlaylist(Number(info.lastInsertRowid)) as Playlist;
  }

  renamePlaylist(id: number, name: string): void {
    this.db.prepare('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?').run(name.trim(), Date.now(), id);
  }

  deletePlaylist(id: number): void {
    this.db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
  }

  /** 末尾に足す。すでに入っているものは足さない */
  addToPlaylist(id: number, productRefs: number[]): number {
    const next = (this.db.prepare('SELECT coalesce(max(position), 0) AS m FROM playlist_items WHERE playlist_ref = ?').get(id) as { m: number }).m;
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO playlist_items (playlist_ref, product_ref, position, added_at) VALUES (?, ?, ?, ?)'
    );
    const now = Date.now();
    let added = 0;
    const run = this.db.transaction((refs: number[]) => {
      let position = next;
      for (const ref of refs) {
        position += 1;
        added += insert.run(id, ref, position, now).changes;
      }
      this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now, id);
    });
    run(productRefs);
    return added;
  }

  removeFromPlaylist(id: number, productRefs: number[]): number {
    const remove = this.db.prepare('DELETE FROM playlist_items WHERE playlist_ref = ? AND product_ref = ?');
    let removed = 0;
    const run = this.db.transaction((refs: number[]) => {
      for (const ref of refs) removed += remove.run(id, ref).changes;
      this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), id);
    });
    run(productRefs);
    return removed;
  }

  /** その作品が入っているプレイリスト */
  playlistsOf(productRef: number): Playlist[] {
    const ids = this.db
      .prepare('SELECT playlist_ref AS id FROM playlist_items WHERE product_ref = ?')
      .all(productRef) as Array<{ id: number }>;
    const set = new Set(ids.map((r) => r.id));
    return this.listPlaylists().filter((p) => set.has(p.id));
  }
}
