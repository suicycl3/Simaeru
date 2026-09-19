import { t } from '@shared/i18n';
import type {
PostProcessSettings,
ToolStatus
} from '@shared/types';
import { PDF_STRIP_TYPES } from '@shared/types';
import ViewerPrefsFields from '.././viewer/ViewerPrefsFields';

export default function ViewerSettings({ post, tools, savePost }: {
  post: PostProcessSettings | null;
  tools: ToolStatus | null;
  savePost: (value: Partial<PostProcessSettings>) => void;
}): JSX.Element {
  return (<section className="settings">
                <p className="muted">{t('マンガ・CG 集など、画像の作品の設定です。')}</p>
                {post && (
                  <>
                    <div className="detail__heading">{t('容量を減らす')}</div>
                    <p className="muted">{t('画像と同じ内容の PDF（スマホ向けなど）が入っていたら、ダウンロード後に消して zip を作り直す')}</p>
                    {PDF_STRIP_TYPES.map((w) => (
                      <label className="check check--sub" key={w}>
                        <input
                          type="checkbox"
                          checked={post.stripPdfTypes.includes(w)}
                          disabled={!tools?.sevenZip}
                          onChange={(e) =>
                            savePost({
                              stripPdfTypes: e.target.checked
                                ? [...new Set([...post.stripPdfTypes, w])]
                                : post.stripPdfTypes.filter((x) => x !== w)
                            })
                          }
                        />
                        {w === 'cg' ? t('同人の CG・イラスト') : t('同人のマンガ・コミック')}
                      </label>
                    ))}
                    <p className="muted detail__note">
                      {t('名前に「スマホ」「PDF版」などがある PDF、名前が画像のフォルダと重なる PDF（「本編.pdf」と「01_本編」など）、いちばん大きい画像フォルダの 1 割以上の大きさがある PDF を消します。「おまけ」「設定資料」など別の内容らしい名前の PDF は触りません。同人の CG・マンガ以外（商業の電子書籍・ボイス作品など）は対象にしません。詳細の「手元のファイル」からも作品ごとに消せます。')}
                    </p>
                  </>
                )}
                <div className="detail__heading">{t('画像ビューア')}</div>
                <ViewerPrefsFields />
              </section>);
}
