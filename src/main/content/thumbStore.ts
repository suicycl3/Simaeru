import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { retryTransient } from '../fsRetry';
import { parseLocalUrl } from './localProtocol';

/**
 * 画像の一覧（サムネイル）用に縮めた画像の置き場（NeeView のサムネイルの置き場にならう）。
 *
 * 一覧に原寸の画像をそのまま並べると、数千ピクセルの画像を何十枚も読んでは縮めることになり、開くたびに重い。
 * 縮めるのは画面側（デコードは裏のスレッドで行われる）。ここでは縮めたものを覚えておき、次からはそれを返す。
 *
 * - 1つの SQLite にまとめる。1枚ずつファイルにすると、新しいファイルを初めて開くたびに Windows の検査で待たされる
 * - 鍵は「元のファイルの場所・大きさ・更新日時・アーカイブの中の名前」。元が変われば別物として作り直す
 * - 上限を超えたら、最後に使ったのが古いものから捨てる。消えても作り直すだけなので、壊れていたら作り直す
 */

/** 縮め方を変えたら上げる（古いものを使わない） */
const VERSION = 1;
const DEFAULT_LIMIT = 256 * 1024 * 1024;
/** 1枚の上限。これより大きいものは縮めた意味が無いので置かない */
export const THUMB_MAX_BYTES = 512 * 1024;
/** 同じファイルの大きさ・更新日時を確かめ直すまでの間（一覧を開くと同じアーカイブを何十回も見るため） */
const STAT_TTL_MS = 5_000;

export class ThumbStore {
  private db: Database.Database | null = null;
  private opening: Promise<Database.Database | null> | null = null;
  private total = 0;
  private stats = new Map<string, { at: number; sig: Promise<string | null> }>();

  constructor(
    private readonly file: string,
    private readonly limitBytes = DEFAULT_LIMIT
  ) {}

  /** 縮めたものがあれば返す（無ければ null） */
  async get(url: string): Promise<Uint8Array | null> {
    const key = await this.keyOf(url);
    const db = key ? await this.open() : null;
    if (!db || !key) return null;
    const row = db.prepare('SELECT data FROM thumbs WHERE key = ?').get(key) as { data: Buffer } | undefined;
    if (!row) return null;
    db.prepare('UPDATE thumbs SET used_at = ? WHERE key = ?').run(Date.now(), key);
    return new Uint8Array(row.data);
  }

  /** 縮めたものを置く。画像でないもの・大きすぎるものは置かない */
  async put(url: string, data: Uint8Array): Promise<boolean> {
    if (!(data instanceof Uint8Array) || data.length === 0 || data.length > THUMB_MAX_BYTES || !looksLikeImage(data)) return false;
    const key = await this.keyOf(url);
    const db = key ? await this.open() : null;
    if (!db || !key) return false;
    const old = db.prepare('SELECT size FROM thumbs WHERE key = ?').get(key) as { size: number } | undefined;
    db.prepare('INSERT OR REPLACE INTO thumbs (key, data, size, used_at) VALUES (?, ?, ?, ?)').run(key, Buffer.from(data), data.length, Date.now());
    this.total += data.length - (old?.size ?? 0);
    if (this.total > this.limitBytes) this.trim(db);
    return true;
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.opening = null;
  }

  /** 古いものから、上限の 9 割まで減らす */
  private trim(db: Database.Database): void {
    const target = this.limitBytes * 0.9;
    const rows = db.prepare('SELECT key, size FROM thumbs ORDER BY used_at').iterate() as Iterable<{ key: string; size: number }>;
    const drop: string[] = [];
    for (const r of rows) {
      if (this.total <= target) break;
      drop.push(r.key);
      this.total -= r.size;
    }
    const del = db.prepare('DELETE FROM thumbs WHERE key = ?');
    db.transaction(() => {
      for (const k of drop) del.run(k);
    })();
  }

  private keyOf(url: string): Promise<string | null> {
    const parsed = parseLocalUrl(url);
    if (!parsed) return Promise.resolve(null);
    const source = parsed.kind === 'file' ? parsed.path : parsed.archive;
    const entry = parsed.kind === 'file' ? '' : parsed.entry;
    return this.signature(source).then((sig) =>
      sig ? crypto.createHash('sha1').update(`${VERSION}|${sig}|${entry}`).digest('hex') : null
    );
  }

  private signature(file: string): Promise<string | null> {
    const hit = this.stats.get(file);
    if (hit && Date.now() - hit.at < STAT_TTL_MS) return hit.sig;
    const sig = retryTransient(() => fs.stat(file)).then(
      (st) => `${path.resolve(file).toLowerCase()}|${st.size}|${st.mtimeMs}`,
      () => null
    );
    this.stats.set(file, { at: Date.now(), sig });
    if (this.stats.size > 200) this.stats.delete(this.stats.keys().next().value as string);
    return sig;
  }

  /**
   * 初めて使うときに開く。開けなければ null（縮めたものを覚えないだけで、一覧は出る）。
   * SQLite は同期で開くので、その前に非同期で一度開いて、Windows の初回の検査を裏で済ませておく
   * （同期で待たされると、そのあいだ画面ごと止まる）。
   */
  private open(): Promise<Database.Database | null> {
    if (this.db) return Promise.resolve(this.db);
    this.opening ??= (async () => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const exists = await fs.access(this.file).then(() => true, () => false);
        if (exists) await (await retryTransient(() => fs.open(this.file, 'r'))).close();
        let db: Database.Database;
        try {
          db = this.connect();
        } catch {
          // 壊れていたら作り直す（置いてあるのは作り直せるものだけ）
          await fs.rm(this.file, { force: true });
          db = this.connect();
        }
        this.total = (db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM thumbs').get() as { n: number }).n;
        this.db = db;
        return db;
      } catch (err) {
        console.warn('[thumbs] 置き場を開けませんでした:', err instanceof Error ? err.message : err);
        return null;
      }
    })();
    return this.opening;
  }

  private connect(): Database.Database {
    const db = new Database(this.file);
    try {
      // 作り直せる中身なので、書き込みの安全より速さを取る。WAL などの付随ファイルも作らない
      db.pragma('journal_mode = MEMORY');
      db.pragma('synchronous = OFF');
      db.exec('CREATE TABLE IF NOT EXISTS thumbs (key TEXT PRIMARY KEY, data BLOB NOT NULL, size INTEGER NOT NULL, used_at INTEGER NOT NULL)');
      db.exec('CREATE INDEX IF NOT EXISTS thumbs_used ON thumbs (used_at)');
      const ok = (db.pragma('quick_check(1)') as Array<{ quick_check: string }>)[0]?.quick_check === 'ok';
      if (!ok) throw new Error('thumbs.db is corrupt');
      return db;
    } catch (err) {
      db.close();
      throw err;
    }
  }
}

/** WebP / JPEG / PNG の頭か */
function looksLikeImage(b: Uint8Array): boolean {
  const ascii = (from: number, to: number): string => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return true;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  return b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === 'PNG';
}
