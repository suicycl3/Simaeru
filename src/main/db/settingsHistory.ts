import type { DB } from './database';

/** 設定と同期履歴。同じ接続を使い、呼出元のtransaction境界を保つ。 */
export class SettingsHistoryStore {
  constructor(private db: DB) {}

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      )
      .run(key, value);
  }

  startSyncRun(siteId: string): number {
    const info = this.db
      .prepare('INSERT INTO sync_runs(site_id, started_at, status) VALUES(?, ?, ?)')
      .run(siteId, Date.now(), 'running');
    return Number(info.lastInsertRowid);
  }

  finishSyncRun(id: number, status: string, detail: unknown): void {
    this.db
      .prepare('UPDATE sync_runs SET finished_at=?, status=?, detail=? WHERE id=?')
      .run(Date.now(), status, JSON.stringify(detail ?? null), id);
  }

  lastSuccessfulSyncAt(): number | null {
    const row = this.db
      .prepare("SELECT max(finished_at) AS t FROM sync_runs WHERE status = 'done'")
      .get() as { t: number | null };
    return row.t;
  }

  syncHistory(): import('@shared/types').SyncHistoryEntry[] {
    const rows = this.db.prepare('SELECT id, started_at, finished_at, status, detail FROM sync_runs ORDER BY id DESC LIMIT 30').all() as Array<{ id: number; started_at: number; finished_at: number | null; status: string; detail: string | null }>;
    return rows.map((r) => {
      let floors: import('@shared/types').SyncResultSummary['floors'] = [];
      try { const parsed = JSON.parse(r.detail ?? '[]'); if (Array.isArray(parsed)) floors = parsed; } catch { /* 旧形式 */ }
      return { runId: r.id, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status as import('@shared/types').SyncResultSummary['status'], floors };
    });
  }
}
