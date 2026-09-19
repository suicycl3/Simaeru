import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './schema';

export type DB = Database.Database;

let db: DB | null = null;

/**
 * 壊れたDBを退避して退避先を返す。起動できないまま詰むより作り直しを選ぶが、
 * 読める表は salvage() で新しい DB へ写す（手元のファイルの台帳・設定・保存したID/PWは再同期では戻らない）。
 */
function quarantine(file: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dead = `${file}.corrupt-${stamp}`;
  for (const suffix of ['', '-wal', '-shm']) {
    if (!fs.existsSync(file + suffix)) continue;
    try {
      fs.renameSync(file + suffix, dead + suffix);
    } catch {
      try {
        fs.unlinkSync(file + suffix);
      } catch {
        /* 消せなければ諦めて次へ */
      }
    }
  }
  return dead;
}

/** 開いたDBが壊れていないかを軽く確かめる */
function isHealthy(handle: DB): boolean {
  try {
    const rows = handle.pragma('quick_check(1)') as Array<{ quick_check: string }>;
    return rows.length === 1 && rows[0].quick_check === 'ok';
  } catch (err) {
    // 使用中などで確かめられなかったときは「壊れている」扱いにしない（退避すると中身が見えなくなる）
    if (!isCorruption(err)) throw err;
    return false;
  }
}

class CorruptDatabase extends Error {}

/**
 * 壊れていることを示すエラーか。**使用中（BUSY / LOCKED）や移行の失敗では退避しない。**
 * 以前は何のエラーでも退避して空の DB で起動しており、手元のファイルの台帳や設定まで見えなくなった。
 */
function isCorruption(err: unknown): boolean {
  if (err instanceof CorruptDatabase) return true;
  const code = (err as { code?: string } | null)?.code ?? '';
  return code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB' || code.startsWith('SQLITE_CORRUPT_');
}

/**
 * 壊れた DB から写す表（写す順）。作り直せる表（中身の作り置き・検索の索引）は写さない。
 * 検索の索引は、作品を入れるときにトリガーで作り直される。
 */
const SALVAGE_TABLES = ['products', 'installations', 'sync_runs', 'settings', 'credentials', 'downloads', 'local_files', 'jobs', 'compilation_overrides'];

/**
 * 退避した DB から、読める行を新しい DB へ写す。表ごとにまとめて写し、途中で読めない所に当たったら1行ずつ拾う。
 * @returns 表ごとの写した行数（読めなかった表はエラーの文言）
 */
export function salvage(handle: DB, deadFile: string): Record<string, number | string> {
  const report: Record<string, number | string> = {};
  try {
    handle.prepare('ATTACH DATABASE ? AS old').run(deadFile);
  } catch (err) {
    report.attach = err instanceof Error ? err.message : String(err);
    return report;
  }
  handle.pragma('foreign_keys = OFF');
  try {
    for (const table of SALVAGE_TABLES) {
      try {
        const columnsOf = (schema: string): string[] =>
          (handle.pragma(`${schema}.table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
        const old = new Set(columnsOf('old'));
        const cols = columnsOf('main')
          .filter((c) => old.has(c))
          .map((c) => `"${c}"`)
          .join(', ');
        if (!cols) continue;
        const insertAll = handle.prepare(`INSERT OR REPLACE INTO main.${table} (${cols}) SELECT ${cols} FROM old.${table}`);
        try {
          report[table] = handle.transaction(() => insertAll.run().changes)();
        } catch {
          // まとめて読めないときは、読める行だけ拾う
          const ids = handle.prepare(`SELECT rowid AS id FROM old.${table}`).pluck().all() as number[];
          const insertOne = handle.prepare(
            `INSERT OR REPLACE INTO main.${table} (${cols}) SELECT ${cols} FROM old.${table} WHERE rowid = ?`
          );
          let copied = 0;
          for (const id of ids) {
            try {
              copied += insertOne.run(id).changes;
            } catch {
              /* この行は読めない */
            }
          }
          report[table] = copied;
        }
      } catch (err) {
        report[table] = err instanceof Error ? err.message : String(err);
      }
    }
  } finally {
    handle.pragma('foreign_keys = ON');
    try {
      handle.exec('DETACH DATABASE old');
    } catch {
      /* 閉じるときに外れる */
    }
  }
  return report;
}

export interface OpenResult {
  db: DB;
  /** 破損して作り直した場合の退避先パス。正常なら null */
  recoveredFrom: string | null;
  /** 作り直したときに、退避した DB から写した行数（表ごと） */
  salvaged: Record<string, number | string> | null;
}

export function openDatabase(userDataDir: string): OpenResult {
  if (db) return { db, recoveredFrom: null, salvaged: null };
  fs.mkdirSync(userDataDir, { recursive: true });
  const file = path.join(userDataDir, 'library.db');

  let handle: DB | null = null;
  let recoveredFrom: string | null = null;
  let salvaged: Record<string, number | string> | null = null;
  try {
    // 前のプロセスが閉じ切る前に開いたときなど、使用中ならしばらく待つ
    handle = new Database(file, { timeout: 10_000 });
    handle.pragma('journal_mode = WAL');
    if (!isHealthy(handle)) throw new CorruptDatabase('quick_check failed');
    handle.pragma('foreign_keys = ON');
    migrate(handle);
  } catch (err) {
    try {
      handle?.close();
    } catch {
      /* 既に閉じている */
    }
    // 壊れているときだけ退避して作り直す。使用中・移行の失敗などはそのまま知らせる（退避すると中身が見えなくなる）
    if (!isCorruption(err)) throw err;
    recoveredFrom = quarantine(file);
    handle = new Database(file, { timeout: 10_000 });
    handle.pragma('journal_mode = WAL');
    handle.pragma('foreign_keys = ON');
    migrate(handle);
    salvaged = salvage(handle, recoveredFrom);
  }

  registerRegexp(handle);
  db = handle;
  return { db: handle, recoveredFrom, salvaged };
}

/**
 * SQLite に REGEXP 演算子を足す（標準では未実装）。
 * 判定は JavaScript の正規表現で、**大文字小文字は区別しない**（'i' 固定）。
 * 同じパターンが行ごとに来るので、直前のコンパイル結果だけ使い回す。
 */
function registerRegexp(handle: DB): void {
  let lastPattern: string | null = null;
  let lastRegex: RegExp | null = null;
  handle.function('regexp', { deterministic: true }, (pattern: unknown, value: unknown) => {
    if (value === null || value === undefined) return 0;
    const source = String(pattern);
    if (source !== lastPattern) {
      lastPattern = source;
      try {
        lastRegex = new RegExp(source, 'i');
      } catch {
        // 不正なパターンは「一致なし」。呼び出し側(repo)で事前に弾いているので通常ここには来ない。
        lastRegex = null;
      }
    }
    return lastRegex && lastRegex.test(String(value)) ? 1 : 0;
  });
}

/**
 * 終了時に必ず呼ぶ。WALを本体へ畳んでから閉じる。
 * 閉じずにプロセスを落とし続けると、巨大なWALを抱えたまま強制終了することになる。
 */
export function closeDatabase(): void {
  if (!db) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    /* 閉じる方を優先 */
  }
  try {
    db.close();
  } catch {
    /* 既に閉じている */
  }
  db = null;
}

export function getDatabase(): DB {
  if (!db) throw new Error('database is not open');
  return db;
}

function migrate(handle: DB): void {
  const current = handle.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    handle.exec('BEGIN');
    try {
      handle.exec(MIGRATIONS[v]);
      handle.pragma(`user_version = ${v + 1}`);
      handle.exec('COMMIT');
    } catch (err) {
      handle.exec('ROLLBACK');
      throw err;
    }
  }
}
