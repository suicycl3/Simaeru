import { t } from '@shared/i18n';
import type {
PostProcessSettings
} from '@shared/types';

export default function GameSettings({ post, savePost }: {
  post: PostProcessSettings;
  savePost: (value: Partial<PostProcessSettings>) => void;
}): JSX.Element {
  return (<section className="settings">
                <label className="check">
                  <input type="checkbox" checked={post.autoExtract} onChange={(e) => savePost({ autoExtract: e.target.checked })} />
                  {t('ダウンロードが終わったら自動で展開する')}
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={post.deleteArchiveAfterExtract}
                    onChange={(e) => savePost({ deleteArchiveAfterExtract: e.target.checked })}
                  />
                  {t('展開が済んだら、ダウンロードしたファイル（zip など）を削除する')}
                </label>
                <label className="check">
                  <input type="checkbox" checked={post.sfxToZip} onChange={(e) => savePost({ sfxToZip: e.target.checked })} />
                  {t('解凍するだけの exe（自己解凍形式）は、展開して各種処理をしたあと zip に置き換える')}
                </label>
                <p className="field__hint">
                  {t('exe はごみ箱へ入れます。以後はふつうの zip として、作品の種別ごとの扱い（圧縮のまま・展開）に従います。オフにすると、exe から直接展開します。')}
                </p>
              </section>);
}
