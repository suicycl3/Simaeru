import { useCallback, useEffect, useState } from 'react';
import type { ScanGroup, ScanResult } from '@shared/types';
import { t } from '@shared/i18n';

interface Props {
  onClose: () => void;
  onLinked: () => void;
}

function formatBytes(bytes: number): string {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

const CONFIDENCE_LABELS: Record<string, string> = {
  id: t('作品ID一致'),
  high: t('確度 高'),
  medium: t('確度 中')
};

/** まとまりを見分ける鍵。同じフォルダでも候補が違えば別の行になる */
function groupKey(group: ScanGroup): string {
  return `${group.dir}|${group.candidates.map((c) => c.productId).join(',')}`;
}

/** 最初から見せるファイル数。分割書庫などで数が多いときは畳む */
const SHOWN_FILES = 4;

/**
 * 手元のファイルを取り込む画面。
 * 作品IDが1件だけ一致したものは走査中に自動で紐付く。ここに出るのは判断が要るものだけ。
 * 同じフォルダで候補も同じファイルは1行にまとめ、まとめて紐付けられるようにしている。
 */
export default function ImportPanel({ onClose, onLinked }: Props): JSX.Element {
  const [folders, setFolders] = useState<string[]>([]);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [done, setDone] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void window.api.importFiles.folders().then(setFolders);
    return window.api.on.importProgress((p) => setProgress(p.message));
  }, []);

  const scan = useCallback(async () => {
    setScanning(true);
    setResult(null);
    setDone({});
    try {
      const res = await window.api.importFiles.scan();
      setResult(res);
      onLinked();
    } finally {
      setScanning(false);
    }
  }, [onLinked]);

  const link = async (group: ScanGroup, productId: number | null): Promise<void> => {
    await window.api.importFiles.linkMany(group.files, productId);
    setDone((prev) => ({ ...prev, [groupKey(group)]: productId === null ? t('無視') : t('紐付け済み') }));
    onLinked();
  };

  const pendingFiles = result ? result.pending.reduce((n, g) => n + g.files.length, 0) : 0;

  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="modal__panel modal__panel--wide">
        <div className="modal__head">
          <h3>{t('手元のファイルを取り込む')}</h3>
          <button className="detail__close" onClick={onClose} aria-label={t('閉じる')}>
            ×
          </button>
        </div>

        <div className="dlbar">
          <span className="muted">{t('走査するフォルダ')}</span>
          <button
            className="btn btn--xs"
            onClick={() => void window.api.importFiles.addFolder().then(setFolders)}
          >
            {t('追加…')}
          </button>
          <button className="btn btn--xs btn--primary" disabled={scanning} onClick={() => void scan()}>
            {scanning ? t('走査中…') : t('スキャン')}
          </button>
        </div>
        <div className="sidebar__chips">
          {folders.map((f) => (
            <button
              key={f}
              className="chip chip--button"
              title={t('このフォルダを外す')}
              onClick={() => void window.api.importFiles.removeFolder(f).then(setFolders)}
            >
              {f} ×
            </button>
          ))}
        </div>
        <p className="field__hint">
          {t('読み取りだけです。ファイルの移動も名前の変更もしません。')}
        </p>

        {scanning && progress && <p className="muted">{progress}</p>}

        {result && (
          <>
            <div className="dlbar">
              <span className="badge badge--done">{t('自動で紐付け {linked}', { linked: result.linked })}</span>
              <span className="badge badge--queued">
                {t('要確認 {0} フォルダ・{1} ファイル', { 0: result.pending.length, 1: pendingFiles })}
              </span>
              <span className="muted">
                {t('走査 {0} 件 ・ 登録済み {1} 件', { 0: result.scanned.toLocaleString(), 1: result.skipped.toLocaleString() })}
              </span>
            </div>

            <div className="dlrows">
              {result.pending.length === 0 && (
                <p className="muted">{t('判断が要るファイルはありませんでした。')}</p>
              )}
              {result.pending.map((group) => {
                const key = groupKey(group);
                const open = !!expanded[key];
                const shown = open ? group.files : group.files.slice(0, SHOWN_FILES);
                const rest = group.files.length - shown.length;
                return (
                  <div className="dlrow" key={key}>
                    <div className="dlrow__body">
                      <div className="dlrow__title" title={group.dir}>
                        {group.label}
                      </div>
                      {/* フォルダ名だけでは SaveGraphic のような名前がどこのものか分からないので、場所も出す */}
                      <div className="dlrow__sub dlrow__sub--path" title={group.dir}>
                        {group.dir}
                      </div>
                      <div className="muted">
                        {t('{0} ファイル ・ {1}', { 0: group.files.length, 1: formatBytes(group.sizeBytes) })}
                      </div>
                      {shown.map((f) => (
                        <div className="dlrow__sub" key={f.path} title={f.path}>
                          {f.path.slice(group.dir.length + 1) || f.path}
                        </div>
                      ))}
                      {rest > 0 && (
                        <button
                          className="btn btn--xs btn--ghost"
                          onClick={() => setExpanded((prev) => ({ ...prev, [key]: true }))}
                        >
                          {t('ほか {0} 件を見る', { 0: rest })}
                        </button>
                      )}
                      {group.candidates.length === 0 && (
                        <div className="muted">
                          {t('購入履歴に一致する作品がありません（未購入 / 別アカウントの可能性）')}
                        </div>
                      )}
                      {group.candidates.map((c) => (
                        <div className="importcand" key={c.productId}>
                          <span className="badge badge--queued">
                            {CONFIDENCE_LABELS[c.confidence] ?? c.confidence}
                          </span>
                          <span className="importcand__title" title={c.title}>
                            {c.title}
                          </span>
                          <button
                            className="btn btn--xs"
                            disabled={!!done[key]}
                            onClick={() => void link(group, c.productId)}
                          >
                            {group.files.length > 1 ? t('まとめて紐付ける') : t('紐付ける')}
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="dlrow__actions">
                      {done[key] ? (
                        <span className="badge badge--done">{done[key]}</span>
                      ) : (
                        <button className="btn btn--xs btn--ghost" onClick={() => void link(group, null)}>
                          {t('無視')}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
