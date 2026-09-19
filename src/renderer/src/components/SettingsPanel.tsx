import { t } from '@shared/i18n';
import type {
DownloadSettings,
InstalledToolInfo,
LoginStatus,
PostProcessSettings,
RelocationPlan,
ServiceWarning,
ToolName,
ToolStatus
} from '@shared/types';
import { useCallback,useEffect,useState } from 'react';
import About from './settings/About';
import AccountSettings from './settings/AccountSettings';
import DownloadSettingsSection from './settings/DownloadSettings';
import GameSettings from './settings/GameSettings';
import GeneralSettings from './settings/GeneralSettings';
import { TOOLS } from './settings/ToolRow';
import ToolsSettings from './settings/ToolsSettings';
import ViewerSettings from './settings/ViewerSettings';
import VoiceSettings from './settings/VoiceSettings';

interface Props {
  onClose: () => void;
  /** 最初に開く項目 */
  initialSection?: Section;
  /** サイトごとのログイン状態 */
  auth: LoginStatus[];
  siteLabels: Record<string, string>;
  /** 本体とは別にログインが要るサービスのうち、未ログインのもの */
  serviceWarnings: ServiceWarning[];
  onLogin: (siteId: string) => void;
  onLoginService: (siteId: string, service: string) => void;
  onLogout: (siteId: string) => void;
  onRecheck: () => void;
  /** ID/PW の保存ダイアログを開く */
  onEditCredentials: (siteId: string) => void;
  /** ファイルを移したあと（一覧の件数などを読み直させる） */
  onFilesMoved: () => void;
}

type Section = 'general' | 'account' | 'download' | 'game' | 'voice' | 'viewer' | 'tools' | 'about';

const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: 'general', label: t('全般') },
  { key: 'account', label: t('アカウント') },
  { key: 'download', label: t('ダウンロード') },
  { key: 'game', label: t('ゲーム') },
  { key: 'viewer', label: t('画像・CG') },
  { key: 'voice', label: t('ASMR・ボイス') },
  { key: 'tools', label: t('ツール') },
  { key: 'about', label: t('このアプリについて') }
];

export default function SettingsPanel({
  onClose,
  initialSection = 'download',
  auth,
  siteLabels,
  serviceWarnings,
  onLogin,
  onLoginService,
  onLogout,
  onRecheck,
  onEditCredentials,
  onFilesMoved
}: Props): JSX.Element {
  const [section, setSection] = useState<Section>(initialSection);
  /** 保存先・フォルダ構成を変えたあとの「既存のファイルを移しますか？」 */
  const [relocation, setRelocation] = useState<{ plan: RelocationPlan; reason: string } | null>(null);
  const [relocationMessage, setRelocationMessage] = useState<string | null>(null);
  const loginWarnings = auth.filter((a) => !a.loggedIn || a.uncertain);
  const [download, setDownload] = useState<DownloadSettings | null>(null);
  const [post, setPost] = useState<PostProcessSettings | null>(null);
  const [tools, setTools] = useState<ToolStatus | null>(null);
  const [installed, setInstalled] = useState<Record<ToolName, InstalledToolInfo | null> | null>(null);

  const reload = useCallback(async () => {
    setDownload(await window.api.download.settings());
    const s = await window.api.jobs.settings();
    setPost(s.settings);
    const tItem = await window.api.tools.status();
    setTools(tItem.status);
    setInstalled(tItem.installed);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const savePost = (next: Partial<PostProcessSettings>): void => {
    void window.api.jobs.saveSettings(next).then((r) => {
      setPost(r.settings);
      setTools(r.tools);
    });
  };
  const saveDownload = (next: Partial<DownloadSettings>): void => {
    void window.api.download.saveSettings(next).then(setDownload);
  };

  /** 変更のあと、移すべきファイルがあれば確認を出す */
  const offerRelocation = async (reason: string): Promise<void> => {
    setRelocationMessage(null);
    const plan = await window.api.download.relocationPlan();
    if (plan.items.length > 0) setRelocation({ plan, reason });
    else setRelocationMessage(t('移すファイルはありません（すべて今の保存先・フォルダ構成どおりです）。'));
  };

  const missing = tools ? TOOLS.filter((tItem) => !tools[tItem.key]) : [];

  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="modal__panel modal__panel--settings">
        <div className="modal__head">
          <h3>{t('設定')}</h3>
          <button className="detail__close" onClick={onClose} aria-label={t('閉じる')}>
            ×
          </button>
        </div>

        {missing.filter((item) => item.key !== 'neeview').length > 0 && section !== 'tools' && (
          <div className="banner settings__banner">
            {t('{0} が見つかりません。', { 0: missing.filter((item) => item.key !== 'neeview').map((tItem) => tItem.label).join(t('・')) })}
            <button className="link" onClick={() => setSection('tools')}>
              {t('ツールの設定を開く')}
            </button>
          </div>
        )}

        <div className="settingsLayout">
          <nav className="settingsNav">
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                className={`settingsNav__item ${section === s.key ? 'settingsNav__item--active' : ''}`}
                onClick={() => setSection(s.key)}
              >
                {s.label}
                {s.key === 'tools' && missing.length > 0 && <span className="badge badge--error">{missing.length}</span>}
                {s.key === 'account' && loginWarnings.length + serviceWarnings.length > 0 && (
                  <span className="badge badge--error">{loginWarnings.length + serviceWarnings.length}</span>
                )}
              </button>
            ))}
          </nav>

          <div className="settingsBody">
            {section === 'account' && (
              <AccountSettings auth={auth} siteLabels={siteLabels} serviceWarnings={serviceWarnings} onLogin={onLogin} onLoginService={onLoginService} onLogout={onLogout} onRecheck={onRecheck} onEditCredentials={onEditCredentials} />
            )}

            {section === 'about' && <About />}

            {section === 'general' && (
              <GeneralSettings />
            )}

            {section === 'download' && download && (
              <DownloadSettingsSection download={download} setDownload={setDownload} offerRelocation={offerRelocation} relocationMessage={relocationMessage} relocation={relocation} setRelocation={setRelocation} setRelocationMessage={setRelocationMessage} onFilesMoved={onFilesMoved} saveDownload={saveDownload} post={post} tools={tools} savePost={savePost} />
            )}

            {section === 'game' && post && (
              <GameSettings post={post} savePost={savePost} />
            )}

            {section === 'viewer' && (
              <ViewerSettings post={post} tools={tools} savePost={savePost} />
            )}

            {section === 'voice' && post && (
              <VoiceSettings post={post} tools={tools} savePost={savePost} setSection={setSection} />
            )}

            {section === 'tools' && tools && (
              <ToolsSettings tools={tools} installed={installed} reload={reload} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

