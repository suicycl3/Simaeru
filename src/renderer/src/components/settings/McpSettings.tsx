import { useEffect, useState } from 'react';
import type { McpStatus } from '@shared/types';
import { t } from '@shared/i18n';
import { MCP_TOOL_KIND_LABELS, MCP_TOOLS } from '@shared/mcpTools';

/** AI のアプリごとの設定ファイルに書く内容。鍵はそのまま入れる */
function clientConfigs(url: string, token: string): Array<{ key: string; label: string; text: string }> {
  return [
    {
      key: 'claude-json',
      label: t('Claude Code（.mcp.json）'),
      text: JSON.stringify({ mcpServers: { simaeru: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)
    },
    {
      key: 'codex',
      label: t('Codex（config.toml）'),
      text: `[mcp_servers.simaeru]\nurl = "${url}"\nhttp_headers = { "Authorization" = "Bearer ${token}" }`
    }
  ];
}

/**
 * MCP サーバー。AI のアプリ（Claude Code など）から、ライブラリの検索や操作ができるようにする。
 * 既定はオフ。この PC の中だけで待ち受け、鍵を知っているアプリだけが使える
 */
export default function McpSettings(): JSX.Element | null {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [port, setPort] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    void window.api.mcp.status().then((s) => {
      setStatus(s);
      setPort(String(s.port));
    });
  }, []);
  if (!status) return null;
  const copy = (key: string, text: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    });
  };
  const masked = (text: string): string => (showToken ? text : text.split(status.token).join('•'.repeat(12)));
  const kindLabels = MCP_TOOL_KIND_LABELS();
  return (
    <section className="settings">
      <div className="detail__heading">{t('MCP サーバー')}</div>
      <label className="settings__row check">
        <input
          type="checkbox"
          checked={status.enabled}
          onChange={(e) => void window.api.mcp.setEnabled(e.target.checked).then(setStatus)}
        />
        <span>{t('MCP サーバーを有効にする')}</span>
      </label>
      {status.enabled && (
        <div className="settings__row">
          <span className="settings__label">{t('状態')}</span>
          <span className={status.running ? '' : 'stats__error'}>
            {status.running ? t('待ち受け中') : t('待ち受けられませんでした: {0}', { 0: status.error ?? '' })}
          </span>
        </div>
      )}

      {status.enabled && (
        <>
          <div className="detail__heading">{t('接続')}</div>
          <div className="settings__row">
            <span className="settings__label">{t('接続先')}</span>
            <code className="dlbar__path">{status.url}</code>
            <button className="btn btn--xs" onClick={() => copy('url', status.url)}>
              {copied === 'url' ? t('コピーしました') : t('コピー')}
            </button>
          </div>
          <div className="settings__row">
            <span className="settings__label">{t('鍵')}</span>
            <code className="dlbar__path">{masked(status.token)}</code>
            <button className="btn btn--xs btn--ghost" onClick={() => setShowToken((v) => !v)}>
              {showToken ? t('隠す') : t('表示')}
            </button>
            <button className="btn btn--xs" onClick={() => copy('token', status.token)}>
              {copied === 'token' ? t('コピーしました') : t('コピー')}
            </button>
            <button className="btn btn--xs btn--ghost" onClick={() => void window.api.mcp.regenerateToken().then(setStatus)}>
              {t('作り直す')}
            </button>
          </div>
          <p className="muted detail__note">
            {t('AI のアプリには「Authorization: Bearer <鍵>」として設定します。作り直すと、前の鍵を設定したアプリはつながらなくなります。')}
          </p>
          <div className="settings__row">
            <span className="settings__label">{t('ポート')}</span>
            <input
              className="input input--sm settings__port"
              type="number"
              min={1024}
              max={65535}
              value={port}
              aria-label={t('ポート')}
              onChange={(e) => setPort(e.target.value)}
            />
            <button
              className="btn btn--xs"
              disabled={Number(port) === status.port}
              onClick={() => void window.api.mcp.setPort(Number(port)).then(setStatus).catch(() => setPort(String(status.port)))}
            >
              {t('変更')}
            </button>
          </div>

          <div className="detail__heading">{t('AI のアプリでの設定')}</div>
          {clientConfigs(status.url, status.token).map((c) => (
            <div key={c.key} className="mcpConfig">
              <div className="settings__row">
                <span className="settings__label">{c.label}</span>
                <button className="btn btn--xs mcpConfig__copy" onClick={() => copy(c.key, c.text)}>
                  {copied === c.key ? t('コピーしました') : t('コピー')}
                </button>
              </div>
              <pre className="md__code mcpConfig__text" aria-label={c.label}>
                {masked(c.text)}
              </pre>
            </div>
          ))}
        </>
      )}

      <div className="detail__heading">{t('ツール')}</div>
      <table className="mcpTools">
        <thead>
          <tr>
            <th>{t('名前')}</th>
            <th>{t('内容')}</th>
            <th>{t('種類')}</th>
          </tr>
        </thead>
        <tbody>
          {MCP_TOOLS().map((tool) => (
            <tr key={tool.name}>
              <td>
                <code>{tool.name}</code>
              </td>
              <td>{tool.summary}</td>
              <td className={tool.kind === 'read' ? 'muted' : 'mcpTools__kind--write'}>{kindLabels[tool.kind]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
