import { t } from '@shared/i18n';
import { ipcMain,shell } from 'electron';
import { DLSITE_PARTITION } from '../sites/dlsite/client';
import { DMM_PARTITION } from '../sites/dmm/client';
import { videoPartUrl } from '../sites/dmm/video';
import { openExternalWeb,openSiteBrowser } from '../viewer/siteBrowser';
import type { IpcServices } from './services';

export function registerBrowserIpc({ repo }: Pick<IpcServices, "repo">) {
  /** エクスプローラでファイルの場所を開く */
  ipcMain.handle('shell:showInFolder', (_e, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle('shell:openPath', (_e, filePath: string) => shell.openPath(filePath));

  /**
   * 作品の「ブラウザで読む・遊ぶ・再生」をアプリの中の窓で開く。開けるのはその作品の導線だけ。
   * DMM 動画は、ストリーミング（公式の HTML5 プレイヤー）と、ダウンロード画面（作品ページ。公式のボタンから DMM プレイヤーに渡す）をアプリ内で開く。
   * @returns inApp: アプリ内で開いたか
   */
  ipcMain.handle('browser:open', async (_e, productRef: number, url: string, external?: boolean) => {
    const product = repo.getProduct(productRef);
    if (!product) throw new Error(t('作品が見つかりません'));
    const link = product.links.find((l) => l.url === url);
    if (!link && product.detailUrl !== url) throw new Error(t('この作品の導線ではありません'));
    if (link?.kind === 'stream') repo.markViewed(productRef);
    const videoStream = product.floorId === 'video' && link?.kind === 'stream';
    const target = videoStream ? videoPartUrl(url) : url;
    // DMM 動画の公式プレイヤーは、アプリ内の窓では DRM のエラー（V6007）で再生できない（実機で確認）。外部ブラウザで開く
    if (external || videoStream || !link || link.kind === 'download' || link.kind === 'page') {
      await openExternalWeb(target);
      return { inApp: false, reason: null };
    }
    openSiteBrowser(target, { partition: product.siteId === 'dlsite' ? DLSITE_PARTITION : DMM_PARTITION, title: product.title });
    return { inApp: true, reason: null };
  });

}
