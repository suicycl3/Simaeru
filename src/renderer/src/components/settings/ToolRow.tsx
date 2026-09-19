import { t } from '@shared/i18n';
import type { InstalledToolInfo,ToolInstallProgress,ToolName } from '@shared/types';
import { useEffect,useState } from 'react';
import { formatBytes } from '../../lib/format';

export const TOOLS: Array<{ key: ToolName; label: string; purpose: string; license: string }> = [
  { key: 'sevenZip', label: '7-Zip', purpose: t('ゲームの展開、zip 以外（rar / 7z）の閲覧、FLAC 化したあとの zip の作り直し'), license: t('LGPL（unRAR 制限あり）') },
  { key: 'ffmpeg', label: 'ffmpeg', purpose: t('WAV → FLAC 変換と、その検証'), license: t('LGPL 版を取得') },
  { key: 'neeview', label: 'NeeView', purpose: t('漫画・CG 集を外部ビューアで開く（入っていなければ内蔵ビューアで開きます）'), license: 'MIT' }
];

const SOURCE_LABELS: Record<string, string> = {
  configured: t('指定した場所'),
  bundled: t('このアプリで入れたもの'),
  system: t('PC にインストール済みのもの')
};

export default function ToolRow({
  tool,
  path,
  ffprobe,
  source,
  installed,
  onChanged
}: {
  tool: (typeof TOOLS)[number];
  path: string | null;
  ffprobe?: string | null;
  source: string | null;
  installed: InstalledToolInfo | null;
  onChanged: () => void;
}): JSX.Element {
  const [plan, setPlan] = useState<{ version: string; assets: Array<{ name: string; size: number }>; source: string } | null>(null);
  const [progress, setProgress] = useState<ToolInstallProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(
    () =>
      window.api.on.toolsProgress((p) => {
        if (p.tool !== tool.key) return;
        setProgress(p);
        if (p.phase === 'error') setError(p.message);
        if (p.phase === 'done') onChanged();
      }),
    [tool.key, onChanged]
  );

  const busy = !!progress && !['done', 'error'].includes(progress.phase);
  const clean = (err: unknown): string =>
    (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  return (
    <div className="tool">
      <div className="tool__head">
        <b>{tool.label}</b>
        {path ? <span className="tag tag--ok">{t('使えます')}</span> : <span className="tag tag--warn">{t('見つかりません')}</span>}
        <span className="muted tool__license">{tool.license}</span>
      </div>
      <div className="muted tool__purpose">{tool.purpose}</div>
      {path && (
        <div className="muted tool__path" title={path}>
          {SOURCE_LABELS[source ?? ''] ?? ''}: {path}
          {installed && source === 'bundled' ? t('（版 {version}）', { version: installed.version }) : ''}
        </div>
      )}
      {tool.key === 'ffmpeg' && path && !ffprobe && (
        <div className="dlrow__error">{t('ffprobe が見つかりません（変換結果の検証に使います）。自動で入れると一緒に入ります。')}</div>
      )}

      <div className="install__actions">
        <button
          className="btn btn--xs btn--primary"
          disabled={busy || checking}
          onClick={() => {
            setError(null);
            setChecking(true);
            window.api.tools
              .plan(tool.key)
              .then(setPlan)
              .catch((err: unknown) => setError(clean(err)))
              .finally(() => setChecking(false));
          }}
        >
          {checking ? t('確認中…') : source === 'bundled' ? t('最新版を確認') : t('自動で入れる…')}
        </button>
        <button className="btn btn--xs" disabled={busy} onClick={() => void window.api.tools.pick(tool.key).then(onChanged)}>
          {t('場所を指定…')}
        </button>
        {source === 'configured' && (
          <button className="btn btn--xs btn--ghost" onClick={() => void window.api.tools.clearPath(tool.key).then(onChanged)}>
            {t('指定を外す')}
          </button>
        )}
        {tool.key === 'neeview' && path && (
          <button
            className="btn btn--xs"
            disabled={busy}
            title={t('NeeView の設定で「見開き」と「サブフォルダーを読み込む」を入にします（ほかの設定はそのまま）')}
            onClick={() => {
              setError(null);
              setNotice(null);
              window.api.tools
                .neeviewDefaults()
                .then((r) => setNotice(r === 'unchanged' ? t('すでに見開き・サブフォルダーを読み込む設定になっています。') : t('見開き・サブフォルダーを読み込む設定にしました。')))
                .catch((err: unknown) => setError(clean(err)));
            }}
          >
            {t('見開き・サブフォルダーの設定を入れる')}
          </button>
        )}
        {installed && (
          <button
            className="btn btn--xs btn--ghost"
            disabled={busy}
            onClick={() => void window.api.tools.uninstall(tool.key).then(onChanged)}
          >
            {t('入れたものを削除')}
          </button>
        )}
      </div>
      {notice && <p className="muted detail__note">{notice}</p>}

      {plan && !busy && (
        <div className="confirm">
          <div>
            <b>
              {tool.label} {plan.version}
            </b>{t('{0}を取得して入れます。', { 0: ' ' })}
          </div>
          <div className="muted">{t('取得元: {source}', { source: plan.source })}</div>
          <ul className="settings__list">
            {plan.assets.map((a) => (
              <li key={a.name}>
                {t('{name}（{1}）', { name: a.name, 1: formatBytes(a.size) })}
              </li>
            ))}
          </ul>
          {tool.key === 'sevenZip' && (
            <div className="muted">{t('インストーラは実行せず、中の 7z.exe / 7z.dll だけを取り出します。')}</div>
          )}
          <div className="confirm__row">
            <button
              className="btn btn--xs btn--primary"
              onClick={() => {
                setPlan(null);
                setError(null);
                window.api.tools
                  .install(tool.key)
                  .then(onChanged)
                  .catch((err: unknown) => setError(clean(err)));
              }}
            >
              {t('取得して入れる')}
            </button>
            <button className="btn btn--xs btn--ghost" onClick={() => setPlan(null)}>
              {t('やめる')}
            </button>
          </div>
        </div>
      )}

      {progress && busy && (
        <div className="file__job">
          <div className="bar">
            <i
              className="bar__fill bar__fill--running"
              style={{
                width: progress.totalBytes ? `${Math.round((progress.receivedBytes / progress.totalBytes) * 100)}%` : '30%'
              }}
            />
          </div>
          <span className="muted">
            {progress.message}
            {progress.totalBytes ? t('（{0} / {1}）', { 0: formatBytes(progress.receivedBytes), 1: formatBytes(progress.totalBytes) }) : ''}
          </span>
        </div>
      )}
      {progress?.phase === 'done' && <div className="muted">{progress.message}</div>}
      {error && <div className="dlrow__error">{error}</div>}
    </div>
  );
}
