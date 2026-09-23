import { htmlToText } from '@shared/htmlText';
import { t } from '@shared/i18n';
import type {
CompilationOverrideAction,
Creator,
LibraryQuery,
MakerFilter,
ProductLink,
TagFilter
} from '@shared/types';
import { ipcMain } from 'electron';
import { catalogKeyOf,COMPILATION_GUESS_SETTING,compilationCandidates,refreshCompilations,updateCatalog,type CatalogKey } from '../meta/compilations';
import { fetchSerialInfo,fetchSplitLinks } from '../sites/dlsite/purchases';
import { fetchDlsiteStoreMeta } from '../sites/dlsite/store';
import { fetchDoujinDetail,fetchDoujinFiles } from '../sites/dmm';
import { fetchBookPurchased } from '../sites/dmm/book';
import { fetchBookVolumes } from '../sites/dmm/bookVolumes';
import { fetchDlsoftDetail,volumeToBytes } from '../sites/dmm/dlsoft';
import { parseSizeText } from '../sites/dmm/doujin';
import {
fetchBookStoreMeta,
fetchDlsoftStoreMeta,
fetchDoujinStoreMeta
} from '../sites/dmm/storeMeta';
import { fetchVideoContentDetail,fetchVideoPlayInfo,videoContentUrl,videoPartUrl,type VideoPlayInfo } from '../sites/dmm/video';
import { openExternalWeb } from '../viewer/siteBrowser';
import type { IpcServices } from './services';
/** 同じ役割・同じ名前のクリエイターを重複させずにまとめる */
function mergeCreators(...groups: Creator[][]): Creator[] {
  const seen = new Map<string, Creator>();
  for (const group of groups) {
    for (const c of group) {
      const key = `${c.role}:${c.name}`;
      if (!seen.has(key) || (!seen.get(key)!.id && c.id)) seen.set(key, c);
    }
  }
  return [...seen.values()];
}

/** 動画: プレイヤーURLと画質別ダウンロードURL */
function videoLinks(play: VideoPlayInfo | null): ProductLink[] {
  if (!play) return [];
  const links: ProductLink[] = [];
  const parts = play.streams.filter((st) => st.codec === null);
  for (const st of play.streams) {
    // 複数パートの作品は、パートごとにプレイヤーの URL がある。4K 作品には H.264 版のプレイヤーが別にある
    const label = st.codec === 'h264' ? '再生（H.264）' : parts.length > 1 ? `再生（パート ${st.part}）` : 'ストリーミング再生';
    links.push({ label, url: videoPartUrl(st.url), kind: 'stream', ...(st.codec ? { codec: st.codec } : {}) });
  }
  const partCount = new Map<string, number>();
  for (const d of play.downloads) partCount.set(d.quality, (partCount.get(d.quality) ?? 0) + 1);
  for (const d of play.downloads) {
    links.push({
      label: d.name ? `ダウンロード ${d.name}` : `ダウンロード ${d.quality}k`,
      url: d.url,
      kind: 'download',
      // 容量は全パートの合計なので、1 パート目にだけ持たせる
      quality: { key: d.quality, name: d.name, sizeMb: d.part === 1 || (partCount.get(d.quality) ?? 1) === 1 ? d.sizeMb : null, order: d.order, part: d.part }
    });
  }
  return links;
}

/** 電子書籍: ビューア・ダウンロード・付録ファイルのリンクを組み立てる */
function bookLinks(purchased: {
  streamingUrl: string | null;
  downloadUrl: string | null;
  appendix: { streaming: unknown[]; download: unknown[] } | null;
} | null): ProductLink[] {
  if (!purchased) return [];
  const links: ProductLink[] = [];
  if (purchased.streamingUrl) {
    links.push({ label: 'ビューアで読む', url: purchased.streamingUrl, kind: 'stream' });
  }
  if (purchased.downloadUrl) {
    links.push({ label: 'ダウンロード', url: purchased.downloadUrl, kind: 'download' });
  }
  for (const item of purchased.appendix?.download ?? []) {
    const a = item as { url?: string; file_format?: string; file_size?: string };
    if (a?.url) {
      links.push({
        label: `付録${a.file_format ? `（${a.file_format}）` : ''}`,
        url: a.url,
        kind: 'download'
      });
    }
  }
  return links;
}

/** PCゲーム: 本体/分割ファイルとブラウザ起動のリンク */
function dlsoftLinks(detail: {
  download: {
    singleFileUrl: string | null;
    combinedFileUrl: string | null;
    splitFileUrlArray: string[];
  } | null;
  browser: { canPlay: boolean; playPageUrl: string | null } | null;
} | null): ProductLink[] {
  if (!detail) return [];
  const links: ProductLink[] = [];
  const abs = (u: string): string => (u.startsWith('http') ? u : `https://dlsoft.dmm.co.jp${u}`);
  const dl = detail.download;
  if (dl?.singleFileUrl) {
    links.push({ label: '本体ファイル', url: abs(dl.singleFileUrl), kind: 'download' });
  }
  const parts = [dl?.combinedFileUrl, ...(dl?.splitFileUrlArray ?? [])].filter(
    (u): u is string => !!u
  );
  parts.forEach((u, i) => {
    links.push({ label: i === 0 ? 'part1 (exe)' : `part${i + 1}`, url: abs(u), kind: 'download' });
  });
  if (detail.browser?.canPlay && detail.browser.playPageUrl) {
    links.push({ label: 'ブラウザで遊ぶ', url: detail.browser.playPageUrl, kind: 'play' });
  }
  return links;
}

/** "2026-02-24T18:47:54+09:00" → "2026-02-24 18:47"。他フロアと表記を揃える */
function toLocalStamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (m) return `${m[1]} ${m[2]}`;
  return iso.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? iso;
}

/** "2024年07月27日" → "2024-07-27"。既にISO形式ならそのまま返す */
function jpDateToIso(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text : null;
}


export function registerLibraryIpc({ repo, send }: Pick<IpcServices, "repo" | "send">) {
  ipcMain.handle('library:query', (_e, q: LibraryQuery) => repo.queryLibrary(q ?? {}));
  /** 表示中（絞り込みに合う）作品すべての ID。まとめてダウンロード・削除に使う */
  ipcMain.handle('library:queryIds', (_e, q: LibraryQuery) => repo.queryLibraryIds(q ?? {}));

  ipcMain.handle('library:makers', (_e, filter?: MakerFilter) => repo.makers(filter ?? {}));

  ipcMain.handle('library:tags', (_e, filter?: TagFilter) => repo.tags(filter ?? {}));

  ipcMain.handle('library:workTypes', (_e, filter?: TagFilter) => repo.workTypeCounts(filter ?? {}));

  /** サイドバーの絞り込み用。区分別・サイト別の件数 */
  ipcMain.handle('library:facets', () => ({
    categories: repo.categoryCounts(),
    sites: repo.siteCounts(),
    favorites: repo.favoriteCount(),
    used: repo.usedCount(),
    local: repo.localCounts()
  }));

  ipcMain.handle('library:product', (_e, id: number) => repo.getProduct(id));

  /** 閲覧したら自動で「使った」にするか（既定はオン） */
  ipcMain.handle('library:autoUsed', () => repo.autoUsed());
  ipcMain.handle('library:setAutoUsed', (_e, on: boolean) => {
    repo.setAutoUsed(on);
    return repo.autoUsed();
  });

  // ── 総集編・セットの収録作品 ─────────────────────────────
  let compilationsRunning: Promise<number> | null = null;
  let compilationsAgain = false;
  let compilationsTimer: NodeJS.Timeout | null = null;
  let catalogsFetching = false;
  /** 足りないサークルの作品一覧を、1 つずつ取りに行く（未購入の作品を含む公開の一覧。ログインは要らない） */
  const fetchCatalogs = async (keys: CatalogKey[]): Promise<void> => {
    if (catalogsFetching || keys.length === 0) return;
    catalogsFetching = true;
    let fetched = 0;
    try {
      for (const key of keys.slice(0, 40)) {
        try {
          await updateCatalog(repo, key);
          fetched++;
        } catch (err) {
          console.warn(`[compilation] 作品一覧を取れませんでした: ${key.store} ${key.makerId}`, err);
        }
      }
    } finally {
      catalogsFetching = false;
    }
    if (fetched > 0) void runCompilations();
  };
  /** 収録作品を組み立て直す。走っている最中に頼まれたら、終わってからもう一度 */
  const runCompilations = (): Promise<number> => {
    if (compilationsRunning) {
      compilationsAgain = true;
      return compilationsRunning;
    }
    compilationsRunning = refreshCompilations(repo)
      .then(({ count, needed }) => {
        send('library:compilationsChanged', { count });
        void fetchCatalogs(needed);
        return count;
      })
      .catch((err: unknown) => {
        console.warn('[compilation] 収録作品を読み取れませんでした:', err);
        return 0;
      })
      .finally(() => {
        compilationsRunning = null;
        if (compilationsAgain) {
          compilationsAgain = false;
          void runCompilations();
        }
      });
    return compilationsRunning;
  };
  /**
   * 詳細の取得が続くとき（裏取得）に毎回読み直さないよう、少しまとめる。
   * 待ち時間そのものはプロセスを引き止めない（アプリは別の理由で動き続ける。テストは待たずに終われる）
   */
  const scheduleCompilations = (delayMs = 5_000): void => {
    if (compilationsTimer) clearTimeout(compilationsTimer);
    compilationsTimer = setTimeout(() => {
      compilationsTimer = null;
      void runCompilations();
    }, delayMs);
    compilationsTimer.unref?.();
  };
  scheduleCompilations(30_000);
  ipcMain.handle('library:compilation', (_e, id: number) => repo.compilationOf(id));
  /** 同人・CG などの総集編の収録作品を推定するか（実験的。既定はオフ） */
  ipcMain.handle('library:compilationGuess', () => repo.getSetting(COMPILATION_GUESS_SETTING) === '1');
  ipcMain.handle('library:setCompilationGuess', async (_e, on: boolean) => {
    repo.setSetting(COMPILATION_GUESS_SETTING, on ? '1' : '0');
    await runCompilations();
    send('library:changed', { productRef: null });
    return on;
  });
  ipcMain.handle('library:compilationCandidates', (_e, compilationRef: number, entryTitle: string) =>
    compilationCandidates(repo, compilationRef, entryTitle)
  );
  ipcMain.handle(
    'library:setCompilationOverride',
    (_e, compilationRef: number, entryTitle: string, action: CompilationOverrideAction, productId?: string) => {
      if (action === 'clear') repo.setCompilationOverride(compilationRef, entryTitle, null);
      else if (action === 'none') repo.setCompilationOverride(compilationRef, entryTitle, []);
      else if (action === 'set') {
        // 選べるのは候補に出したものだけ
        const pick = compilationCandidates(repo, compilationRef, entryTitle, 1000).find((c) => c.productId === productId);
        if (!pick) throw new Error(t('その作品は候補にありません'));
        repo.setCompilationOverride(compilationRef, entryTitle, [{ productId: pick.productId, title: pick.title, url: pick.url, score: null }]);
      } else throw new Error(`unknown action: ${String(action)}`);
      send('library:compilationsChanged', { count: null });
      return repo.compilationOf(compilationRef);
    }
  );
  /** 総集編のサークルの作品一覧を、いま取り直す */
  ipcMain.handle('library:refreshCatalog', async (_e, compilationRef: number) => {
    const key = catalogKeyOf(repo, compilationRef);
    if (!key) return repo.compilationOf(compilationRef);
    await updateCatalog(repo, key);
    await runCompilations();
    return repo.compilationOf(compilationRef);
  });
  /** 収録作品のストアのページを開く（同じサイトの作品ページだけ） */
  ipcMain.handle('library:openCompilationItem', async (_e, compilationRef: number, url: string) => {
    const info = repo.compilationOf(compilationRef);
    const known = info.entries.some((e) => e.matches.some((m) => m.url === url));
    if (!known) throw new Error(t('この作品の導線ではありません'));
    await openExternalWeb(url);
  });

  ipcMain.handle('library:markViewed', (_e, id: number) => {
    repo.markViewed(id);
  });

  ipcMain.handle('library:setFavorite', (_e, id: number, favorite: boolean) => {
    repo.setFavorite(id, favorite);
    return repo.getProduct(id);
  });

  /** ♡「使った」。お気に入り（★）とは別で、最後に使った日を自分で付けたり外したりする */
  ipcMain.handle('library:setUsed', (_e, id: number, used: boolean) => {
    repo.setUsed(id, used);
    return repo.getProduct(id);
  });

  /**
   * 詳細（ファイルサイズ・DRM・ダウンロードリンク）は同期時に取ると件数分の
   * リクエストになるため、開いたときにだけ取りに行き、取れた値はDBへ書き戻す。
   *
   * 裏でゆっくり集める常駐処理（metaCrawler）からも同じ関数を呼ぶ。
   * UIから開いたときと同じ経路にしておかないと、書き戻す内容がずれる。
   */
  const fetchDetail = async (id: number, opts?: { force?: boolean }): Promise<unknown> => {
    const product = repo.getProduct(id);
    if (!product) throw new Error(t('作品が見つかりません'));

    // 動画の再生・ダウンロードの導線は、ログイン切れなどで取れないまま「取得済み」になっていることがある。
    // 導線が無ければ、詳細を開いたときに導線だけ取り直す（作品ページの情報は取り直さない）
    if (product.metaFetchedAt && !opts?.force && product.siteId === 'dmm' && product.floorId === 'video' &&
        (!product.links.some((l) => l.kind === 'stream' || l.kind === 'download') ||
          product.links.some((l) => l.kind === 'download' && !l.quality))) {
      const contentId = product.contentId ?? product.productId;
      let playError: string | null = null;
      const play = await fetchVideoPlayInfo(contentId, product.genre).catch((err: unknown) => {
        playError = err instanceof Error ? err.message : String(err);
        return null;
      });
      if (play && (play.streams.length > 0 || play.downloads.length > 0)) {
        repo.setLinks(id, videoLinks(play), { isDownloadable: play.downloads.length > 0, isStreaming: play.streams.length > 0 });
        return { supported: true, kind: 'cached' as const, floorId: product.floorId, product: repo.getProduct(id) };
      }
      // 画質の情報を足したいだけのとき（導線はある）は、取れなくても今の導線のまま出す
      if (product.links.some((l) => l.kind === 'stream' || l.kind === 'download')) {
        return { supported: true, kind: 'cached' as const, floorId: product.floorId, product };
      }
      return {
        supported: true,
        kind: 'cached' as const,
        floorId: product.floorId,
        product,
        detailError: playError ?? t('再生・ダウンロードの導線がありませんでした')
      };
    }

    // 作品ページの内容は基本的に変わらないので、一度取り切っていれば通信しない。
    // 取り直したいときだけ UI から force を付けて呼ぶ。
    if (product.metaFetchedAt && !opts?.force) {
      return { supported: true, kind: 'cached' as const, floorId: product.floorId, product };
    }

    if (product.siteId === 'dmm' && product.floorId === 'dlsoft') {
      // 片方が落ちてももう片方は出す（セット収録品や販売終了作品では実際に片落ちする）
      let detail: Awaited<ReturnType<typeof fetchDlsoftDetail>> | null = null;
      let detailError: string | null = null;
      try {
        detail = await fetchDlsoftDetail(
          product.productId,
          product.productType,
          product.parentProductId
        );
      } catch (err) {
        detailError = err instanceof Error ? err.message : String(err);
      }
      const dl = detail?.download ?? null;
      // 説明文・ジャンル・スタッフはライブラリ系APIに無く、店舗ページにしかない
      const store = await fetchDlsoftStoreMeta(product.contentId ?? product.productId);
      repo.upsertProduct({
        siteId: 'dmm',
        floorId: 'dlsoft',
        productId: product.productId,
        contentId: product.contentId,
        title: product.title,
        maker: product.maker,
        makerId: product.makerId,
        authors: product.authors,
        genre: product.genre,
        productType: product.productType,
        // 一覧の日付は配信開始日。ここで実際の注文日に差し替える。
        purchasedAt: detail?.orderDate ?? product.purchasedAt,
        purchasedAtSource: detail?.orderDate ? 'order' : product.purchasedAtSource,
        coverUrl: product.coverUrl,
        detailUrl: product.detailUrl,
        fileSizeText: dl?.volume ? `${dl.volume} MB` : product.fileSizeText,
        fileSizeBytes: volumeToBytes(dl?.volume) ?? product.fileSizeBytes,
        isDownloadable: dl?.canDownload ?? product.isDownloadable,
        isStreaming: !!detail?.browser?.canPlay || product.isStreaming,
        isUnavailable: product.isUnavailable,
        description: store.description,
        links: dlsoftLinks(detail),
        creators: mergeCreators(product.creators, store.creators),
        tags: [...new Set([...product.tags, ...store.tags])]
      });
      repo.markMetaFetched(id);
      scheduleCompilations();
      return {
        supported: true,
        kind: 'dlsoft',
        detail,
        detailError,
        store,
        product: repo.getProduct(id)
      };
    }

    if (product.siteId === 'dmm' && product.floorId === 'book') {
      // 本棚APIは購入日も説明文も返さない。購入日は巻ごとの購入状態APIから、
      // 説明文・ジャンル・出版社などは店舗ページから取る。
      const store = product.detailUrl ? await fetchBookStoreMeta(product.detailUrl) : null;
      // ホストが違っていた場合は解決できた方を正とする（サイトで開く導線も直る）
      const detailUrl = store?.resolvedUrl ?? product.detailUrl;
      let purchased: Awaited<ReturnType<typeof fetchBookPurchased>> = null;
      let detailError: string | null = null;
      try {
        if (detailUrl) purchased = await fetchBookPurchased(detailUrl);
      } catch (err) {
        detailError = err instanceof Error ? err.message : String(err);
      }
      // 本棚はシリーズ単位なので、シリーズ内のどの巻を持っているかはここで列挙する。
      // 失敗しても他のメタは出したいので握って続ける。
      let volumes: Awaited<ReturnType<typeof fetchBookVolumes>> = null;
      try {
        if (detailUrl) volumes = await fetchBookVolumes(detailUrl);
      } catch (err) {
        detailError = detailError ?? (err instanceof Error ? err.message : String(err));
      }
      repo.upsertProduct({
        siteId: 'dmm',
        floorId: 'book',
        productId: product.productId,
        contentId: product.contentId,
        title: product.title,
        maker: product.maker,
        authors: product.authors,
        genre: product.genre,
        productType: product.productType,
        purchasedAt: toLocalStamp(purchased?.purchasedDate) ?? product.purchasedAt,
        purchasedAtSource: purchased?.purchasedDate ? 'order' : product.purchasedAtSource,
        releasedAt: store?.releasedAt ?? product.releasedAt,
        description: store?.description ?? null,
        creators: mergeCreators(product.creators, store?.creators ?? []),
        coverUrl: product.coverUrl,
        detailUrl,
        fileSizeText: store?.fileSizeText ?? product.fileSizeText,
        links: bookLinks(purchased),
        volumes,
        isDownloadable: !!purchased?.downloadUrl || (volumes?.owned ?? []).some((v) => v.downloadUrl),
        isStreaming: !!purchased?.streamingUrl || product.isStreaming,
        isUnavailable: product.isUnavailable,
        hasDrm: true,
        tags: [...new Set([...product.tags, ...(store?.tags ?? [])])]
      });
      repo.markMetaFetched(id);
      scheduleCompilations();
      return {
        supported: true,
        kind: 'book',
        detail: purchased,
        detailError,
        store,
        volumes,
        product: repo.getProduct(id)
      };
    }

    if (product.siteId === 'dmm' && product.floorId === 'video') {
      const contentId = product.contentId ?? product.productId;
      const detail = await fetchVideoContentDetail(contentId, product.genre);
      // 再生・ダウンロードの導線は旧www側のAPIにしかない。落ちてもメタは出すが、理由は返す（ダウンロードの失敗の理由になる）
      let play: Awaited<ReturnType<typeof fetchVideoPlayInfo>> = null;
      let playError: string | null = null;
      try {
        play = await fetchVideoPlayInfo(contentId, product.genre);
      } catch (err) {
        playError = err instanceof Error ? err.message : String(err);
      }
      repo.upsertProduct({
        siteId: 'dmm',
        floorId: 'video',
        productId: product.productId,
        contentId: product.contentId,
        title: product.title,
        maker: detail.creators.find((c) => c.role === 'メーカー')?.name ?? product.maker,
        genre: product.genre,
        productType: product.productType,
        purchasedAt: product.purchasedAt,
        purchasedAtSource: product.purchasedAtSource,
        releasedAt: detail.releasedAt ?? product.releasedAt,
        description: htmlToText(detail.description) || null,
        // 導線が取れなかったときは、前に取れていた導線を空で上書きしない
        links: play && (play.streams.length > 0 || play.downloads.length > 0) ? videoLinks(play) : product.links,
        // 以前は floor を大文字のまま URL に入れていた（開いても作品ページにならない）。取り直すたびに正しい形に直す
        detailUrl: videoContentUrl(product.genre, contentId),
        creators: detail.creators.length ? detail.creators : product.creators,
        coverUrl: product.coverUrl,
        isDownloadable: (play?.downloads.length ?? 0) > 0 || product.isDownloadable,
        isStreaming: (play?.streams.length ?? 0) > 0 || product.isStreaming,
        isUnavailable: product.isUnavailable,
        hasDrm: product.hasDrm,
        // 一覧由来の品質タグ等は残したうえでジャンル/タグを足す
        tags: [...new Set([...product.tags, ...detail.tags])]
      });
      repo.markMetaFetched(id);
      scheduleCompilations();
      return { supported: true, kind: 'video', detail, play, detailError: playError, product: repo.getProduct(id) };
    }

    if (product.siteId === 'dlsite') {
      // play のライブラリAPIには説明文もスタッフも無いので、作品ページから取る。
      // 販売終了などでページが消えている作品は null が返るだけで、他は今の値のまま出す。
      let store: Awaited<ReturnType<typeof fetchDlsiteStoreMeta>> = null;
      let detailError: string | null = null;
      try {
        if (product.detailUrl) store = await fetchDlsiteStoreMeta(product.detailUrl);
      } catch (err) {
        detailError = err instanceof Error ? err.message : String(err);
      }

      // ライセンスキーと実ファイルのURLは同期時に取ってあるので、通常ここは通らない。
      // 同期後にキーの取得だけ失敗した作品（キー確認ページへのリンクだけが残る）を、
      // 開いたときに取り直すための経路。
      const serialLink = product.links.find((l) => l.url.includes('/home/serial/'));
      let serial: Awaited<ReturnType<typeof fetchSerialInfo>> | null = null;
      if (serialLink) {
        try {
          serial = await fetchSerialInfo(product.productId);
        } catch (err) {
          detailError = detailError ?? (err instanceof Error ? err.message : String(err));
        }
      }

      let links: ProductLink[] = [...product.links];
      // 分割案内はファイルではない。ページ内の全パートを取得し、案内も再取得用に残す。
      if (links.some((l) => l.url.includes('/home/download/split/'))) {
        try {
          const parts = await fetchSplitLinks(product.productId);
          if (parts.length > 0) {
            links = links.filter((l) => !(l.kind === 'download' && l.url.includes('/home/download/=/number/')));
            links.push(...parts);
          }
        } catch (err) {
          detailError = detailError ?? (err instanceof Error ? err.message : String(err));
        }
      }
      // 実ファイルのURLはキー確認ページにしか出てこない。取れたらボタンを足す。
      if (serial?.downloadUrl && !links.some((l) => l.url === serial.downloadUrl)) {
        links.push({ label: 'ダウンロード', url: serial.downloadUrl, kind: 'download' });
      }
      // キーも実URLも手元に来たなら、サイトへ飛ばすボタンはもう要らない
      const resolved =
        serialLink && serial?.licenseKey && serial.downloadUrl
          ? links.filter((l) => l.url !== serialLink.url)
          : links;
      repo.upsertProduct({
        siteId: product.siteId,
        floorId: product.floorId,
        category: product.category,
        productId: product.productId,
        contentId: product.contentId,
        title: product.title,
        maker: product.maker,
        makerId: product.makerId,
        authors: product.authors,
        creators: mergeCreators(product.creators, store?.creators ?? []),
        genre: product.genre,
        productType: product.productType,
        purchasedAt: product.purchasedAt,
        purchasedAtSource: product.purchasedAtSource,
        releasedAt: store?.releasedAt ?? product.releasedAt,
        description: store?.description ?? product.description,
        coverUrl: product.coverUrl,
        detailUrl: product.detailUrl,
        fileSizeText: store?.fileSizeText ?? product.fileSizeText,
        fileSizeBytes: product.fileSizeBytes,
        isDownloadable: product.isDownloadable || resolved.some((l) => l.kind === 'download'),
        isStreaming: product.isStreaming,
        // 作品ページが消えている＝販売終了。ダウンロード自体はできるので導線は残す。
        isUnavailable: product.isUnavailable,
        hasDrm: product.hasDrm,
        tags: [...new Set([...product.tags, ...(store?.tags ?? [])])],
        links: resolved,
        serialKey: serial?.licenseKey ?? product.serialKey
      });
      repo.markMetaFetched(id);
      scheduleCompilations();
      return {
        supported: true,
        kind: 'dlsite',
        serial,
        store,
        detailError,
        product: repo.getProduct(id)
      };
    }

    if (product.siteId !== 'dmm' || product.floorId !== 'doujin') {
      return { supported: false, product };
    }
    const contentId = product.contentId ?? product.productId;
    const detail = await fetchDoujinDetail(contentId);
    const store = await fetchDoujinStoreMeta(contentId);
    const circle: Creator[] = detail.makerName
      ? [
          {
            role: 'サークル',
            name: detail.makerName,
            id: detail.makerId != null ? String(detail.makerId) : null
          }
        ]
      : [];
    repo.upsertProduct({
      siteId: 'dmm',
      floorId: 'doujin',
      productId: product.productId,
      contentId,
      title: detail.title || product.title,
      maker: detail.makerName ?? product.maker,
      makerId: detail.makerId !== null && detail.makerId !== undefined ? String(detail.makerId) : product.makerId,
      genre: product.genre,
      purchasedAt: product.purchasedAt,
      // 同人の deliveryDate は "2024年07月27日" 形式の配信日＝発売日
      releasedAt: jpDateToIso(detail.deliveryDate) ?? product.releasedAt,
      coverUrl: product.coverUrl,
      detailUrl: detail.detailLink ?? product.detailUrl,
      fileSizeText: detail.fileSize ?? null,
      fileSizeBytes: parseSizeText(detail.fileSize),
      isDownloadable: Object.keys(detail.downloadLinks ?? {}).length > 0,
      isStreaming: product.isStreaming,
      isUnavailable: !detail.isViewable,
      hasDrm: !!(detail.drm?.dmmBooks || detail.drm?.softDenchi),
      description: store.description,
      links: [
        ...(detail.cloudGame?.isOpen && detail.cloudGame.url
          ? [{ label: 'クラウドで遊ぶ', url: detail.cloudGame.url, kind: 'play' as const }]
          : []),
        ...Object.values(detail.downloadLinks ?? {}).map((path, i) => ({
          label: i === 0 ? 'ダウンロードページ' : `ダウンロードページ ${i + 1}`,
          url: path.startsWith('http') ? path : `https://www.dmm.co.jp${path}`,
          kind: 'page' as const
        }))
      ],
      creators: mergeCreators(product.creators, circle, store.creators),
      tags: [...new Set([...product.tags, ...store.tags])]
    });
    repo.markMetaFetched(id);
    scheduleCompilations();
    return { supported: true, kind: 'doujin', detail, store, product: repo.getProduct(id) };
  };

  ipcMain.handle('library:detail', (_e, id: number, opts?: { force?: boolean }) =>
    fetchDetail(id, opts)
  );

  ipcMain.handle('library:files', async (_e, id: number) => {
    const product = repo.getProduct(id);
    if (!product || product.floorId !== 'doujin') return null;
    return fetchDoujinFiles(product.contentId ?? product.productId);
  });

  return { fetchDetail, scheduleCompilations, runCompilations };
}
