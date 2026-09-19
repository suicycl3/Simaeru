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
              </section>);
}
