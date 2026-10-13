import { t } from '@shared/i18n';
import type {
InstalledToolInfo,
ToolName,
ToolStatus
} from '@shared/types';
import ToolRow,{ TOOLS } from './ToolRow';

export default function ToolsSettings({ tools, installed, reload }: {
  tools: ToolStatus;
  installed: Record<ToolName, InstalledToolInfo | null> | null;
  reload: () => Promise<void>;
}): JSX.Element {
  return (<section className="settings">
                <p className="muted">
                  {t('外部ツールはアプリに同梱していません。PC にインストール済みならそれを使います。無い場合は、配布元（GitHub のリリース）から取得して下のフォルダに入れられます。取得したファイルは、配布元が公開しているチェックサムで確認します。')}
                </p>
                <div className="detail__heading">{t('外部ツール')}</div>
                <div className="settings__row">
                  <span className="settings__label">{t('ツールのフォルダ')}</span>
                  <code className="dlbar__path">{tools.toolsDir}</code>
                  <button className="btn btn--xs" onClick={() => void window.api.tools.openDir()}>
                    {t('開く')}
                  </button>
                </div>
                {TOOLS.map((tItem) => (
                  <ToolRow
                    key={tItem.key}
                    tool={tItem}
                    path={tools[tItem.key]}
                    ffprobe={tItem.key === 'ffmpeg' ? tools.ffprobe : undefined}
                    source={tools.sources[tItem.key]}
                    installed={installed?.[tItem.key] ?? null}
                    onChanged={() => void reload()}
                  />
                ))}
              </section>);
}
