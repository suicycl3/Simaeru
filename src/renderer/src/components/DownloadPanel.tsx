import { useState } from 'react';
import type { DownloadRow, JobRow } from '@shared/types';
import { formatBytes, formatDuration } from '../lib/format';
import { JOB_LABELS } from '../lib/labels';

import { t } from '@shared/i18n';
import { storedLabel } from '../lib/labels';
interface Props {
  rows: DownloadRow[];
  jobs: JobRow[];
  onClose: () => void;
  onChanged: () => void;
  onOpenSettings: () => void;
}


const JOB_STATE_LABELS: Record<JobRow['state'], string> = {
  queued: t('待機'),
  running: t('処理中'),
  done: t('完了'),
  error: t('失敗'),
  canceled: t('中止')
};

const STATE_LABELS: Record<DownloadRow['state'], string> = {
  queued: t('待機'),
  running: t('取得中'),
  paused: t('一時停止'),
  done: t('完了'),
  error: t('失敗'),
  canceled: t('中止')
};

/** 今回のまとまりの進み具合。容量は作品ごとに数える（分割の行は大きさが分かるまで作品全体のサイズで見込む） */
function summarize(rows: DownloadRow[]): { received: number; total: number; unknown: number } {
  const byProduct = new Map<number, DownloadRow[]>();
  for (const r of rows) byProduct.set(r.productRef, [...(byProduct.get(r.productRef) ?? []), r]);
  let received = 0;
  let total = 0;
  let unknown = 0;
  for (const list of byProduct.values()) {
    const known = list.reduce((n, r) => n + (r.totalBytes ?? 0), 0);
    const size = list.every((r) => r.totalBytes) ? known : Math.max(known, list[0].productBytes ?? 0);
    if (size <= 0) unknown++;
    total += size;
    received += list.reduce((n, r) => n + (r.state === 'done' ? (r.totalBytes ?? r.receivedBytes) : r.receivedBytes), 0);
  }
  return { received: Math.min(received, total || received), total, unknown };
}

/**
 * ダウンロードのキュー。進行中・待機・完了・失敗を1つのリストで見る。
 * 失敗は「何が起きたか」ではなく「どうすれば直るか」を出す。
 */
export default function DownloadPanel({ rows, jobs, onClose, onChanged, onOpenSettings }: Props): JSX.Element {
  const [tab, setTab] = useState<'downloads' | 'jobs'>('downloads');

  const act = async (fn: Promise<unknown>): Promise<void> => {
    await fn;
    onChanged();
  };

  const running = rows.filter((r) => r.state === 'running' || r.state === 'queued').length;
  const jobsActive = jobs.filter((j) => j.state === 'running' || j.state === 'queued').length;

  const count = (...states: DownloadRow['state'][]): number => rows.filter((r) => states.includes(r.state)).length;
  const resumable = count('paused', 'error', 'canceled');
  const pausable = count('running', 'queued');
  const finished = count('done', 'canceled');
  // 今回のまとまり（キューが空の状態から積んだぶん）。中止したものは数えない
  const batch = rows.filter((r) => r.inBatch && r.state !== 'canceled');
  const batchDone = batch.filter((r) => r.state === 'done').length;
  const bytes = summarize(batch);
  const speed = rows.reduce((n, r) => n + (r.state === 'running' ? (r.bytesPerSec ?? 0) : 0), 0);
  const remaining = speed > 0 && bytes.unknown === 0 && bytes.total > bytes.received ? (bytes.total - bytes.received) / speed : null;
  const batchPct = bytes.total > 0 ? Math.min(100, (bytes.received / bytes.total) * 100) : batch.length > 0 ? (batchDone / batch.length) * 100 : 0;
  const batchCounts = [
    [t('取得中'), batch.filter((r) => r.state === 'running').length],
    [t('待機'), batch.filter((r) => r.state === 'queued').length],
    [t('一時停止'), batch.filter((r) => r.state === 'paused').length],
    [t('失敗'), batch.filter((r) => r.state === 'error').length]
  ] as const;

  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="modal__panel modal__panel--wide">
        <div className="modal__head">
          <h3>{t('ダウンロード{0}', { 0: running > 0 ? t('（{running} 件）', { running }) : '' })}</h3>
          <button className="detail__close" onClick={onClose} aria-label={t('閉じる')}>
            ×
          </button>
        </div>

        <div className="tabs">
          <button className={`tab ${tab === 'downloads' ? 'tab--active' : ''}`} onClick={() => setTab('downloads')}>
            {t('ダウンロード{0}', { 0: running > 0 ? t('（{running}）', { running }) : '' })}
          </button>
          <button className={`tab ${tab === 'jobs' ? 'tab--active' : ''}`} onClick={() => setTab('jobs')}>
            {t('展開・変換{0}', { 0: jobsActive > 0 ? t('（{jobsActive}）', { jobsActive }) : '' })}
          </button>
          {/* 保存先・帯域・展開の決まり・ツールは設定画面にまとめた */}
          <button className="tab tab--link" onClick={onOpenSettings}>
            {t('設定…')}
          </button>
        </div>

        {tab === 'jobs' && (
          <div className="dlrows">
            {jobs.length === 0 && <p className="muted">{t('展開・変換の履歴はありません。')}</p>}
            {jobs.map((j) => (
              <div className="dlrow" key={j.id}>
                <span className={`badge badge--${j.state === 'canceled' ? 'canceled' : j.state}`}>{JOB_STATE_LABELS[j.state]}</span>
                <div className="dlrow__body">
                  <div className="dlrow__title" title={j.title ?? j.source}>
                    {t('{0}{1} ・ {2}', { 0: JOB_LABELS[j.kind], 1: j.auto ? t('（自動）') : '', 2: j.title ?? j.source.split('\\').pop() })}
                  </div>
                  <div className="muted dlrow__sub" title={j.source}>
                    {j.message ?? ''} {j.target ? ` → ${j.target}` : ''}
                  </div>
                  {j.result?.skipped && j.result.skipped.length > 0 && (
                    <details className="muted dlrow__sub">
                      <summary>{t('対象外 {length} 件', { length: j.result.skipped.length })}</summary>
                      {j.result.skipped.slice(0, 20).map((sk) => (
                        <div key={sk.path}>
                          {sk.path.split('\\').pop()}: {sk.reason}
                        </div>
                      ))}
                    </details>
                  )}
                  {j.error && <div className="dlrow__error">{j.error}</div>}
                  {j.state === 'running' && (
                    <div className="bar">
                      <i className="bar__fill bar__fill--running" style={{ width: `${Math.round(j.progress * 100)}%` }} />
                    </div>
                  )}
                </div>
                <div className="dlrow__actions">
                  {(j.state === 'running' || j.state === 'queued') && (
                    <button className="btn btn--xs btn--ghost" onClick={() => void window.api.jobs.cancel(j.id)}>
                      {t('中止')}
                    </button>
                  )}
                  {(j.state === 'error' || j.state === 'canceled') && (
                    <button className="btn btn--xs" onClick={() => void window.api.jobs.retry(j.id)}>
                      {t('やり直す')}
                    </button>
                  )}
                  {j.state === 'done' && j.target && (
                    <button className="btn btn--xs" onClick={() => void window.api.showInFolder(j.target!)}>
                      {t('場所を開く')}
                    </button>
                  )}
                  {j.state !== 'running' && (
                    <button className="btn btn--xs btn--ghost" onClick={() => void window.api.jobs.remove(j.id)}>
                      {t('削除')}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'downloads' && rows.length > 0 && (
          <div className="dlsum">
            {batch.length > 0 && (
              <>
                <div className="dlsum__stats">
                  <span className="dlsum__main">
                    {t('{done} / {total} 件完了', { done: batchDone.toLocaleString(), total: batch.length.toLocaleString() })}
                  </span>
                  <span title={bytes.unknown > 0 ? t('大きさが分からない作品が {unknown} 件あります', { unknown: bytes.unknown }) : undefined}>
                    {bytes.received > 0 ? formatBytes(bytes.received) : '0 B'} / {formatBytes(bytes.total)}
                    {bytes.unknown > 0 ? t('（ほか不明 {unknown} 件）', { unknown: bytes.unknown }) : ''}
                  </span>
                  <span>{speed > 0 ? `${formatBytes(speed)}/s` : t('速度 —')}</span>
                  {remaining !== null && <span>{t('残り {0}', { 0: formatDuration(remaining) })}</span>}
                  <span className="muted">
                    {batchCounts
                      .filter(([, n]) => n > 0)
                      .map(([label, n]) => `${label} ${n}`)
                      .join(' ・ ')}
                  </span>
                </div>
                <div className="bar">
                  <i className="bar__fill bar__fill--running" style={{ width: `${batchPct}%` }} />
                </div>
              </>
            )}
            <div className="dlsum__actions">
              <button className="btn btn--xs" disabled={resumable === 0} onClick={() => void act(window.api.download.resumeAll())}>
                {t('すべて再開{0}', { 0: resumable > 0 ? t('（{resumable}）', { resumable }) : '' })}
              </button>
              <button className="btn btn--xs" disabled={pausable === 0} onClick={() => void act(window.api.download.pauseAll())}>
                {t('すべて一時停止{0}', { 0: pausable > 0 ? t('（{pausable}）', { pausable }) : '' })}
              </button>
              <button
                className="btn btn--xs btn--ghost"
                disabled={finished === 0}
                title={t('ダウンロードしたファイルは消しません')}
                onClick={() => void act(window.api.download.clearFinished())}
              >
                {t('完了・中止を一覧から消す')}
              </button>
            </div>
          </div>
        )}

        {tab === 'downloads' && (
        <div className="dlrows">
          {rows.length === 0 && <p className="muted">{t('キューは空です。')}</p>}
          {rows.map((r) => {
            const pct =
              r.totalBytes && r.totalBytes > 0
                ? Math.min(100, Math.round((r.receivedBytes / r.totalBytes) * 100))
                : null;
            return (
              <div className="dlrow" key={r.id}>
                <span
                  className={`badge badge--${r.preparing ? 'running' : r.state}`}
                  title={r.preparing ? t('ダウンロード用の URL を取り直しています') : undefined}
                >
                  {r.preparing ? t('準備中') : STATE_LABELS[r.state]}
                </span>
                <div className="dlrow__body">
                  <div className="dlrow__title" title={r.title}>
                    {r.title}
                  </div>
                  <div className="muted dlrow__sub">
                    {t('{label} ・ {1}{2}{3}', {
                      label: storedLabel(r.label),
                      1: formatBytes(r.receivedBytes),
                      2: r.totalBytes ? ` / ${formatBytes(r.totalBytes)}` : r.productBytes && r.linkKind === 'main' ? ` / ${formatBytes(r.productBytes)}` : '',
                      3: r.state === 'running' && r.bytesPerSec ? ` ・ ${formatBytes(r.bytesPerSec)}/s` : ''
                    })}
                    {r.savePath ? t(' ・ {savePath}', { savePath: r.savePath }) : ''}
                  </div>
                  {r.error && <div className="dlrow__error">{r.error}</div>}
                  {(r.state === 'running' || r.state === 'paused' || r.state === 'done') && (
                    <div className="bar">
                      <i
                        className={`bar__fill bar__fill--${r.state}`}
                        style={{ width: `${pct ?? 30}%` }}
                      />
                    </div>
                  )}
                </div>
                <div className="dlrow__actions">
                  {r.state === 'running' && (
                    <button className="btn btn--xs" onClick={() => void act(window.api.download.pause(r.id))}>
                      {t('一時停止')}
                    </button>
                  )}
                  {r.state === 'queued' && (
                    <button
                      className="btn btn--xs btn--ghost"
                      title={t('順番が来ても始めないようにします')}
                      onClick={() => void act(window.api.download.pause(r.id))}
                    >
                      {t('一時停止')}
                    </button>
                  )}
                  {(r.state === 'paused' || r.state === 'error') && (
                    <button className="btn btn--xs" onClick={() => void act(window.api.download.resume(r.id))}>
                      {r.state === 'paused' && r.receivedBytes > 0 ? t('続きから') : t('再開')}
                    </button>
                  )}
                  {r.state === 'canceled' && (
                    <button className="btn btn--xs" onClick={() => void act(window.api.download.retry(r.id))}>
                      {t('やり直す')}
                    </button>
                  )}
                  {r.state === 'done' && r.savePath && (
                    <button
                      className="btn btn--xs"
                      onClick={() => void window.api.showInFolder(r.savePath!)}
                    >
                      {t('場所を開く')}
                    </button>
                  )}
                  {r.state !== 'done' && r.state !== 'running' && (
                    <button
                      className="btn btn--xs btn--ghost"
                      onClick={() => void act(window.api.download.remove(r.id))}
                    >
                      {t('削除')}
                    </button>
                  )}
                  {r.state === 'running' && (
                    <button
                      className="btn btn--xs btn--ghost"
                      onClick={() => void act(window.api.download.cancel(r.id))}
                    >
                      {t('中止')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        )}
      </div>
    </div>
  );
}
