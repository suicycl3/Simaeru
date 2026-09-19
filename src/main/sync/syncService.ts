import { EventEmitter } from 'node:events';
import type { SyncProgress, SyncResultSummary } from '@shared/types';
import type { Repo } from '../db/repo';
import { getFloor } from '../sites/registry';
import { t } from '@shared/i18n';

export class SyncService extends EventEmitter {
  private cancelled = false;
  private active = false;

  constructor(private repo: Repo) {
    super();
  }

  get isRunning(): boolean {
    return this.active;
  }

  cancel(): void {
    if (this.active) this.cancelled = true;
  }

  private emitProgress(p: SyncProgress): void {
    this.emit('progress', p);
  }

  /**
   * 指定フロアを順に同期する。1フロアが失敗しても残りは続行する。
   * 既定は差分同期（新しいぶんだけ取る）。full を指定すると全件を取り直す。
   */
  async run(floorKeys: string[], opts: { full?: boolean } = {}): Promise<SyncResultSummary> {
    if (this.active) throw new Error(t('同期はすでに実行中です'));
    this.active = true;
    this.cancelled = false;

    let runId: number;
    try { runId = this.repo.startSyncRun('all'); }
    catch (error) { this.active = false; throw error; }
    const floors: SyncResultSummary['floors'] = [];

    try {
      for (const floorKey of floorKeys) {
        if (this.cancelled) break;
        const base = {
          runId,
          floorKey,
          floorLabel: floorKey,
          added: 0,
          updated: 0,
          error: null
        };
        try {
          const { site, floor } = getFloor(floorKey);
          // 既知の作品ID。差分モードでは、これだけになったページで打ち切る。
          const known = this.repo.syncState(site.siteId, floor.floorId);
          const incremental = !opts.full && known.ids.size > 0;
          base.floorLabel = floor.label;
          this.emitProgress({
            ...base,
            phase: 'running',
            fetched: 0,
            total: null,
            message: t('{label}: {1}の取得を開始しました', { label: t(floor.label), 1: incremental ? t('更新分') : t('全件') })
          });

          const items = await floor.fetchAll({
            onProgress: (fetched, total, message) =>
              this.emitProgress({
                ...base,
                phase: 'running',
                fetched,
                total,
                message: message ?? t('{label}: {fetched}{2} 件', { label: t(floor.label), fetched, 2: total ? ` / ${total}` : '' })
              }),
            isCancelled: () => this.cancelled,
            incremental,
            isKnown: (id) => known.ids.has(id),
            isComplete: (id) => known.ids.has(id) && known.withLinks.has(id),
            hasSerial: (id) => known.withSerial.has(id),
            // 一覧そのものは「行があれば既知」でよい。
            // ダウンロード導線まで要る取得（DLsiteの購入履歴）は isComplete を使う。
            canStopAfterPage: (ids) =>
              incremental && ids.length > 0 && ids.every((id) => known.ids.has(id))
          });

          const { added, updated } = this.repo.upsertMany(items);
          floors.push({ floorKey, fetched: items.length, added, updated, error: null });
          this.emitProgress({
            ...base,
            phase: 'running',
            fetched: items.length,
            total: items.length,
            added,
            updated,
            message: t('{label}: 新規 {added} 件 / 更新 {updated} 件', { label: t(floor.label), added, updated })
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          floors.push({ floorKey, fetched: 0, added: 0, updated: 0, error: message });
          this.emitProgress({
            ...base,
            phase: 'error',
            fetched: 0,
            total: null,
            message: t('{label}: 失敗', { label: t(base.floorLabel) }),
            error: message
          });
        }
      }

      const failed = floors.filter((f) => f.error);
      const status = this.cancelled ? 'cancelled' : failed.length === 0 ? 'done' : failed.length === floors.length ? 'error' : 'partial';
      this.repo.finishSyncRun(runId, status, floors);
      this.emitProgress({
        runId,
        phase: this.cancelled ? 'cancelled' : failed.length > 0 ? 'error' : 'done',
        floorKey: null,
        floorLabel: null,
        fetched: floors.reduce((a, f) => a + f.fetched, 0),
        total: null,
        added: floors.reduce((a, f) => a + f.added, 0),
        updated: floors.reduce((a, f) => a + f.updated, 0),
        message: this.cancelled ? t('同期を中断しました') : status === 'error' ? t('同期に失敗しました') : status === 'partial' ? t('同期の一部が失敗しました') : t('同期が完了しました'),
        error: failed.length ? failed.map((f) => `${f.floorKey}: ${f.error}`).join('\n') : null
      });
      return { runId, floors, status };
    } finally {
      this.active = false;
      this.cancelled = false;
    }
  }
}
