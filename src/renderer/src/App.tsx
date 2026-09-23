import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Category,
  LibraryQuery,
  LoginStatus,
  DownloadRow,
  JobRow,
  LocalState,
  MetaStatus,
  Product,
  SearchField,
  ServiceWarning,
  DgpSummary,
  WorkType,
  SortDir,
  SortKey,
  SyncProgress,
  Playlist
} from '@shared/types';
import Sidebar from './components/Sidebar';
import CredentialsDialog from './components/CredentialsDialog';
import DownloadPanel from './components/DownloadPanel';
import SettingsPanel from './components/SettingsPanel';
import ImportPanel from './components/ImportPanel';
import Toolbar from './components/Toolbar';
import LibraryGrid from './components/LibraryGrid';
import DetailPanel from './components/DetailPanel';
import StatusBar from './components/StatusBar';
import SyncHistory from './components/SyncHistory';
import SelectionReview from './components/SelectionReview';
import PlaylistPicker from './components/PlaylistPicker';
import { installDialogFocus } from './lib/dialogFocus';
import { t } from '@shared/i18n';
import { formatBytes } from './lib/format';

const PAGE_SIZE = 120;

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 保存できない環境では覚えないだけ */
  }
}

export default function App(): JSX.Element {
  useEffect(() => installDialogFocus(document.body), []);
  const [categoryCounts, setCategoryCounts] = useState<Array<{ category: string; count: number }>>(
    []
  );
  const [siteCounts, setSiteCounts] = useState<Array<{ siteId: string; count: number }>>([]);
  const [favoriteCount, setFavoriteCount] = useState(0);
  const [usedCount, setUsedCount] = useState(0);
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [usedOnly, setUsedOnly] = useState(false);
  const [localCounts, setLocalCounts] = useState({ have: 0, none: 0, installed: 0, notInstalled: 0, linkable: 0, broken: 0 });
  /** DMM GAMES PLAYER が要る作品を持っているのに、入っていないか */
  const [dgp, setDgp] = useState<DgpSummary | null>(null);
  const refreshDgp = useCallback(() => void window.api.install.dgpSummary().then(setDgp).catch(() => undefined), []);
  const dgpWarning = dgp && !dgp.installed && dgp.dgpOnly > 0 ? t('DMM GAMES PLAYER が入っていません（専用の作品 {count} 件）', { count: dgp.dgpOnly }) : null;
  const [localState, setLocalState] = useState<LocalState | null>(null);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [auth, setAuth] = useState<LoginStatus[]>([]);

  const [selectedCategories, setSelectedCategories] = useState<Category[]>([]);
  const [selectedSites, setSelectedSites] = useState<string[]>([]);
  const [selectedMakers, setSelectedMakers] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedWorkTypes, setSelectedWorkTypes] = useState<WorkType[]>([]);
  const [selectedCreators, setSelectedCreators] = useState<string[]>([]);
  const [searchFields, setSearchFields] = useState<SearchField[]>(['title', 'maker']);
  const [search, setSearch] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [regexError, setRegexError] = useState<string | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState('');
  // 並べ替えと表示のしかたは、次に起動したときも同じにする
  const [sortKey, setSortKey] = useState<SortKey>(() => {
    const saved = readPref('library.sortKey');
    // 以前の「起動日順」「閲覧日順」は「利用日順」にまとめた
    if (saved === 'launched' || saved === 'viewed') return 'used';
    return (saved as SortKey | null) ?? 'purchased';
  });
  const [sortDir, setSortDir] = useState<SortDir>(() => (readPref('library.sortDir') as SortDir) ?? 'desc');
  const [view, setView] = useState<'grid' | 'list'>(() => (readPref('library.view') as 'grid' | 'list') ?? 'grid');
  useEffect(() => writePref('library.sortKey', sortKey), [sortKey]);
  useEffect(() => writePref('library.sortDir', sortDir), [sortDir]);
  useEffect(() => writePref('library.view', view), [view]);

  const [items, setItems] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // 選んでダウンロードする。選択は一覧の読み直し（絞り込みの変更）をまたいで残す
  const [selecting, setSelecting] = useState(false);
  /** 選ぶ画面を何のために開いたか（削除・プレイリストのときは、そのボタンを主にする） */
  const [selectPurpose, setSelectPurpose] = useState<'download' | 'delete' | 'playlist'>('download');
  /** プレイリスト（自分で作る一覧） */
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [playlistId, setPlaylistId] = useState<number | null>(null);
  /** プレイリストに入れる小窓を開いているときの、入れる作品 */
  const [playlistFor, setPlaylistFor] = useState<number[] | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set());
  const [reviewIds, setReviewIds] = useState<number[] | null>(null);
  const anchorRef = useRef<number | null>(null);

  const [meta, setMeta] = useState<MetaStatus | null>(null);
  const [downloads, setDownloads] = useState<DownloadRow[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [settingsOpen, setSettingsOpen] = useState<false | 'default' | 'account'>(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [credentialSite, setCredentialSite] = useState<string | null>(null);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncHistoryOpen, setSyncHistoryOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 画面の右下に少しだけ出す知らせ（ダウンロードをキューに入れた、など） */
  const [toast, setToast] = useState<{ text: string; id: number; downloads: boolean } | null>(null);
  /** @param downloads 「ダウンロード管理を開く」を添えるか */
  const showToast = useCallback((text: string, downloads = true) => {
    const id = Date.now();
    setToast({ text, id, downloads });
    setTimeout(() => setToast((tItem) => (tItem?.id === id ? null : tItem)), 4000);
  }, []);

  const offsetRef = useRef(0);

  const [siteLabels, setSiteLabels] = useState<Record<string, string>>({});
  const dmmAuth = auth.find((a) => a.siteId === 'dmm');
  const dmmLoggedIn = dmmAuth?.loggedIn ?? false;
  // 本体とは別にログインが要るサービス。動画は本体にログイン済みなのに未認証のときだけ、
  // 一般向けの DMM ブックス（dmm.com）は一般向けの本を持っていて未ログインのときだけ出す
  const serviceWarnings = useMemo<ServiceWarning[]>(() => {
    const out: ServiceWarning[] = [];
    for (const [service, value] of Object.entries(dmmAuth?.services ?? {})) {
      if (value === null) out.push({ siteId: 'dmm', service, uncertain: true, label: service === 'video' ? t('DMM 動画') : t('DMMブックス（一般）'), text: t('ログイン状態を確認できません') });
    }
    if (dmmLoggedIn && dmmAuth?.services?.video === false) {
      out.push({ siteId: 'dmm', service: 'video', label: t('DMM 動画'), text: t('動画だけ未認証です') });
    }
    if (dmmAuth?.services?.bookCom === false) {
      out.push({ siteId: 'dmm', service: 'bookCom', label: t('DMMブックス（一般）'), text: t('dmm.com（一般向けの本）に未ログイン') });
    }
    return out;
  }, [dmmAuth, dmmLoggedIn]);

  const refreshFacets = useCallback(async () => {
    const res = await window.api.library.facets();
    setCategoryCounts(res.categories);
    setSiteCounts(res.sites);
    setFavoriteCount(res.favorites);
    setUsedCount(res.used);
    setLocalCounts(res.local);
  }, []);

  const refreshAuth = useCallback(async () => {
    setAuth(await window.api.auth.status());
  }, []);

  useEffect(() => {
    // フロアの enabled はログイン状態から決まるので、必ず認証確認のあとに読む
    void refreshAuth().then(refreshFacets);
    void window.api.appInfo().then((info) => {
      setSiteLabels(Object.fromEntries(info.sites.map((s) => [s.siteId, s.label])));
    });
    void window.api.sync.lastAt().then(setLastSyncAt);
    void window.api.meta.status().then(setMeta);
    void window.api.download.list().then(setDownloads);
    void window.api.jobs.list().then(setJobs);
    const offMeta = window.api.on.metaProgress(setMeta);
    const offDownload = window.api.on.downloadProgress(setDownloads);
    const offJobs = window.api.on.jobsProgress(setJobs);
    // 紐付け・起動のあとは、件数（未インストール）とその作品の表示を直す。
    // 絞り込み・並びがその状態に左右されるときだけ一覧ごと読み直す（スクロール位置を飛ばさないため）
    // ダウンロードが済んだ・展開した・削除したときも同じ。続けて届くので、落ち着いてから1回だけ直す
    let changedTimer: ReturnType<typeof setTimeout> | undefined;
    const changed = new Set<number | null>();
    const onChanged = (productRef: number | null): void => {
      changed.add(productRef);
      clearTimeout(changedTimer);
      changedTimer = setTimeout(() => {
        const refs = [...changed];
        changed.clear();
        void refreshFacets();
        const q = queryRef.current;
        if (refs.includes(null) || !!q.localState || q.sortKey === 'used') {
          void reloadFirstPage();
          return;
        }
        for (const id of refs) {
          void window.api.library.product(id as number).then((p) => {
            if (p) setItems((prev) => prev.map((i) => (i.id === p.id ? p : i)));
          });
        }
      }, 400);
    };
    const offLibrary = window.api.on.libraryChanged(({ productRef }) => {
      onChanged(productRef);
      if (productRef === null) refreshDgp();
    });
    refreshDgp();
    const offFiles = window.api.on.filesChanged(({ productRef }) => onChanged(productRef));
    // ログイン状態は起動時と auth:changed でしか見ていなかったので、
    // 途中で切れた/戻ったときに表示が古いまま残る。定期的に確かめ直す。
    const authTimer = setInterval(() => void refreshAuth(), 5 * 60 * 1000);
    const offProgress = window.api.on.syncProgress((p) => {
      setProgress(p);
      if (p.phase === 'done' || p.phase === 'cancelled') {
        void refreshFacets();
        void window.api.sync.lastAt().then(setLastSyncAt);
      }
    });
    const offAuth = window.api.on.authChanged(() => {
      void refreshAuth();
      void refreshFacets();
    });
    // 表紙キャッシュは数千件を数十バッチで流すので、都度リロードすると描画が詰まる。
    // 最後のバッチから落ち着いた時点で1回だけ読み直す。
    let coversTimer: ReturnType<typeof setTimeout> | undefined;
    const offCovers = window.api.on.coversProgress(() => {
      clearTimeout(coversTimer);
      coversTimer = setTimeout(() => void reloadFirstPage(), 2000);
    });
    return () => {
      clearInterval(authTimer);
      clearTimeout(coversTimer);
      offProgress();
      offAuth();
      offCovers();
      offMeta();
      offDownload();
      offJobs();
      offLibrary();
      offFiles();
      clearTimeout(changedTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const tItem = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(tItem);
  }, [search]);

  const query = useMemo<LibraryQuery>(
    () => ({
      categories: selectedCategories,
      siteIds: selectedSites,
      search: debouncedSearch,
      useRegex,
      makers: selectedMakers,
      tags: selectedTags,
      workTypes: selectedWorkTypes,
      creators: selectedCreators,
      searchFields,
      favoriteOnly,
      usedOnly,
      playlistId,
      localState: localState ?? undefined,
      sortKey,
      sortDir,
      limit: PAGE_SIZE
    }),
    [
      selectedCategories,
      selectedSites,
      debouncedSearch,
      useRegex,
      selectedMakers,
      selectedTags,
      selectedWorkTypes,
      selectedCreators,
      searchFields,
      favoriteOnly,
      usedOnly,
      playlistId,
      localState,
      sortKey,
      sortDir
    ]
  );

  // reloadFirstPage を再生成せずに最新クエリを参照するための ref
  const queryRef = useRef(query);

  // setLoading の反映を待つ間に何度も呼ばれるのを防ぐ（state だけでは間に合わない）
  const loadingRef = useRef(false);
  const queryGeneration = useRef(0);
  // render時点で古い応答を無効化する（effectより先に応答が戻っても混ざらない）。
  if (queryRef.current !== query) {
    queryRef.current = query;
    queryGeneration.current++;
  }

  const reloadFirstPage = useCallback(async () => {
    const generation = ++queryGeneration.current;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await window.api.library.query({ ...queryRef.current, offset: 0 });
      if (generation !== queryGeneration.current) return;
      setItems(page.items);
      setTotal(page.total);
      setRegexError(page.regexError ?? null);
      offsetRef.current = page.items.length;
    } catch (err) {
      if (generation === queryGeneration.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (generation === queryGeneration.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    queryRef.current = query;
    void reloadFirstPage();
  }, [query, reloadFirstPage]);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || items.length >= total) return;
    const generation = queryGeneration.current;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await window.api.library.query({
        ...queryRef.current,
        offset: offsetRef.current
      });
      if (generation !== queryGeneration.current) return;
      setItems((prev) => [...prev, ...page.items]);
      setTotal(page.total);
      offsetRef.current += page.items.length;
    } catch (err) {
      if (generation === queryGeneration.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (generation === queryGeneration.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [items.length, total]);

  const startSync = useCallback(async (opts?: { full?: boolean }, retryKeys?: string[]) => {
    // 同期の単位はサイト側のフロア。押した時点の状態を取り直してから対象を決める。
    const fresh = await window.api.library.floors();
    // サイトを絞っているならそのサイトだけ、そうでなければログイン済みの全フロア
    const targets = fresh.floors
      .filter((f) => f.enabled)
      .filter((f) => retryKeys ? retryKeys.includes(f.key) : selectedSites.length === 0 || selectedSites.includes(f.siteId))
      .map((f) => f.key);
    if (targets.length === 0) {
      setError(
        t('ログイン済みの同期対象がありません。ログイン状態を確認してから再実行してください。')
      );
      return;
    }
    setSyncing(true);
    setError(null);
    try {
      const result = await window.api.sync.start(targets, opts);
      const failed = result.floors.filter((f) => f.error);
      if (failed.length) { setError(failed.map((f) => `${f.floorKey}: ${f.error}`).join('\n')); setSyncHistoryOpen(true); }
      await refreshFacets();
      await reloadFirstPage();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }, [selectedSites, refreshFacets, reloadFirstPage]);

  const toggleFavorite = useCallback(async (product: Product) => {
    const updated = await window.api.library.setFavorite(product.id, !product.favoriteAt);
    if (!updated) return;
    setItems((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    setOffList((prev) => (prev?.id === updated.id ? updated : prev));
    setFavoriteCount((n) => n + (updated.favoriteAt ? 1 : -1));
    // お気に入りだけを見ているときは、外したものが残らないよう取り直す
    if (favoriteOnly && !updated.favoriteAt) void reloadFirstPage();
  }, [favoriteOnly, reloadFirstPage]);

  /** ♡「使った」。お気に入り（★）とは別で、最後に使った日を付ける・外す */
  const toggleUsed = useCallback(async (product: Product) => {
    const updated = await window.api.library.setUsed(product.id, !product.viewedAt);
    if (!updated) return;
    setItems((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    setOffList((prev) => (prev?.id === updated.id ? updated : prev));
    setUsedCount((n) => n + (updated.viewedAt ? 1 : -1));
    // 「使った」だけを見ているときは、外したものが残らないよう取り直す
    if (usedOnly && !updated.viewedAt) void reloadFirstPage();
  }, [usedOnly, reloadFirstPage]);

  /** プレイリストの一覧を読み直す（作った・入れた・消したあと） */
  const reloadPlaylists = useCallback(async () => {
    setPlaylists(await window.api.playlists.list());
  }, []);
  useEffect(() => {
    void reloadPlaylists();
    return window.api.on.playlistsChanged((p) => setPlaylists(p.playlists));
  }, [reloadPlaylists]);
  // 見ているプレイリストが消えたら、絞り込みを外す
  useEffect(() => {
    if (playlistId !== null && !playlists.some((p) => p.id === playlistId)) setPlaylistId(null);
  }, [playlists, playlistId]);
  // プレイリストを見ていないときの「プレイリスト順」は意味が無いので、購入日順へ戻す
  useEffect(() => {
    if (playlistId === null && sortKey === 'playlist') setSortKey('purchased');
  }, [playlistId, sortKey]);


  /** 選んだ作品をキューへ。導線が無ければメイン側で詳細を取りに行く */
  const enqueue = useCallback(async (ids: number[], confirmFirst = false): Promise<boolean> => {
    if (ids.length === 0) return false;
    if (confirmFirst) {
      // まとめて積むときは、必要な容量と空き容量を見せてから確認する
      const est = await window.api.download.estimate(ids);
      if (est.products === 0) {
        setError(t('対象がありません（すべてダウンロード済みです）。'));
        return false;
      }
      const gb = (n: number): string => `${(n / 1024 ** 3).toFixed(1)} GB`;
      const lines = [
        t('{0} 作品 / {1} ファイルをキューに入れます。', { 0: est.products.toLocaleString(), 1: est.files.toLocaleString() }),
        t('必要な容量: 約 {0}{1}', { 0: gb(est.bytes), 1: est.unknown > 0 ? t('（{unknown} 件はサイズ不明）', { unknown: est.unknown }) : '' }),
        est.freeBytes !== null ? t('空き容量: {0}', { 0: gb(est.freeBytes) }) : t('空き容量: 不明'),
        est.short ? t('\n空き容量が足りない可能性があります。') : ''
      ];
      if (!window.confirm(lines.filter(Boolean).join('\n'))) return false;
    }
    const added = await window.api.download.enqueue(ids);
    setDownloads(await window.api.download.list());
    if (added === 0 && ids.length === 1 && (await window.api.download.list()).some((d) => d.productRef === ids[0] && d.state !== 'error')) {
      showToast(t('ダウンロード済み、またはダウンロード中です'));
      return true;
    }
    // ダウンロード管理は開かない（作業の邪魔になる）。状況はステータスバーのバッジと知らせで伝える
    showToast(
      added > 0
        ? t('{0}{1} ファイルをダウンロードのキューに入れました', { 0: ids.length === 1 ? '' : t('{0} 作品・', { 0: ids.length.toLocaleString() }), 1: added.toLocaleString() })
        : t('ダウンロードできるファイルが見つかりませんでした（ダウンロード管理に理由が出ています）')
    );
    return true;
  }, [showToast]);

  /** 表示中（絞り込みに合う）作品すべての ID。読み込み済みのページだけでなく、続きも含む */
  const shownIds = (): Promise<number[]> => window.api.library.queryIds({ ...queryRef.current, offset: 0 });

  /** 選んだ作品の手元のファイルを、確かめてからごみ箱へ入れる */
  const trashSelected = (): Promise<void> => trashProducts([...checkedIds], 'selected');

  /** 作品の手元のファイルを、確かめてからごみ箱へ入れる */
  const trashProducts = async (ids: number[], scope: 'selected' | 'shown'): Promise<void> => {
    const plan = await window.api.trashPlan(ids);
    if (plan.products === 0) {
      showToast(
        plan.busy > 0
          ? t('ダウンロード中・処理中の作品は削除できません。')
          : scope === 'shown'
            ? t('表示中の作品に手元のファイルはありません。')
            : t('選んだ作品に手元のファイルはありません。'),
        false
      );
      return;
    }
    const names = await Promise.all(ids.slice(0, 50).map(async (id) => (await window.api.library.product(id))?.title ?? `#${id}`));
    const lines = [
      names.join('\n') + (ids.length > 50 ? `\n… (+${ids.length - 50})` : ''),
      scope === 'shown' ? t('表示中の {0} 件すべてが対象です。', { 0: ids.length.toLocaleString() }) : '',
      t('{0} 作品の手元のファイル {1} 件（{2}）をごみ箱へ入れます。', { 0: plan.products.toLocaleString(), 1: plan.files.toLocaleString(), 2: formatBytes(plan.bytes) }),
      plan.installed > 0 ? t('インストール先のフォルダも消える作品が {installed} 件あります（紐付けを外します）。', { installed: plan.installed }) : '',
      plan.busy > 0 ? t('ダウンロード中・処理中の {busy} 作品は外します。', { busy: plan.busy }) : '',
      t('あとで「アプリでダウンロード」から、もう一度ダウンロードできます。')
    ];
    if (!window.confirm(lines.filter(Boolean).join('\n'))) return;
    const res = await window.api.trashMany(ids);
    showToast(
      res.failed.length > 0
        ? t('{products} 作品のファイルをごみ箱へ入れました（{count} 件は削除できませんでした）', { products: res.products, count: res.failed.length })
        : t('{products} 作品のファイルをごみ箱へ入れました（{0}）', { products: res.products, 0: formatBytes(res.bytes) }),
      false
    );
    setCheckedIds(new Set());
    setSelecting(false);
    await refreshFacets();
    await reloadFirstPage();
  };

  // キーボード: Esc で手前のものから閉じる / Ctrl+F・/ で検索欄へ
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing = e.target instanceof HTMLElement && !!e.target.closest('input,select,textarea');
      if ((e.ctrlKey && e.key.toLowerCase() === 'f') || (e.key === '/' && !typing)) {
        const input = document.querySelector<HTMLInputElement>('.toolbar__search input');
        if (input) {
          e.preventDefault();
          input.focus();
          input.select();
        }
        return;
      }
      if (e.key !== 'Escape') return;
      // ビューア・プレイヤー・作品詳細の中のダイアログは、それぞれが Esc を受け持つ
      if (document.querySelector('.viewer, .player, .detail .modal')) return;
      if (typing && (e.target as HTMLInputElement).value) return; // 入力中の Esc は入力欄に任せる
      if (credentialSite) setCredentialSite(null);
      else if (settingsOpen) setSettingsOpen(false);
      else if (downloadOpen) setDownloadOpen(false);
      else if (importOpen) setImportOpen(false);
      else if (selecting) {
        setSelecting(false);
        setCheckedIds(new Set());
      } else if (selectedId !== null) setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [credentialSite, settingsOpen, downloadOpen, importOpen, selecting, selectedId]);

  /** 一覧に出ていない作品（総集編の収録作品から開いたものなど）の詳細 */
  const [offList, setOffList] = useState<Product | null>(null);
  const selected = useMemo(
    () => items.find((i) => i.id === selectedId) ?? (offList?.id === selectedId ? offList : null),
    [items, selectedId, offList]
  );
  const openProduct = useCallback(
    (id: number): void => {
      if (!items.some((i) => i.id === id)) {
        void window.api.library.product(id).then((p) => {
          if (!p) return;
          setOffList(p);
          setSelectedId(p.id);
        });
        return;
      }
      setSelectedId(id);
    },
    [items]
  );

  // 初回・未ログインでもSidebarのDMM/DLsite、設定、ローカル取り込みを常に利用できる。

  return (
    <div className="app">
      <Sidebar
        categoryCounts={categoryCounts}
        siteCounts={siteCounts}
        favoriteCount={favoriteCount}
        favoriteOnly={favoriteOnly}
        onFavoriteOnly={setFavoriteOnly}
        usedCount={usedCount}
        usedOnly={usedOnly}
        onUsedOnly={setUsedOnly}
        playlists={playlists}
        playlistId={playlistId}
        onSelectPlaylist={setPlaylistId}
        onReloadPlaylists={() => void reloadPlaylists()}
        localCounts={localCounts}
        localState={localState}
        onLocalState={setLocalState}
        selectedCategories={selectedCategories}
        onSelectCategories={setSelectedCategories}
        selectedSites={selectedSites}
        onSelectSites={setSelectedSites}
        selectedMakers={selectedMakers}
        onSelectMakers={setSelectedMakers}
        selectedTags={selectedTags}
        onSelectTags={setSelectedTags}
        selectedWorkTypes={selectedWorkTypes}
        onSelectWorkTypes={setSelectedWorkTypes}
        selectedCreators={selectedCreators}
        onSelectCreators={setSelectedCreators}
        auth={auth}
        siteLabels={siteLabels}
        onLogin={(siteId) => window.api.auth.login(siteId)}
        serviceWarnings={serviceWarnings}
        dgpWarning={dgpWarning}
        onLoginService={(siteId, service) => window.api.auth.login(siteId, service)}
        onOpenSettings={(section) => setSettingsOpen(section ?? 'default')}
        refreshMessage={refreshMessage}
        onRefreshLocal={() => {
          setRefreshMessage(t('準備しています…'));
          const off = window.api.on.refreshProgress((p) =>
            setRefreshMessage(p.total > 0 ? t('{message}（{done}/{total}）', { message: p.message, done: p.done, total: p.total }) : p.message)
          );
          void window.api.download
            .refreshLocal()
            .then(async () => {
              await refreshFacets();
              await reloadFirstPage();
            })
            .finally(() => {
              off();
              setRefreshMessage(null);
            });
        }}
      />

      <main className="main">
        <Toolbar
          search={search}
          onSearch={setSearch}
          useRegex={useRegex}
          onUseRegex={setUseRegex}
          regexError={regexError}
          searchFields={searchFields}
          onSearchFields={setSearchFields}
          sortKey={sortKey}
          onSortKey={setSortKey}
          sortDir={sortDir}
          onSortDir={setSortDir}
          view={view}
          onView={setView}
          total={total}
          onDownloadAll={() => void shownIds().then((ids) => enqueue(ids, true))}
          canTrash={!!localState && localState !== 'none'}
          onTrashAll={() => void shownIds().then((ids) => trashProducts(ids, 'shown'))}
          onStartDeleting={() => {
            setSelectPurpose('delete');
            setSelecting(true);
          }}
          selecting={selecting}
          onAddShownToPlaylist={() => void shownIds().then((ids) => setPlaylistFor(ids))}
          onStartPlaylisting={() => {
            setSelectPurpose('playlist');
            setSelecting(true);
          }}
          onStartSelecting={() => {
            setSelectPurpose('download');
            setSelecting(true);
          }}
          syncing={syncing}
          onSync={startSync}
          onCancel={() => window.api.sync.cancel()}
        />
        {error && (
          <div className="banner banner--error">
            {error}
            <button onClick={() => setError(null)}>{t('閉じる')}</button>
          </div>
        )}
        {selecting && (
          <div className="selectbar">
            <b>{t('{0} 件を選択中', { 0: checkedIds.size.toLocaleString() })}</b>
            <button className="link" disabled={!checkedIds.size} onClick={() => setReviewIds([...checkedIds])}>{t('選択内容を確認')}</button>
            {[...checkedIds].some((id) => !items.some((item) => item.id === id)) && <span role="status">{t('読み込み済み一覧の外に {count} 件の選択があります', { count: [...checkedIds].filter((id) => !items.some((item) => item.id === id)).length })}</span>}
            <span className="muted selectbar__hint">{t('カードを押して選びます。Shift+クリックで範囲を選べます。')}</span>
            <button
              className="btn btn--xs"
              onClick={() => setCheckedIds((prev) => new Set([...prev, ...items.map((i) => i.id)]))}
              title={t('読み込み済みの作品をすべて選びます（スクロールすると続きが読み込まれます）')}
            >
              {t('表示中の {0} 件を選ぶ', { 0: items.length.toLocaleString() })}
            </button>
            <button className="btn btn--xs btn--ghost" disabled={checkedIds.size === 0} onClick={() => setCheckedIds(new Set())}>
              {t('選択を外す')}
            </button>
            <button
              className={`btn btn--xs ${selectPurpose === 'download' ? 'btn--primary' : 'btn--ghost'}`}
              disabled={checkedIds.size === 0}
              onClick={() =>
                void enqueue([...checkedIds], true).then((queued) => {
                  if (!queued) return;
                  setCheckedIds(new Set());
                  setSelecting(false);
                })
              }
            >
              {t('選んだ {0} 件をダウンロード', { 0: checkedIds.size.toLocaleString() })}
            </button>
            <button
              className={`btn btn--xs ${selectPurpose === 'delete' ? 'btn--danger' : 'btn--ghost'}`}
              disabled={checkedIds.size === 0}
              title={t('選んだ作品の手元のファイルをごみ箱へ入れます')}
              onClick={() => void trashSelected()}
            >
              {selectPurpose === 'delete' ? t('選んだ {0} 件のファイルを削除', { 0: checkedIds.size.toLocaleString() }) : t('ファイルを削除')}
            </button>
            <button
              className={`btn btn--xs ${selectPurpose === 'playlist' ? 'btn--primary' : 'btn--ghost'}`}
              disabled={checkedIds.size === 0}
              title={t('選んだ作品をプレイリストに入れます')}
              onClick={() => setPlaylistFor([...checkedIds])}
            >
              {selectPurpose === 'playlist'
                ? t('選んだ {0} 件をプレイリストに追加', { 0: checkedIds.size.toLocaleString() })
                : t('プレイリストに追加')}
            </button>
            <button
              className="btn btn--xs btn--ghost"
              onClick={() => {
                setSelecting(false);
                setCheckedIds(new Set());
              }}
            >
              {t('やめる')}
            </button>
          </div>
        )}
        {!loading && total === 0 && (
          <div className="banner" role="status">
            {t('該当する作品がありません。')}
            <button className="link" onClick={() => {
              setSearch(''); setDebouncedSearch(''); setUseRegex(false);
              setSelectedCategories([]); setSelectedSites([]); setSelectedMakers([]);
              setSelectedTags([]); setSelectedWorkTypes([]); setSelectedCreators([]);
              setFavoriteOnly(false); setLocalState(null); setSearchFields(['title', 'maker']);
            }}>{t('条件を解除')}</button>
            <button className="link" onClick={() => setImportOpen(true)}>{t('取り込み')}</button>
          </div>
        )}
        <LibraryGrid
          selecting={selecting}
          checkedIds={checkedIds}
          onToggleCheck={(id, index, range) => {
            setSelecting(true);
            setCheckedIds((prev) => {
              const next = new Set(prev);
              const anchor = anchorRef.current;
              if (range && anchor !== null) {
                // 範囲は「最後に押したカード」から。押したカードの状態に揃える
                const on = !prev.has(id);
                const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
                for (const item of items.slice(from, to + 1)) {
                  if (on) next.add(item.id);
                  else next.delete(item.id);
                }
              } else if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
            anchorRef.current = index;
          }}
          items={items}
          view={view}
          loading={loading}
          hasMore={items.length < total}
          onLoadMore={loadMore}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onToggleFavorite={(p) => void toggleFavorite(p)}
          onToggleUsed={(p) => void toggleUsed(p)}
          onAddToPlaylist={(p) => setPlaylistFor([p.id])}
        />
        <StatusBar
          onSyncHistory={() => setSyncHistoryOpen(true)}
          progress={progress}
          lastSyncAt={lastSyncAt}
          shown={items.length}
          total={total}
          meta={meta}
          downloads={downloads}
          jobs={jobs}
          onOpenDownloads={() => setDownloadOpen(true)}
          onOpenImport={() => setImportOpen(true)}
          onOpenSettings={() => setSettingsOpen('default')}
          onMetaEnabled={(enabled) => void window.api.meta.setEnabled(enabled).then(setMeta)}
          onMetaSpeed={(intervalMs, concurrency) =>
            void window.api.meta.setSpeed(intervalMs, concurrency).then(setMeta)
          }
          onMetaRunNow={() => void window.api.meta.runNow().then(setMeta)}
        />
      </main>

      {reviewIds && <SelectionReview ids={reviewIds} onClose={() => setReviewIds(null)} />}
      {playlistFor && (
        <PlaylistPicker
          ids={playlistFor}
          playlists={playlists}
          onClose={() => setPlaylistFor(null)}
          onAdded={(added, playlist) => {
            void reloadPlaylists(); // 件数をすぐ合わせる
            showToast(
              added > 0
                ? t('「{name}」に {0} 件を追加しました', { name: playlist.name, 0: added.toLocaleString() })
                : t('「{name}」には、選んだ作品がすでに入っています', { name: playlist.name }),
              false // ダウンロードとは関係がないので、管理を開く導線は出さない
            );
            if (selectPurpose === 'playlist') {
              setCheckedIds(new Set());
              setSelecting(false);
            }
            // そのプレイリストを見ているときは、増えたぶんを出す
            if (playlistId === playlist.id) void reloadFirstPage();
          }}
        />
      )}
      {syncHistoryOpen && <SyncHistory busy={syncing} onClose={() => setSyncHistoryOpen(false)} onRetry={(keys) => void startSync(undefined, keys)} />}
      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.downloads && (
            <button
              className="link"
              onClick={() => {
                setToast(null);
                setDownloadOpen(true);
              }}
            >
              {t('ダウンロード管理を開く')}
            </button>
          )}
        </div>
      )}

      {importOpen && (
        <ImportPanel
          onClose={() => setImportOpen(false)}
          onLinked={() => {
            void refreshFacets();
            void reloadFirstPage();
          }}
        />
      )}

      {downloadOpen && (
        <DownloadPanel
          rows={downloads}
          jobs={jobs}
          onOpenSettings={() => {
            setDownloadOpen(false);
            setSettingsOpen('default');
          }}
          onClose={() => setDownloadOpen(false)}
          onChanged={() => {
            void window.api.download.list().then(setDownloads);
            void refreshFacets();
          }}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          initialSection={settingsOpen === 'account' ? 'account' : undefined}
          onClose={() => {
            setSettingsOpen(false);
            refreshDgp();
          }}
          auth={auth}
          siteLabels={siteLabels}
          serviceWarnings={serviceWarnings}
          onLogin={(siteId) => void window.api.auth.login(siteId).then(refreshAuth)}
          onLoginService={(siteId, service) => void window.api.auth.login(siteId, service).then(refreshAuth)}
          onLogout={async (siteId) => {
            await window.api.auth.logout(siteId);
            await refreshAuth();
          }}
          onRecheck={() => void refreshAuth()}
          onEditCredentials={setCredentialSite}
          onFilesMoved={() => {
            void refreshFacets();
            void reloadFirstPage();
          }}
        />
      )}

      {credentialSite && (
        <CredentialsDialog
          siteId={credentialSite}
          siteLabel={siteLabels[credentialSite] ?? credentialSite}
          onClose={() => setCredentialSite(null)}
        />
      )}

      {selected && (
        <DetailPanel
          product={selected}
          onClose={() => setSelectedId(null)}
          onOpenProduct={openProduct}
          activeTags={selectedTags}
          onToggleTag={(tag) =>
            setSelectedTags((prev) =>
              prev.includes(tag) ? prev.filter((tItem) => tItem !== tag) : [...prev, tag]
            )
          }
          activeCreators={selectedCreators}
          onToggleFavorite={() => void toggleFavorite(selected)}
          onToggleUsed={() => void toggleUsed(selected)}
          playlists={playlists}
          onAddToPlaylist={() => setPlaylistFor([selected.id])}
          onDownload={() => void enqueue([selected.id])}
          onDownloadVideo={(qualityKey) =>
            void window.api.download.enqueueVideo(selected.id, qualityKey).then(async (added) => {
              setDownloads(await window.api.download.list());
              showToast(
                added > 0
                  ? t('{0}{1} ファイルをダウンロードのキューに入れました', { 0: '', 1: added.toLocaleString() })
                  : t('ダウンロードできるファイルが見つかりませんでした（ダウンロード管理に理由が出ています）')
              );
            })
          }
          onRedownload={() =>
            void window.api.download.redownload(selected.id).then(async (added) => {
              setDownloads(await window.api.download.list());
              showToast(added > 0 ? t('もう一度ダウンロードします（落とし終えたら手元のファイルと置き換えます）') : t('ダウンロード中・待機中です'));
            })
          }
          onToggleCreator={(name) =>
            setSelectedCreators((prev) =>
              prev.includes(name) ? prev.filter((v) => v !== name) : [...prev, name]
            )
          }
        />
      )}
    </div>
  );
}
