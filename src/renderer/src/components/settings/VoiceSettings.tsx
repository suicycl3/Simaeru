import { t } from '@shared/i18n';
import type {
FlacOriginal,
PostProcessSettings,
ToolStatus
} from '@shared/types';
import { formatBytes } from '../../lib/format';
import AudioPrefsFields from '.././viewer/AudioPrefsFields';
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


export default function VoiceSettings({ post, tools, savePost, setSection }: {
  post: PostProcessSettings;
  tools: ToolStatus | null;
  savePost: (value: Partial<PostProcessSettings>) => void;
  setSection: (value: 'tools') => void;
}): JSX.Element {
  return (<section className="settings">
                <div className="detail__heading">{t('再生の音')}</div>
                <AudioPrefsFields />
                <p className="muted">{t('ボイス・ASMR・音楽作品をダウンロードしたあとの処理です。')}</p>

                <div className="detail__heading">{t('容量を減らす')}</div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={post.autoFlac}
                    disabled={!tools?.ffmpeg}
                    onChange={(e) => savePost({ autoFlac: e.target.checked })}
                  />
                  {t('WAV を FLAC にする（音はまったく同じまま、容量が半分ほどになります）')}
                </label>
                {!tools?.ffmpeg && (
                  <p className="muted detail__note">
                    {t('ffmpeg が必要です。')}
                    <button className="link" onClick={() => setSection('tools')}>
                      {t('ツールの設定を開く')}
                    </button>
                  </p>
                )}
                <label className="check">
                  <input
                    type="checkbox"
                    checked={post.lossyOnly}
                    disabled={!tools?.sevenZip}
                    onChange={(e) => savePost({ lossyOnly: e.target.checked })}
                  />
                  {t('MP3 版も入っている作品は、WAV / FLAC を削除して MP3 版だけ残す')}
                </label>
                <p className="muted detail__note settings__indent">
                  {t('WAV 版と MP3 版の両方が入っている作品で、MP3 版がある曲の WAV / FLAC だけを削除します（SEあり・なしなどの版は区別します）。容量は大きく減りますが、元の音質には戻せません。詳細の「手元のファイル」から作品ごとにも行えます。')}
                </p>

                <div className="settings__row">
                  <span className="settings__label">{t('自動で行う大きさ')}</span>
                  <select
                    className="select select--xs"
                    value={post.flacMinBytes}
                    onChange={(e) => savePost({ flacMinBytes: Number(e.target.value) })}
                  >
                    {[0, 50 * MB, 200 * MB, 500 * MB, 1024 * MB].map((v) => (
                      <option key={v} value={v}>
                        {v === 0 ? t('WAV があればすべて') : t('WAV が合計 {0} 以上', { 0: formatBytes(v) })}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="settings__row">
                  <span className="settings__label">{t('元のファイル')}</span>
                  <select
                    className="select select--xs"
                    value={post.flacOriginal}
                    onChange={(e) => savePost({ flacOriginal: e.target.value as FlacOriginal })}
                  >
                    <option value="trash">{t('ごみ箱へ入れる')}</option>
                    <option value="delete">{t('削除する')}</option>
                    <option value="keep">{t('残す（容量は減りません）')}</option>
                  </select>
                </div>
                <ul className="muted detail__note settings__list">
                  <li>{t('変換したあと、元と同じ音になっているかを確かめてから元のファイルを処理します。')}</li>
                  <li>{t('zip のまま保存している作品は、中身を入れ替えた zip を作り直します。作り直しに失敗したときは元のまま残します。')}</li>
                  <li>{t('32bit 浮動小数点の WAV は FLAC にできないため、そのまま残します。')}</li>
                </ul>
              </section>);
}
