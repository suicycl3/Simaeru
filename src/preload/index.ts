import { contextBridge, ipcRenderer } from 'electron';
import type {
  CompilationCandidate,
  CompilationInfo,
  CompilationOverrideAction,
  ProductBrief,
  FloorInfo,
  DgpStatus,
  DgpSummary,
  LibraryPage,
  LibraryQuery,
  CredentialSummary,
  DownloadRow,
  DownloadSettings,
  EnqueueEstimate,
  Playlist,
  ScanFile,
  ScanResult,
  LocalFile,
  LoginStatus,
  MakerFilter,
  MetaStatus,
  Product,
  TagFilter,
  SyncProgress,
  SyncResultSummary,
  ContentIndex,
  FlacEstimate,
  FlacOriginal,
  InstallAnalysis,
  InstalledProgram,
  JobRow,
  PostProcessSettings,
  ToolStatus,
  ToolName,
  ToolInstallProgress,
  InstalledToolInfo,
  RefreshProgress,
  RelocationPlan,
  TrashPlan,
  TrashResult
} from '@shared/types';

/** 聴いた位置・読んだ位置（作品ごと） */
export interface PlayerState {
  trackUrl?: string;
  time?: number;
  groupFolder?: string;
  /** ビューア: 最後に開いていたページ */
  imageIndex?: number;
  updatedAt?: number;
}

const api = {
  /** 画面の言語（'ja' | 'en'）。読み込み時に同期で決める */
  lang: ipcRenderer.sendSync('app:langSync') as string,
  setLanguage: (lang: string): Promise<string> => ipcRenderer.invoke('app:setLanguage', lang),
  appInfo: (): Promise<{ appName: string; sites: Array<{ siteId: string; label: string }> }> =>
    ipcRenderer.invoke('app:info'),

  /** 版・データの置き場所・使っているソフトウェアのライセンス */
  aboutInfo: (): Promise<{ version: string; userData: string; notices: string }> => ipcRenderer.invoke('app:about'),
  /** アプリログをファイルに書き出す。戻り値は保存先（取り消したら null） */
  saveLog: (): Promise<string | null> => ipcRenderer.invoke('app:saveLog'),

  auth: {
    diagnostics: (): Promise<string | null> => ipcRenderer.invoke('auth:diagnostics'),
    status: (): Promise<LoginStatus[]> => ipcRenderer.invoke('auth:status'),
    /** service を渡すとサービス別ログイン（'video' = FANZA動画）を開く */
    login: (siteId: string, service?: string): Promise<boolean> =>
      ipcRenderer.invoke('auth:login', siteId, service),
    logout: (siteId: string): Promise<boolean> => ipcRenderer.invoke('auth:logout', siteId)
  },

  library: {
    backup: (): Promise<string | null> => ipcRenderer.invoke('library:backup'),
    restore: (): Promise<boolean> => ipcRenderer.invoke('library:restore'),
    floors: (): Promise<{ floors: FloorInfo[]; counts: Record<string, number> }> =>
      ipcRenderer.invoke('library:floors'),
    query: (q: LibraryQuery): Promise<LibraryPage> => ipcRenderer.invoke('library:query', q),
    /** 絞り込みに合う作品すべての ID（スクロールで読み込んでいない続きも含む） */
    queryIds: (q: LibraryQuery): Promise<number[]> => ipcRenderer.invoke('library:queryIds', q),
    makers: (filter?: MakerFilter): Promise<Array<{ maker: string; count: number }>> =>
      ipcRenderer.invoke('library:makers', filter),
    tags: (filter?: TagFilter): Promise<Array<{ tag: string; count: number }>> =>
      ipcRenderer.invoke('library:tags', filter),
    workTypes: (filter?: TagFilter): Promise<Array<{ workType: string; count: number }>> =>
      ipcRenderer.invoke('library:workTypes', filter),
    facets: (): Promise<{
      categories: Array<{ category: string; count: number }>;
      sites: Array<{ siteId: string; count: number }>;
      favorites: number;
      used: number;
      local: { have: number; none: number; installed: number; notInstalled: number; linkable: number; broken: number };
    }> => ipcRenderer.invoke('library:facets'),
    product: (id: number): Promise<Product | null> => ipcRenderer.invoke('library:product', id),
    /** お気に入りの登録・解除。更新後の作品を返す */
    setFavorite: (id: number, favorite: boolean): Promise<Product | null> =>
      ipcRenderer.invoke('library:setFavorite', id, favorite),
    /** ♡「使った」。お気に入りとは別に、最後に使った日を付ける・外す */
    /** 閲覧したら自動で「使った」にするか（既定はオン） */
    autoUsed: (): Promise<boolean> => ipcRenderer.invoke('library:autoUsed'),
    setAutoUsed: (on: boolean): Promise<boolean> => ipcRenderer.invoke('library:setAutoUsed', on),
    setUsed: (id: number, used: boolean): Promise<Product | null> => ipcRenderer.invoke('library:setUsed', id, used),
    /** force: true で取得済みでも取り直す */
    detail: (id: number, opts?: { force?: boolean }): Promise<unknown> =>
      ipcRenderer.invoke('library:detail', id, opts),
    files: (id: number): Promise<unknown> => ipcRenderer.invoke('library:files', id),
    /** 総集編の収録作品と、この作品を収録している総集編 */
    compilation: (id: number): Promise<CompilationInfo> => ipcRenderer.invoke('library:compilation', id),
    /** 同人・CG などの総集編の収録作品を推定するか（実験的） */
    compilationGuess: (): Promise<boolean> => ipcRenderer.invoke('library:compilationGuess'),
    setCompilationGuess: (on: boolean): Promise<boolean> => ipcRenderer.invoke('library:setCompilationGuess', on),
    /** 収録作品に手で結び付けるときの候補（タイトルの近い順） */
    compilationCandidates: (compilationRef: number, entryTitle: string): Promise<CompilationCandidate[]> =>
      ipcRenderer.invoke('library:compilationCandidates', compilationRef, entryTitle),
    /** 収録作品の結び付けを手で直す（set: 候補から選ぶ / none: 外す / clear: 自動に戻す）。直したあとの収録作品を返す */
    setCompilationOverride: (
      compilationRef: number,
      entryTitle: string,
      action: CompilationOverrideAction,
      productId?: string
    ): Promise<CompilationInfo> =>
      ipcRenderer.invoke('library:setCompilationOverride', compilationRef, entryTitle, action, productId),
    /** 総集編のサークルの作品一覧を取り直す */
    refreshCatalog: (compilationRef: number): Promise<CompilationInfo> => ipcRenderer.invoke('library:refreshCatalog', compilationRef),
    /** 収録作品のストアのページを外部ブラウザで開く */
    openCompilationItem: (compilationRef: number, url: string): Promise<void> =>
      ipcRenderer.invoke('library:openCompilationItem', compilationRef, url)
  },

  sync: {
    history: (): Promise<import('@shared/types').SyncHistoryEntry[]> => ipcRenderer.invoke('sync:history'),
    /** full: true で全件取り直す。既定は差分（新しいぶんだけ） */
    start: (floorKeys: string[], opts?: { full?: boolean }): Promise<SyncResultSummary> =>
      ipcRenderer.invoke('sync:start', floorKeys, opts),
    cancel: (): Promise<boolean> => ipcRenderer.invoke('sync:cancel'),
    lastAt: (): Promise<number | null> => ipcRenderer.invoke('sync:lastAt')
  },

  /** 作品メタの裏取得 */
  meta: {
    status: (): Promise<MetaStatus> => ipcRenderer.invoke('meta:status'),
    setEnabled: (enabled: boolean): Promise<MetaStatus> =>
      ipcRenderer.invoke('meta:setEnabled', enabled),
    /** 取得の速さ。1件ごとの待ち時間(ms)と並列数 */
    setSpeed: (intervalMs: number, concurrency: number): Promise<MetaStatus> =>
      ipcRenderer.invoke('meta:setSpeed', intervalMs, concurrency),
    /** 残りを今すぐ取りにいく（オフでも動かす） */
    runNow: (): Promise<MetaStatus> => ipcRenderer.invoke('meta:runNow')
  },

  /**
   * ログイン情報。パスワードは reveal を呼んだときだけ返る。
   * 保存はOSの保護領域で暗号化される（available:false の環境では保存しない）。
   */
  credentials: {
    list: (): Promise<{ available: boolean; items: CredentialSummary[] }> =>
      ipcRenderer.invoke('credentials:list'),
    get: (siteId: string): Promise<CredentialSummary> => ipcRenderer.invoke('credentials:get', siteId),
    reveal: (siteId: string): Promise<{ loginId: string | null; password: string | null }> =>
      ipcRenderer.invoke('credentials:reveal', siteId),
    save: (siteId: string, loginId: string, password: string): Promise<CredentialSummary> =>
      ipcRenderer.invoke('credentials:save', siteId, loginId, password),
    clear: (siteId: string): Promise<CredentialSummary> =>
      ipcRenderer.invoke('credentials:clear', siteId)
  },

  /** ダウンロード */
  download: {
    enqueue: (ids: number[]): Promise<number> => ipcRenderer.invoke('download:enqueue', ids),
    /** 動画を画質を選んで積む（qualityKey は導線の quality.key） */
    enqueueVideo: (id: number, qualityKey: string): Promise<number> => ipcRenderer.invoke('download:enqueueVideo', id, qualityKey),
    /** ダウンロード済みの作品をもう一度落として、手元のファイルと置き換える */
    redownload: (id: number): Promise<number> => ipcRenderer.invoke('download:redownload', id),
    list: (): Promise<DownloadRow[]> => ipcRenderer.invoke('download:list'),
    /** 積む前の見積もり（必要容量と空き容量） */
    estimate: (ids: number[]): Promise<EnqueueEstimate> =>
      ipcRenderer.invoke('download:estimate', ids),
    pause: (id: number): Promise<void> => ipcRenderer.invoke('download:pause', id),
    resume: (id: number): Promise<void> => ipcRenderer.invoke('download:resume', id),
    cancel: (id: number): Promise<void> => ipcRenderer.invoke('download:cancel', id),
    retry: (id: number): Promise<void> => ipcRenderer.invoke('download:retry', id),
    remove: (id: number): Promise<void> => ipcRenderer.invoke('download:remove', id),
    resumeAll: (): Promise<number> => ipcRenderer.invoke('download:resumeAll'),
    pauseAll: (): Promise<number> => ipcRenderer.invoke('download:pauseAll'),
    clearFinished: (): Promise<number> => ipcRenderer.invoke('download:clearFinished'),
    settings: (): Promise<DownloadSettings> => ipcRenderer.invoke('download:settings'),
    saveSettings: (next: Partial<DownloadSettings>): Promise<DownloadSettings> =>
      ipcRenderer.invoke('download:saveSettings', next),
    pickRoot: (): Promise<DownloadSettings> => ipcRenderer.invoke('download:pickRoot'),
    /** 今の保存先・フォルダ構成に合わせて移すものの計画 */
    relocationPlan: (): Promise<RelocationPlan> => ipcRenderer.invoke('download:relocationPlan'),
    /** 計画のうち選んだものを移す（ジョブとして進む） */
    relocate: (froms: string[]): Promise<number | null> => ipcRenderer.invoke('download:relocate', froms),
    /** 手元の状態をまとめて最新にする */
    refreshLocal: (): Promise<{ products: number; missing: number; errors: number; linked: number; pending: number }> =>
      ipcRenderer.invoke('library:refreshLocal')
  },

  /** プレイリスト（自分で作る一覧） */
  playlists: {
    list: (): Promise<Playlist[]> => ipcRenderer.invoke('playlists:list'),
    /** 作る（同じ名前があればそれを使う）。作品を渡すとそのまま入れる */
    create: (name: string, productRefs: number[] = []): Promise<Playlist> =>
      ipcRenderer.invoke('playlists:create', name, productRefs),
    rename: (id: number, name: string): Promise<Playlist | null> => ipcRenderer.invoke('playlists:rename', id, name),
    remove: (id: number): Promise<boolean> => ipcRenderer.invoke('playlists:delete', id),
    /** 末尾に足す。戻り値は足した数（すでに入っているものは数えない） */
    add: (id: number, productRefs: number[]): Promise<number> => ipcRenderer.invoke('playlists:add', id, productRefs),
    removeItems: (id: number, productRefs: number[]): Promise<number> => ipcRenderer.invoke('playlists:remove', id, productRefs),
    of: (productRef: number): Promise<Playlist[]> => ipcRenderer.invoke('playlists:of', productRef)
  },

  /** 手元のファイルの取り込み */
  importFiles: {
    folders: (): Promise<string[]> => ipcRenderer.invoke('import:folders'),
    addFolder: (): Promise<string[]> => ipcRenderer.invoke('import:addFolder'),
    removeFolder: (folder: string): Promise<string[]> =>
      ipcRenderer.invoke('import:removeFolder', folder),
    scan: (): Promise<ScanResult> => ipcRenderer.invoke('import:scan'),
    link: (filePath: string, productRef: number | null, sizeBytes: number | null): Promise<boolean> =>
      ipcRenderer.invoke('import:link', filePath, productRef, sizeBytes),
    linkMany: (files: ScanFile[], productRef: number | null): Promise<number> =>
      ipcRenderer.invoke('import:linkMany', files, productRef)
  },

  /** 閲覧 */
  viewer: {
    neeview: (): Promise<string | null> => ipcRenderer.invoke('viewer:neeview'),
    /** ビューアを別のウィンドウで開く（いくつでも同時に開ける） */
    popup: (spec: {
      kind: 'images' | 'pdf' | 'video' | 'voice' | 'text';
      productId: number;
      entryUrl?: string | null;
      title?: string | null;
    }): Promise<number> => ipcRenderer.invoke('viewer:popup', spec),
    setNeeView: (exePath: string): Promise<string | null> =>
      ipcRenderer.invoke('viewer:setNeeView', exePath),
    open: (filePath: string, prefer: 'neeview' | 'default'): Promise<unknown> =>
      ipcRenderer.invoke('viewer:open', filePath, prefer),
    /** ダウンロードした DRM 付きの動画を DMM Player で開く */
    openDmmPlayer: (productRef: number, filePath: string): Promise<void> =>
      ipcRenderer.invoke('viewer:openDmmPlayer', productRef, filePath)
  },

  /** ダウンロードのあとの処理（展開・FLAC 変換） */
  jobs: {
    list: (): Promise<JobRow[]> => ipcRenderer.invoke('jobs:list'),
    settings: (): Promise<{ settings: PostProcessSettings; tools: ToolStatus }> =>
      ipcRenderer.invoke('jobs:settings'),
    saveSettings: (next: Partial<PostProcessSettings>): Promise<{ settings: PostProcessSettings; tools: ToolStatus }> =>
      ipcRenderer.invoke('jobs:saveSettings', next),
    pickTool: (kind: 'sevenZip' | 'ffmpeg'): Promise<{ settings: PostProcessSettings; tools: ToolStatus }> =>
      ipcRenderer.invoke('jobs:pickTool', kind),
    /** archived: 圧縮したまま持つ作品を、あえて展開して使う */
    extract: (productRef: number, archive: string, archived?: boolean): Promise<number> =>
      ipcRenderer.invoke('jobs:extract', productRef, archive, archived),
    flacEstimate: (productRef: number, target: string): Promise<FlacEstimate> =>
      ipcRenderer.invoke('jobs:flacEstimate', productRef, target),
    flac: (productRef: number, target: string, original: FlacOriginal): Promise<number> =>
      ipcRenderer.invoke('jobs:flac', productRef, target, original),
    /** MP3 などがある WAV / FLAC を消す（アーカイブは作り直す） */
    lossyOnly: (productRef: number, target: string, original: FlacOriginal): Promise<number> =>
      ipcRenderer.invoke('jobs:lossyOnly', productRef, target, original),
    stripPdf: (productRef: number, target: string, original: FlacOriginal): Promise<number> =>
      ipcRenderer.invoke('jobs:stripPdf', productRef, target, original),
    cancel: (id: number): Promise<void> => ipcRenderer.invoke('jobs:cancel', id),
    retry: (id: number): Promise<void> => ipcRenderer.invoke('jobs:retry', id),
    remove: (id: number): Promise<void> => ipcRenderer.invoke('jobs:remove', id),
    forProduct: (productRef: number): Promise<JobRow[]> => ipcRenderer.invoke('jobs:forProduct', productRef),
    /** 展開したフォルダを消す（元のアーカイブが残っているときだけ。ごみ箱へ） */
    removeExtracted: (productRef: number, folder: string): Promise<boolean> =>
      ipcRenderer.invoke('jobs:removeExtracted', productRef, folder)
  },

  /** 外部ツール（7-Zip / ffmpeg / NeeView）。設定画面から配布元より取得して入れられる */
  tools: {
    status: (): Promise<{ status: ToolStatus; installed: Record<ToolName, InstalledToolInfo | null> }> =>
      ipcRenderer.invoke('tools:status'),
    plan: (tool: ToolName): Promise<{ version: string; assets: Array<{ name: string; size: number }>; source: string }> =>
      ipcRenderer.invoke('tools:plan', tool),
    install: (tool: ToolName): Promise<ToolStatus> => ipcRenderer.invoke('tools:install', tool),
    uninstall: (tool: ToolName): Promise<ToolStatus> => ipcRenderer.invoke('tools:uninstall', tool),
    pick: (tool: ToolName): Promise<ToolStatus> => ipcRenderer.invoke('tools:pick', tool),
    clearPath: (tool: ToolName): Promise<ToolStatus> => ipcRenderer.invoke('tools:clearPath', tool),
    openDir: (): Promise<string> => ipcRenderer.invoke('tools:openDir'),
    /** NeeView に見開き・サブフォルダーを読み込む設定を入れる */
    neeviewDefaults: (): Promise<'created' | 'merged' | 'unchanged'> => ipcRenderer.invoke('tools:neeviewDefaults')
  },

  /** 作品の中身（プレイヤー・ビューア） */
  content: {
    index: (productRef: number): Promise<ContentIndex> => ipcRenderer.invoke('content:index', productRef),
    /** ファイルの有無を確かめる（変わっていれば裏で作り直し、content:updated で知らせる） */
    verify: (productRef: number): Promise<boolean> => ipcRenderer.invoke('content:verify', productRef),
    getState: (productRef: number): Promise<PlayerState | null> => ipcRenderer.invoke('player:getState', productRef),
    setState: (productRef: number, state: PlayerState): Promise<void> =>
      ipcRenderer.invoke('player:setState', productRef, state)
  },

  /** インストール・起動（Phase 2） */
  install: {
    /** DMM Player（動画の公式プレイヤー）が入っているか */
    dmmPlayerStatus: (): Promise<{ installed: boolean; exe: string | null }> => ipcRenderer.invoke('install:dmmPlayerStatus'),
    analyze: (productRef: number): Promise<InstallAnalysis[]> => ipcRenderer.invoke('install:analyze', productRef),
    runInstaller: (productRef: number, installer: string): Promise<string> =>
      ipcRenderer.invoke('install:runInstaller', productRef, installer),
    useFolder: (productRef: number, folder: string, exe: string): Promise<Product | null> =>
      ipcRenderer.invoke('install:useFolder', productRef, folder, exe),
    pickFolder: (): Promise<InstallAnalysis | null> => ipcRenderer.invoke('install:pickFolder'),
    pickExe: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('install:pickExe', defaultPath),
    folderCandidates: (folder: string): Promise<InstallAnalysis | null> =>
      ipcRenderer.invoke('install:folderCandidates', folder),
    linkInstalled: (productRef: number, folder: string, exe: string): Promise<Product | null> =>
      ipcRenderer.invoke('install:linkInstalled', productRef, folder, exe),
    programs: (productRef: number): Promise<InstalledProgram[]> => ipcRenderer.invoke('install:programs', productRef),
    programExes: (program: InstalledProgram): Promise<{ folder: string | null; executables: string[] }> =>
      ipcRenderer.invoke('install:programExes', program),
    linkExisting: (productRef: number, program: InstalledProgram, exe: string | null): Promise<Product | null> =>
      ipcRenderer.invoke('install:linkExisting', productRef, program, exe),
    unlink: (productRef: number): Promise<Product | null> => ipcRenderer.invoke('install:unlink', productRef),
    launch: (productRef: number): Promise<Product | null> => ipcRenderer.invoke('install:launch', productRef),
    /** DMM GAMES PLAYER が入っているか・入っているゲーム（作品に近い順） */
    dgpStatus: (productRef: number): Promise<DgpStatus> => ipcRenderer.invoke('install:dgpStatus', productRef),
    linkDgp: (productRef: number, dgpProductId: string): Promise<Product | null> =>
      ipcRenderer.invoke('install:linkDgp', productRef, dgpProductId),
    openDgp: (): Promise<void> => ipcRenderer.invoke('install:openDgp'),
    /** DMM GAMES PLAYER が要る作品の数と、DMM GAMES PLAYER の有無 */
    dgpSummary: (): Promise<DgpSummary> => ipcRenderer.invoke('install:dgpSummary'),
    /** 紐付けの候補を探し直す。@returns 候補のある作品数 */
    refreshCandidates: (): Promise<number> => ipcRenderer.invoke('install:refreshCandidates'),
    /** 紐付けが生きているかを確かめ直す（変わっていれば更新後の作品、変わらなければ null） */
    checkLink: (productRef: number): Promise<Product | null> => ipcRenderer.invoke('install:checkLink', productRef)
  },

  /** 中身を見た（内蔵ビューア・プレイヤー・NeeView）。「最近見た順」に使う */
  markViewed: (productRef: number): Promise<void> => ipcRenderer.invoke('library:markViewed', productRef),

  /** 手元のファイル */
  files: (id: number): Promise<{ files: LocalFile[]; downloadable: number }> =>
    ipcRenderer.invoke('library:files2', id),

  /** 台帳から外す（ファイルは消さない） */
  removeFile: (productRef: number, filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('library:removeFile', productRef, filePath),
  /** 手元のファイルをごみ箱へ入れて台帳から外す（paths を省くとその作品のファイルをすべて） */
  trashFiles: (productRef: number, paths?: string[]): Promise<TrashResult> =>
    ipcRenderer.invoke('library:trashFiles', productRef, paths),
  trashPlan: (ids: number[]): Promise<TrashPlan> => ipcRenderer.invoke('library:trashPlan', ids),
  trashMany: (ids: number[]): Promise<TrashResult> => ipcRenderer.invoke('library:trashMany', ids),

  showInFolder: (filePath: string): Promise<void> =>
    ipcRenderer.invoke('shell:showInFolder', filePath),
  openPath: (filePath: string): Promise<string> => ipcRenderer.invoke('shell:openPath', filePath),

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  /** 作品の「ブラウザで読む・遊ぶ」をアプリ内の窓で開く（external: 外部ブラウザで開く） */
  browser: {
    open: (productRef: number, url: string, external?: boolean): Promise<{ inApp: boolean; reason: null }> =>
      ipcRenderer.invoke('browser:open', productRef, url, external)
  },

  on: {
    syncProgress: (cb: (p: SyncProgress) => void): (() => void) => subscribe('sync:progress', cb),
    authChanged: (cb: (p: { siteId: string; loggedIn: boolean }) => void): (() => void) =>
      subscribe('auth:changed', cb),
    coversProgress: (cb: (p: { done: number }) => void): (() => void) =>
      subscribe('covers:progress', cb),
    metaProgress: (cb: (p: MetaStatus) => void): (() => void) => subscribe('meta:progress', cb),
    downloadProgress: (cb: (rows: DownloadRow[]) => void): (() => void) =>
      subscribe('download:progress', cb),
    importProgress: (cb: (p: { message: string }) => void): (() => void) =>
      subscribe('import:progress', cb),
    jobsProgress: (cb: (rows: JobRow[]) => void): (() => void) => subscribe('jobs:progress', cb),
    toolsProgress: (cb: (p: ToolInstallProgress) => void): (() => void) => subscribe('tools:progress', cb),
    contentUpdated: (cb: (p: { productRef: number }) => void): (() => void) => subscribe('content:updated', cb),
    refreshProgress: (cb: (p: RefreshProgress) => void): (() => void) => subscribe('library:refreshProgress', cb),
    /** 展開・ダウンロード・変換で、作品の手元のファイルが変わった */
    filesChanged: (cb: (p: { productRef: number | null }) => void): (() => void) =>
      subscribe('library:filesChanged', cb),
    /** 紐付け・起動などで、作品の状態（未インストールの件数・最近起動した順）が変わった */
    libraryChanged: (cb: (p: { productRef: number | null }) => void): (() => void) => subscribe('library:changed', cb),
    playlistsChanged: (cb: (p: { playlists: Playlist[] }) => void): (() => void) => subscribe('playlists:changed', cb),
    /** 総集編の収録作品を読み取り直した・手で直した */
    compilationsChanged: (cb: (p: { count: number | null }) => void): (() => void) =>
      subscribe('library:compilationsChanged', cb)
  }
};

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', api);

export type AppApi = typeof api;
