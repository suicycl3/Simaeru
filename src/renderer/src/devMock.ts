/**
 * ブラウザ単体でUIを確認するための開発用モック。
 * Electron 上では window.api が preload から入っているので何もしない。
 * production ビルドには入らない（main.tsx で import.meta.env.DEV ガードしている）。
 */
import type {
  Category,
  CredentialSummary,
  LibraryPage,
  LibraryQuery,
  MakerFilter,
  Playlist,
  Product,
  TagFilter
} from '@shared/types';

const FLOORS: Array<{
  key: string;
  siteId: string;
  floorId: string;
  label: string;
  category: Category;
  count: number;
}> = [
  { key: 'dmm:dlsoft', siteId: 'dmm', floorId: 'dlsoft', label: 'PCゲーム', category: 'game', count: 224 },
  { key: 'dmm:doujin', siteId: 'dmm', floorId: 'doujin', label: '同人', category: 'doujin', count: 2481 },
  { key: 'dmm:book', siteId: 'dmm', floorId: 'book', label: '電子書籍', category: 'book', count: 4 },
  { key: 'dmm:video', siteId: 'dmm', floorId: 'video', label: '動画', category: 'video', count: 12 },
  { key: 'dlsite:library', siteId: 'dlsite', floorId: 'library', label: 'DLsite', category: 'doujin', count: 388 }
];

function makeProducts(): Product[] {
  const out: Product[] = [];
  let id = 1;
  for (const floor of FLOORS) {
    for (let i = 0; i < floor.count; i++) {
      const day = String((i % 28) + 1).padStart(2, '0');
      out.push({
        id: id++,
        siteId: floor.siteId as Product['siteId'],
        floorId: floor.floorId,
        category: floor.category,
        productId: `${floor.floorId}_${i}`,
        contentId: `${floor.floorId}_${i}`,
        title: `${floor.label}のサンプル作品 ${i + 1} — 長いタイトルの折り返しを確認するための文字列`,
        maker: `サークル${i % 40}`,
        makerId: null,
        authors: [`作者${i % 17}`],
        genre: 'CG',
        favoriteAt: i % 17 === 0 ? Date.now() : null,
        viewedAt: null,
        hasLocalFile: i % 11 === 0,
        needsInstall: false,
        isCompilation: false,
        linkCandidate: null,
        workType: (floor.category === 'doujin' ? (i % 3 === 0 ? 'cg' : i % 3 === 1 ? 'manga' : 'voice') : floor.category === 'book' ? 'manga' : floor.category === 'video' ? 'video' : 'game') as Product['workType'],
        productType: floor.floorId === 'dlsoft' && i === 0 ? 'set' : null,
        purchasedAt: `2026-${String((i % 12) + 1).padStart(2, '0')}-${day}`,
        purchasedAtSource: floor.floorId === 'dlsoft' ? ('delivery' as const) : ('order' as const),
        releasedAt: `20${10 + (i % 15)}-0${(i % 9) + 1}-15`,
        description: i % 3 === 0 ? 'サンプルの作品説明文です。'.repeat(6) : null,
        // DLsiteのシリアル配布作品の見え方を確認するためのダミー
        serialKey: floor.siteId === 'dlsite' && i % 10 === 0 ? '8NAN-ZB3B-RJ7U-ZMDW' : null,
        volumes:
          floor.floorId === 'book'
            ? {
                totalCount: 16,
                owned: Array.from({ length: 3 }, (_, n) => ({
                  contentId: `${floor.floorId}_${i}_v${n}`,
                  volumeNumber: n + 1,
                  title: `サンプル作品 第${n + 1}話`,
                  publishedAt: '2024-05-17',
                  coverUrl: null,
                  streamingUrl: 'https://example.invalid/read',
                  downloadUrl: n === 0 ? 'https://example.invalid/dl' : null
                }))
              }
            : null,
        priceText: floor.siteId === 'dlsite' ? `${((i % 9) + 1) * 550}円` : null,
        creators: [
          { role: 'ブランド', name: `サークル${i % 40}`, id: String(i) },
          { role: '作者', name: `作者${i % 17}`, id: null }
        ],
        parentProductId: floor.floorId === 'dlsoft' && i % 11 === 3 ? 'dlsoft_0' : null,
        metaFetchedAt: i % 2 === 0 ? Date.now() : null,
        links:
          i % 2 === 0
            ? [
                { label: 'ダウンロード', url: 'https://example.invalid/dl', kind: 'download' as const },
                { label: 'ビューアで読む', url: 'https://example.invalid/read', kind: 'stream' as const }
              ]
            : [],
        coverUrl: null,
        coverPath: null,
        detailUrl: null,
        fileSizeText: null,
        fileSizeBytes: null,
        isDownloadable: true,
        isStreaming: false,
        isUnavailable: i % 37 === 0,
        hasDrm: false,
        tags: [],
        firstSeenAt: Date.now(),
        lastSyncedAt: Date.now(),
        installation: null
      });
    }
  }
  return out;
}

export function installDevMock(): void {
  if (typeof window === 'undefined' || window.api) return;
  const all = makeProducts();
  const noop = (): (() => void) => () => undefined;

  const query = (q: LibraryQuery): LibraryPage => {
    let rows = all;
    if (q.floors?.length) {
      rows = rows.filter((p) => q.floors!.includes(`${p.siteId}:${p.floorId}`));
    }
    let regexError: string | null = null;
    if (q.search && q.useRegex) {
      // 本物と同じく、タイトル/ブランド/作者/タグを対象に正規表現で絞る
      try {
        const re = new RegExp(q.search, 'i');
        rows = rows.filter(
          (p) =>
            re.test(p.title) ||
            re.test(p.maker ?? '') ||
            p.authors.some((a) => re.test(a)) ||
            p.tags.some((t) => re.test(t))
        );
      } catch (err) {
        regexError = err instanceof Error ? err.message : String(err);
        rows = [];
      }
    } else if (q.search) {
      const s = q.search.toLowerCase();
      rows = rows.filter(
        (p) => p.title.toLowerCase().includes(s) || (p.maker ?? '').toLowerCase().includes(s)
      );
    }
    if (q.categories?.length) rows = rows.filter((p) => q.categories!.includes(p.category));
    if (q.siteIds?.length) rows = rows.filter((p) => q.siteIds!.includes(p.siteId));
    // 本物と同じく、ブランドは複数指定でOR
    if (q.makers?.length) rows = rows.filter((p) => q.makers!.includes(p.maker ?? ''));
    if (q.favoriteOnly) rows = rows.filter((p) => p.favoriteAt);
    if (q.usedOnly) rows = rows.filter((p) => p.viewedAt);
    if (q.localState === 'have') rows = rows.filter((p) => p.hasLocalFile);
    if (q.localState === 'none') rows = rows.filter((p) => !p.hasLocalFile);
    if (q.workTypes?.length) rows = rows.filter((p) => q.workTypes!.includes(p.workType!));
    // 人・シリーズは AND（全員が関わっている作品）
    if (q.creators?.length) {
      rows = rows.filter((p) => q.creators!.every((n) => p.creators.some((c) => c.name === n)));
    }
    // 本物と同じく、指定タグをすべて持つ作品だけに絞る
    if (q.tags?.length) rows = rows.filter((p) => q.tags!.every((t) => p.tags.includes(t)));

    // 本体（SQL側）と同じ規則で並べる。値が無い行は向きによらず最後。
    const field: Record<string, (p: Product) => string | null> = {
      purchased: (p) => p.purchasedAt,
      released: (p) => p.releasedAt,
      title: (p) => p.title,
      maker: (p) => p.maker
    };
    const pick = field[q.sortKey ?? 'purchased'] ?? field.purchased;
    const sign = q.sortDir === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const x = pick(a);
      const y = pick(b);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return sign * x.localeCompare(y, 'ja');
    });

    const offset = q.offset ?? 0;
    return { items: rows.slice(offset, offset + (q.limit ?? 120)), total: rows.length, regexError };
  };

  // 本物と同じく、区分・購入サイトの絞り込みの中だけで数える
  const makers = (filter?: MakerFilter): Array<{ maker: string; count: number }> => {
    const rows = all.filter(
      (p) =>
        (!filter?.categories?.length || filter.categories.includes(p.category)) &&
        (!filter?.siteIds?.length || filter.siteIds.includes(p.siteId)) &&
        // 選択中のタグに連動（本物と同じ）
        (filter?.tags ?? []).every((t) => p.tags.includes(t))
    );
    return Array.from(new Set(rows.map((p) => p.maker!))).map((maker) => ({
      maker,
      count: rows.filter((p) => p.maker === maker).length
    }));
  };

  const mockMeta = {
    enabled: true,
    intervalMs: 1000,
    concurrency: 2,
    pending: 1234,
    blocked: 0,
    lastTitle: 'サンプル作品',
    running: true,
    pausedReason: null as string | null,
    etaSeconds: 617
  };
  const mockCredentials = new Map<string, CredentialSummary>();

  // 閲覧で自動的に「使った」にするか（本物と同じく既定はオン）
  let mockAutoUsed = true;

  // プレイリストの見本（中身は画面の操作で増える）
  const mockPlaylists: Array<{ id: number; name: string; items: number[]; createdAt: number; updatedAt: number }> = [];
  const toPlaylist = (p: { id: number; name: string; items: number[]; createdAt: number; updatedAt: number }): Playlist => ({
    id: p.id, name: p.name, count: p.items.length, createdAt: p.createdAt, updatedAt: p.updatedAt
  });

  window.api = {
    appInfo: async () => ({
      appName: 'Simaeru (mock)',
      sites: [
        { siteId: 'dmm', label: 'DMM / FANZA' },
        { siteId: 'dlsite', label: 'DLsite' }
      ]
    }),
    auth: {
      status: async () => [
        {
          siteId: 'dmm',
          loggedIn: true,
          services: { video: true },
          message: null,
          uncertain: false,
          checkedAt: Date.now()
        },
        { siteId: 'dlsite', loggedIn: true, message: null, uncertain: false, checkedAt: Date.now() }
      ],
      login: async () => true,
      logout: async () => true
    },
    library: {
      facets: async () => ({
        categories: [...new Set(FLOORS.map((f) => f.category))].map((category) => ({
          category,
          count: all.filter((p) => p.category === category).length
        })),
        sites: [...new Set(FLOORS.map((f) => f.siteId))].map((siteId) => ({
          siteId,
          count: all.filter((p) => p.siteId === siteId).length
        })),
        favorites: all.filter((p) => p.favoriteAt).length,
        used: all.filter((p) => p.viewedAt).length,
        local: {
          have: all.filter((p) => p.hasLocalFile).length,
          none: all.filter((p) => !p.hasLocalFile).length,
          notInstalled: 0,
          linkable: 0,
          broken: 0,
          installed: 0
        }
      }),
      floors: async () => ({
        floors: FLOORS.map((f) => ({
          key: f.key,
          siteId: f.siteId as Product['siteId'],
          floorId: f.floorId,
          label: f.label,
          enabled: true
        })),
        counts: Object.fromEntries(FLOORS.map((f) => [f.key, f.count]))
      }),
      query: async (q: LibraryQuery) => query(q),
      makers: async (filter?: MakerFilter) => makers(filter),
      workTypes: async (filter?: TagFilter) => {
        const rows = all.filter(
          (p) =>
            (!filter?.categories?.length || filter.categories.includes(p.category)) &&
            (!filter?.siteIds?.length || filter.siteIds.includes(p.siteId))
        );
        const counts = new Map<string, number>();
        for (const p of rows) {
          if (p.workType) counts.set(p.workType, (counts.get(p.workType) ?? 0) + 1);
        }
        return [...counts.entries()]
          .map(([workType, count]) => ({ workType, count }))
          .sort((a, b) => b.count - a.count);
      },
      tags: async (filter?: TagFilter) => {
        const rows = all.filter(
          (p) =>
            (!filter?.categories?.length || filter.categories.includes(p.category)) &&
            (!filter?.siteIds?.length || filter.siteIds.includes(p.siteId)) &&
            (filter?.tags ?? []).every((t) => p.tags.includes(t)) &&
            // 選択中のブランドに連動（本物と同じ）
            (!filter?.makers?.length || filter.makers.includes(p.maker ?? ''))
        );
        const counts = new Map<string, number>();
        for (const p of rows) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
        return [...counts.entries()]
          .map(([tag, count]) => ({ tag, count }))
          .sort((a, b) => b.count - a.count);
      },
      product: async (id: number) => all.find((p) => p.id === id) ?? null,
      setFavorite: async (id: number, favorite: boolean) => {
        const p = all.find((x) => x.id === id);
        if (p) p.favoriteAt = favorite ? Date.now() : null;
        return p ?? null;
      },
      autoUsed: async () => mockAutoUsed,
      setAutoUsed: async (on: boolean) => (mockAutoUsed = on),
      setUsed: async (id: number, used: boolean) => {
        const p = all.find((x) => x.id === id);
        if (p) p.viewedAt = used ? Date.now() : null;
        return p ?? null;
      },
      detail: async () => ({ supported: false }),
      files: async () => null
    },
    playlists: {
      list: async () => mockPlaylists.map(toPlaylist),
      create: async (name: string, productRefs: number[] = []) => {
        const found = mockPlaylists.find((p) => p.name === name);
        const list = found ?? { id: mockPlaylists.length + 1, name, items: [] as number[], createdAt: Date.now(), updatedAt: Date.now() };
        if (!found) mockPlaylists.push(list);
        for (const ref of productRefs) if (!list.items.includes(ref)) list.items.push(ref);
        return toPlaylist(list);
      },
      rename: async (id: number, name: string) => {
        const list = mockPlaylists.find((p) => p.id === id);
        if (list) list.name = name;
        return list ? toPlaylist(list) : null;
      },
      remove: async (id: number) => {
        const at = mockPlaylists.findIndex((p) => p.id === id);
        if (at >= 0) mockPlaylists.splice(at, 1);
        return at >= 0;
      },
      add: async (id: number, productRefs: number[]) => {
        const list = mockPlaylists.find((p) => p.id === id);
        if (!list) return 0;
        const before = list.items.length;
        for (const ref of productRefs) if (!list.items.includes(ref)) list.items.push(ref);
        return list.items.length - before;
      },
      removeItems: async (id: number, productRefs: number[]) => {
        const list = mockPlaylists.find((p) => p.id === id);
        if (!list) return 0;
        const before = list.items.length;
        list.items = list.items.filter((ref) => !productRefs.includes(ref));
        return before - list.items.length;
      },
      of: async (productRef: number) => mockPlaylists.filter((p) => p.items.includes(productRef)).map(toPlaylist)
    },
    sync: {
      start: async () => ({ runId: 1, floors: [] }),
      cancel: async () => true,
      lastAt: async () => Date.now()
    },
    meta: {
      status: async () => mockMeta,
      setEnabled: async (enabled: boolean) => ((mockMeta.enabled = enabled), mockMeta),
      setSpeed: async (intervalMs: number, concurrency: number) => {
        mockMeta.intervalMs = intervalMs;
        mockMeta.concurrency = concurrency;
        mockMeta.etaSeconds = Math.round((mockMeta.pending * intervalMs) / concurrency / 1000);
        return mockMeta;
      },
      runNow: async () => ((mockMeta.pausedReason = null), mockMeta)
    },
    credentials: {
      list: async () => ({ available: true, items: [...mockCredentials.values()] }),
      get: async (siteId: string) =>
        mockCredentials.get(siteId) ?? { siteId, loginId: null, hasPassword: false, updatedAt: null },
      reveal: async () => ({ loginId: 'mock@example.com', password: 'mock-password' }),
      save: async (siteId: string, loginId: string) => {
        const item = { siteId, loginId, hasPassword: true, updatedAt: Date.now() };
        mockCredentials.set(siteId, item);
        return item;
      },
      clear: async (siteId: string) => {
        mockCredentials.delete(siteId);
        return { siteId, loginId: null, hasPassword: false, updatedAt: null };
      }
    },
    download: {
      enqueue: async () => 0,
      estimate: async (ids: number[]) => ({
        products: ids.length,
        files: ids.length,
        bytes: ids.length * 500 * 1024 * 1024,
        unknown: 0,
        freeBytes: 400 * 1024 ** 3,
        short: false
      }),
      list: async () => [],
      pause: async () => undefined,
      resume: async () => undefined,
      cancel: async () => undefined,
      retry: async () => undefined,
      remove: async () => undefined,
      settings: async () => ({ root: 'D:\Simaeru', template: '{site}/{category}/{maker}/[{maker}] {title}', concurrency: 1 }),
      saveSettings: async () => ({ root: 'D:\Simaeru', template: '{site}/{category}/{maker}/[{maker}] {title}', concurrency: 1 }),
      pickRoot: async () => ({ root: 'D:\Simaeru', template: '{site}/{category}/{maker}/[{maker}] {title}', concurrency: 1 })
    },
    importFiles: {
      folders: async () => ['D:\\MyLibrary'],
      addFolder: async () => ['D:\\MyLibrary'],
      removeFolder: async () => [],
      scan: async () => ({ scanned: 0, linked: 0, skipped: 0, pending: [] }),
      link: async () => true
    },
    viewer: {
      neeview: async () => null,
      setNeeView: async () => null,
      open: async () => undefined
    },
    jobs: {
      list: async () => [],
      settings: async () => ({
        settings: { autoExtract: false, deleteArchiveAfterExtract: false, autoFlac: false, lossyOnly: false,
          stripPdfTypes: [], archiveHandling: { manga: 'archive', cg: 'archive', voice: 'archive', music: 'archive', video: 'archive', novel: 'archive', other: 'archive' },
          flacMinBytes: 200 * 1024 * 1024, flacOriginal: 'trash', sevenZipPath: '', ffmpegPath: '' },
        tools: { sevenZip: 'C:\\Program Files\\7-Zip\\7z.exe', ffmpeg: null, ffprobe: null }
      }),
      saveSettings: async () => undefined,
      forProduct: async () => []
    },
    content: {
      index: async (productRef: number) => ({
        productRef, sources: [], audioGroups: [], documents: [], subtitles: [], images: [], videos: [], books: [],
        wavBytes: 0, wavCount: 0, audioOnlyInArchive: false
      }),
      getState: async () => null,
      setState: async () => undefined
    },
    install: { analyze: async () => [], dgpSummary: async () => ({ installed: true, exe: null, dgpOnly: 0, linked: 0 }) },
    tools: {
      status: async () => ({
        status: { sevenZip: null, ffmpeg: null, ffprobe: null, neeview: null, sources: { sevenZip: null, ffmpeg: null, neeview: null }, toolsDir: 'C:/tools' },
        installed: { sevenZip: null, ffmpeg: null, neeview: null }
      })
    },
    files: async () => ({ files: [], downloadable: 1 }),
    showInFolder: async () => undefined,
    openPath: async () => '',
    openExternal: async () => undefined,
    on: {
      syncProgress: noop,
      authChanged: noop,
      coversProgress: noop,
      metaProgress: noop,
      downloadProgress: noop,
      importProgress: noop,
      jobsProgress: noop,
      toolsProgress: noop,
      filesChanged: noop
    }
  } as unknown as Window['api'];
}
