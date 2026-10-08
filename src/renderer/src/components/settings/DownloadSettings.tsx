import { t } from '@shared/i18n';
import type {
ArchiveHandling,
DownloadSettings,
PostProcessSettings,
RelocationPlan,
ToolStatus
} from '@shared/types';
import { ARCHIVE_WORK_TYPES,WORK_TYPE_LABELS } from '@shared/types';
import { VIDEO_QUALITY_PREFS } from '@shared/videoQuality';
import { useRef } from 'react';
import { DEFAULT_TEMPLATE, FOLDER_TOKENS, SAMPLE_PRODUCT, expandTemplate, tokenValue, unknownTokens } from '@shared/folderTemplate';
import Relocation from './Relocation';
const MB = 1024 * 1024;
const RATES = [0, 1 * MB, 3 * MB, 5 * MB, 10 * MB, 20 * MB, 50 * MB];
const VIDEO_QUALITY_LABELS: Record<string, string> = {
  best: 'いちばん高い画質',
  'h:1080': 'FullHD（1080p）まで',
  'h:720': 'HD（720p）まで',
  'h:576': '576p まで',
  'h:432': '432p まで',
  'h:288': '288p まで',
  'h:144': 'いちばん低い画質'
};


export default function DownloadSettingsSection({ download, setDownload, offerRelocation, relocationMessage, relocation, setRelocation, setRelocationMessage, onFilesMoved, saveDownload, post, tools, savePost }: {
  download: DownloadSettings;
  setDownload: (value: DownloadSettings) => void;
  offerRelocation: (reason: string) => Promise<void>;
  relocationMessage: string | null;
  relocation: { plan: RelocationPlan; reason: string } | null;
  setRelocation: (value: { plan: RelocationPlan; reason: string } | null) => void;
  setRelocationMessage: (value: string | null) => void;
  onFilesMoved: () => void;
  saveDownload: (value: Partial<DownloadSettings>) => void;
  post: PostProcessSettings | null;
  tools: ToolStatus | null;
  savePost: (value: Partial<PostProcessSettings>) => void;
}): JSX.Element {
  return (<section className="settings">
                <div className="settings__row">
                  <span className="settings__label">{t('保存先')}</span>
                  <code className="dlbar__path" title={download.root}>
                    {download.root}
                  </code>
                  <button
                    className="btn btn--xs"
                    onClick={() =>
                      void window.api.download.pickRoot().then((next) => {
                        const changed = next.root !== download.root;
                        setDownload(next);
                        if (changed) void offerRelocation(t('保存先を変えました。'));
                      })
                    }
                  >
                    {t('変更…')}
                  </button>
                </div>
                <FolderTemplateField
                  root={download.root}
                  template={download.template}
                  onChange={(template) => setDownload({ ...download, template })}
                  onCommit={(template) =>
                    void window.api.download.settings().then((before) => {
                      if (before.template === template) return;
                      void window.api.download.saveSettings({ template }).then((next) => {
                        setDownload(next);
                        void offerRelocation(t('フォルダ構成を変えました。'));
                      });
                    })
                  }
                />
                <div className="settings__row">
                  <button className="btn btn--xs" onClick={() => void offerRelocation('')}>
                    {t('今の保存先・フォルダ構成に合わせて並べ直す…')}
                  </button>
                  <span className="muted">{t('以前の保存先（C: など）にあるファイルもまとめて移せます')}</span>
                </div>
                {relocationMessage && <p className="muted">{relocationMessage}</p>}
                {relocation && (
                  <Relocation
                    plan={relocation.plan}
                    reason={relocation.reason}
                    onDone={(message) => {
                      setRelocation(null);
                      setRelocationMessage(message);
                      onFilesMoved();
                    }}
                    onCancel={() => setRelocation(null)}
                  />
                )}
                <div className="settings__row">
                  <span className="settings__label">{t('同時に落とす数')}</span>
                  <select
                    className="select select--xs"
                    value={download.concurrency}
                    onChange={(e) => saveDownload({ concurrency: Number(e.target.value) })}
                  >
                    {[1, 2, 3, 4, 6, 8].map((n) => (
                      <option key={n} value={n}>
                        {t('{n} 本', { n })}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="settings__row">
                  <span className="settings__label">{t('帯域制限')}</span>
                  <select
                    className="select select--xs"
                    value={download.maxBytesPerSec}
                    onChange={(e) => saveDownload({ maxBytesPerSec: Number(e.target.value) })}
                  >
                    {RATES.map((r) => (
                      <option key={r} value={r}>
                        {r === 0 ? t('制限なし') : `${r / MB} MB/s`}
                      </option>
                    ))}
                  </select>
                  <span className="muted">{t('すべてのダウンロードの合計。短い転送では2割ほど超えることがあります。')}</span>
                </div>
                <div className="settings__row">
                  <span className="settings__label">{t('動画の画質')}</span>
                  <select
                    className="select select--xs"
                    value={download.videoQuality}
                    onChange={(e) => saveDownload({ videoQuality: e.target.value })}
                  >
                    {VIDEO_QUALITY_PREFS.map((q) => (
                      <option key={q} value={q}>
                        {t(VIDEO_QUALITY_LABELS[q])}
                      </option>
                    ))}
                  </select>
                  <span className="muted">{t('DMM 動画を「アプリでダウンロード」するときの既定。詳細からは作品ごとに選べます。')}</span>
                </div>
                {post && (
                  <>
                    <div className="detail__heading">{t('ダウンロードのあと（種別ごと）')}</div>
                    {ARCHIVE_WORK_TYPES.map((w) => (
                      <div className="settings__row" key={w}>
                        <span className="settings__label">{w === 'other' ? t('その他・種別不明') : t(WORK_TYPE_LABELS[w])}</span>
                        <select
                          className="select select--xs"
                          value={post.archiveHandling[w]}
                          disabled={!tools?.sevenZip && post.archiveHandling[w] === 'archive'}
                          onChange={(e) => savePost({ archiveHandling: { ...post.archiveHandling, [w]: e.target.value as ArchiveHandling } })}
                        >
                          <option value="archive">{t('圧縮したまま保管する')}</option>
                          <option value="extract">{t('展開して使う（zip は残す）')}</option>
                          <option value="extractDelete">{t('展開して使い、zip は削除する')}</option>
                        </select>
                      </div>
                    ))}
                    <p className="muted detail__note">
                      {t('既定では、ゲーム・ツール以外は圧縮したまま保管し、展開せずに閲覧・再生します（ファイルが数百〜数千になる作品を散らかさないため）。展開は FLAC 化などの作り直しが済んでから行います。作品ごとに、詳細の「手元のファイル」の「展開して使う」でも展開できます。ゲーム・ツールの扱いは「ゲーム」で設定します。')}
                    </p>
                  </>
                )}
              </section>);
}

/**
 * フォルダ構成の入力。トークンは意味と例つきで並べ、押すとカーソルの位置に入る。
 * 入力中の構成で、架空の作品がどこに置かれるかを例として出す
 */
function FolderTemplateField({ root, template, onChange, onCommit }: {
  root: string;
  template: string;
  onChange: (template: string) => void;
  /** 確定（欄から離れた・既定に戻した）。保存して、並べ直すかを聞く */
  onCommit: (template: string) => void;
}): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const insert = (token: string): void => {
    const el = input.current;
    const text = `{${token}}`;
    const from = el?.selectionStart ?? template.length;
    const to = el?.selectionEnd ?? template.length;
    onChange(template.slice(0, from) + text + template.slice(to));
    // 入れたトークンのうしろにカーソルを置く（値が反映されてから）
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(from + text.length, from + text.length);
    });
  };
  const unknown = unknownTokens(template);
  const sampleFile = `${SAMPLE_PRODUCT.productId}.zip`;
  const example = [root.replace(/[\\/]+$/, ''), ...expandTemplate(template, SAMPLE_PRODUCT), sampleFile].join('\\');
  return (
    <div className="field">
      <label htmlFor="folder-template">{t('フォルダ構成')}</label>
      <div className="field__row">
        <input
          id="folder-template"
          ref={input}
          type="text"
          value={template}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => onCommit(template)}
        />
        {template !== DEFAULT_TEMPLATE && (
          <button className="btn btn--xs" onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange(DEFAULT_TEMPLATE); onCommit(DEFAULT_TEMPLATE); }}>
            {t('既定に戻す')}
          </button>
        )}
      </div>
      <p className="field__hint">
        {t('保存先の中に作るフォルダの並びです。「/」で区切ると階層になり、{ } のトークンは作品ごとの値に置き換わります。ファイルはいちばん下のフォルダに、ダウンロード元の名前（作品ID など）のまま保存します。')}
      </p>
      <div className="tokenList" role="group" aria-label={t('使えるトークン')}>
        {FOLDER_TOKENS.map(({ token, label }) => (
          <button
            key={token}
            type="button"
            className="tokenList__item"
            // 押しても入力欄から離れない（離れると途中のまま保存されてしまう）
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insert(token)}
            title={t('押すと入力欄に入れます')}
          >
            <code>{`{${token}}`}</code>
            <span>{t(label)}</span>
            <span className="muted">{tokenValue(token, SAMPLE_PRODUCT)}</span>
          </button>
        ))}
      </div>
      {unknown.length > 0 && (
        <p className="stats__error" role="alert">
          {t('{0} は使えないトークンです（何も入らず、空になります）。', { 0: unknown.map((x) => `{${x}}`).join(' ') })}
        </p>
      )}
      <p className="field__hint">
        {t('例（架空の作品）')}: <code className="tokenList__example">{example}</code>
      </p>
    </div>
  );
}
