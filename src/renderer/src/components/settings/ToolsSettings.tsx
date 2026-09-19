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
                  {t('外部ツールは同梱していません。PC に入っていればそれを使い、無ければ配布元（GitHub のリリース）から取得して、下のフォルダに入れられます。取得したファイルは配布元のチェックサムと照合します。')}
                </p>
                <div className="settings__row">
                  <span className="settings__label">{t('ツールの置き場所')}</span>
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
