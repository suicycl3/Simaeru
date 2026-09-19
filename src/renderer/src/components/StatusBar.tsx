import type { DownloadRow, JobRow, MetaStatus, SyncProgress } from '@shared/types';
import { JOB_LABELS } from '../lib/labels';
import { locale, t } from '@shared/i18n';

interface Props {
  onSyncHistory: () => void;
  progress: SyncProgress | null;
  lastSyncAt: number | null;
  shown: number;
  total: number;
  /** 作品メタの裏取得の状態。未取得なら null */
  meta: MetaStatus | null;
  onMetaEnabled: (enabled: boolean) => void;
  onMetaSpeed: (intervalMs: number, concurrency: number) => void;
  /** 残りを今すぐ取りにいく */
  onMetaRunNow: () => void;
  /** ダウンロードのキュー */
  downloads: DownloadRow[];
  /** 展開・FLAC 変換 */
  jobs: JobRow[];
  onOpenDownloads: () => void;
  /** 手元のファイルの取り込み */
  onOpenImport: () => void;
  onOpenSettings: () => void;
}

/**
 * 取得の速さ。1件ごとの待ち時間と並列数の組み合わせで示す。
 * 直列1件ずつだと3000件で数時間かかるので、既定は「標準」（毎秒2件前後）。
 */
const SPEEDS: Array<{ key: string; label: string; intervalMs: number; concurrency: number }> = [
  { key: 'gentle', label: t('ひかえめ (1件ずつ・5秒待ち)'), intervalMs: 5000, concurrency: 1 },
  { key: 'slow', label: t('ゆっくり (1件ずつ)'), intervalMs: 1000, concurrency: 1 },
  { key: 'normal', label: t('標準 (2並列)'), intervalMs: 500, concurrency: 2 },
  { key: 'fast', label: t('速い (4並列)'), intervalMs: 300, concurrency: 4 },
  { key: 'turbo', label: t('最速 (6並列)'), intervalMs: 100, concurrency: 6 }
];

function speedKeyOf(intervalMs: number, concurrency: number): string {
  const hit = SPEEDS.find((s) => s.intervalMs === intervalMs && s.concurrency === concurrency);
  return hit?.key ?? 'custom';
}

/** 残り時間を「約2時間10分」のように読める形にする */
function formatEta(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds <= 0) return null;
  if (seconds < 60) return t('約{0}秒', { 0: Math.ceil(seconds) });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('約{minutes}分', { minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? t('約{hours}時間', { hours }) : t('約{hours}時間{rest}分', { hours, rest });
}

export default function StatusBar({
  onSyncHistory,
  progress,
  lastSyncAt,
  shown,
  total,
  meta,
  onMetaEnabled,
  onMetaSpeed,
  onMetaRunNow,
  downloads,
  jobs,
  onOpenDownloads,
  onOpenImport,
  onOpenSettings
}: Props): JSX.Element {
  const active = downloads.filter((d) => d.state === 'running' || d.state === 'queued').length;
  const failed =
    downloads.filter((d) => d.state === 'error').length +
    // ダウンロードパネルに表示する失敗行と同じ件数にする（再試行前の履歴も含む）。
    jobs.filter((j) => j.state === 'error').length;
  const processing = jobs.filter((j) => j.state === 'running' || j.state === 'queued').length;
  const runningJob = jobs.find((j) => j.state === 'running');
  const running = progress?.phase === 'running';
  const pct =
    running && progress?.total ? Math.min(100, Math.round((progress.fetched / progress.total) * 100)) : null;

  return (
    <footer className="statusbar">
      <div className="statusbar__left">
        <button className="link" onClick={onSyncHistory}>{t('同期履歴')}</button>
        {progress?.error ? (
          <span className="statusbar__error">{progress.error}</span>
        ) : (
          <span>{progress?.message ?? t('{0} / {1} 件を表示', { 0: shown.toLocaleString(), 1: total.toLocaleString() })}</span>
        )}
      </div>
      {running && (
        <div className="progress">
          <div className="progress__bar" style={{ width: pct === null ? '30%' : `${pct}%` }} />
        </div>
      )}
      {/* 作品メタは裏で1件ずつ集める。負荷を見ながら間隔を変えられるようにしておく */}
      {meta && (
        <div className="statusbar__meta">
          <label className="statusbar__toggle" title={t('作品の説明文やダウンロード導線を裏で少しずつ取得します')}>
            <input
              type="checkbox"
              checked={meta.enabled}
              onChange={(e) => onMetaEnabled(e.target.checked)}
            />
            {t('詳細を自動取得')}
          </label>
          <select
            className="select select--xs"
            value={speedKeyOf(meta.intervalMs, meta.concurrency)}
            disabled={!meta.enabled}
            onChange={(e) => {
              const speed = SPEEDS.find((s) => s.key === e.target.value);
              if (speed) onMetaSpeed(speed.intervalMs, speed.concurrency);
            }}
            title={t('取得の速さ（並列数と1件ごとの待ち時間）')}
          >
            {SPEEDS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
            {speedKeyOf(meta.intervalMs, meta.concurrency) === 'custom' && (
              <option value="custom">
                {t('{concurrency}並列 / {intervalMs}ms', { concurrency: meta.concurrency, intervalMs: meta.intervalMs })}
              </option>
            )}
          </select>
          <span className="muted">
            {meta.pending > 0 ? t('残り {0} 件', { 0: meta.pending.toLocaleString() }) : t('取得済み')}
            {meta.blocked > 0 ? t('（未ログイン分 {0} 件）', { 0: meta.blocked.toLocaleString() }) : ''}
            {/* 残り時間は実測の処理速度から出す（設定値どおりには進まないため） */}
            {meta.pending > 0 && formatEta(meta.etaSeconds) ? t('・{0}', { 0: formatEta(meta.etaSeconds) }) : ''}
            {meta.enabled && meta.pausedReason ? t('（{pausedReason}）', { pausedReason: meta.pausedReason }) : ''}
          </span>
          {/* 待たずに取りかかる。以降は設定した間隔で1件ずつ進む */}
          <button
            className="btn btn--xs"
            disabled={meta.pending === 0}
            onClick={onMetaRunNow}
            title={t('未取得のぶんを、いまから順に取得します（間隔は左の設定どおり）')}
          >
            {t('残りを取得')}
          </button>
        </div>
      )}

      {/* ダウンロードはここから開く。走っている件数が常に見えるようにする */}
      <button className="btn btn--xs statusbar__dl" onClick={onOpenDownloads}>
        {t('ダウンロード')}
        {active > 0 && <span className="badge badge--running">{active}</span>}
        {processing > 0 && (
          <span
            className="badge badge--queued"
            title={runningJob ? t('{0}中: {1} {2}%', { 0: JOB_LABELS[runningJob.kind], 1: runningJob.title ?? '', 2: Math.round(runningJob.progress * 100) }) : t('展開・変換の待ち')}
          >
            {runningJob ? JOB_LABELS[runningJob.kind] : t('処理')} {processing}
          </span>
        )}
        {failed > 0 && <span className="badge badge--error">{failed}</span>}
      </button>

      <button className="btn btn--xs" onClick={onOpenImport} title={t('手元にあるファイルを取り込みます')}>
        {t('取り込み')}
      </button>

      <div className="statusbar__right muted">
        {t('最終同期: {0}', { 0: lastSyncAt ? new Date(lastSyncAt).toLocaleString(locale()) : t('未実行') })}
      </div>
    </footer>
  );
}
