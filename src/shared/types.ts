/** サイト横断の共通モデル。DMM以外を足す場合もこの型に正規化する。 */

export type SiteId = 'dmm' | 'dlsite';

/**
 * 作品の区分。サイトをまたいで同じ物差しで並べたいので、DMMの分け方に揃えてある。
 * どのサイトで買ったかは siteId 側で持つ（区分とは別の軸）。
 */
export type Category = 'game' | 'doujin' | 'book' | 'video' | 'other';

/**
 * 作品の種別。区分（どこで売っているか）とは別に「何の作品か」を表す。
 * 同人はマンガもCGもボイスもゲームも同じ区分に入るので、これが無いと絞り込めない。
 * サイトごとの呼び方の違い（DMM「コミック」/ DLsite「マンガ」）はここで吸収する。
 */
export type WorkType = 'manga' | 'cg' | 'voice' | 'video' | 'game' | 'novel' | 'music' | 'tool' | 'other';

export const WORK_TYPE_LABELS: Record<WorkType, string> = {
  manga: 'マンガ・コミック',
  cg: 'CG・イラスト',
  voice: 'ボイス・ASMR',
  video: '動画',
  game: 'ゲーム',
  novel: '小説・ノベル',
  music: '音楽',
  tool: 'ツール',
  other: 'その他'
};

export const CATEGORY_LABELS: Record<Category, string> = {
  game: 'PCゲーム',
  doujin: '同人',
  book: '電子書籍',
  video: '動画',
  other: 'その他'
};

/** 取り込み単位。DMMでは「フロア」に相当する。 */
export interface FloorInfo {
  /** 例: 'dmm:dlsoft' */
  key: string;
  siteId: SiteId;
  floorId: string;
  /** UI表示名 例: 'PCゲーム' */
  label: string;
  /** ログイン後にこのフロアの同期が可能か（未ログイン時は false） */
  enabled: boolean;
}

export interface Product {
  id: number;
  siteId: SiteId;
  floorId: string;
  /** サイト横断の区分 */
  category: Category;
  /** 作品の種別（マンガ / CG / ボイス / ゲーム…）。判定できなければ null */
  workType: WorkType | null;
  /** お気に入りに入れた時刻。未登録なら null */
  favoriteAt: number | null;
  /** 手元にファイルがあるか（local_files に実体がある） */
  hasLocalFile: boolean;
  /** 最後に中身を見た日時（内蔵ビューア・プレイヤー・NeeView） */
  viewedAt: number | null;
  /** 手元にあるゲーム・ツールで、起動の紐付け（インストール）が済んでいない */
  needsInstall: boolean;
  /** 総集編・セットとして収録作品を読み取れた（ストアでセット商品になっていない作品を含む） */
  isCompilation: boolean;
  /** 起動の紐付けができそうな相手（まだ紐付けていない作品だけ） */
  linkCandidate: LinkCandidate | null;
  productId: string;
  contentId: string | null;
  title: string;
  maker: string | null;
  makerId: string | null;
  authors: string[];
  genre: string | null;
  productType: string | null;
  /** 'YYYY-MM-DD' または 'YYYY-MM-DD HH:mm'。不明な場合 null */
  purchasedAt: string | null;
  /**
   * purchasedAt の出所。'order' は実際の購入/注文日、'delivery' は作品の配信開始日で
   * 購入日の代わりに置いている暫定値（PCゲームは一覧APIに注文日が無い）。
   */
  purchasedAtSource: 'order' | 'delivery' | null;
  /** 作品の発売/配信開始日。購入日とは別軸で並べ替えられる */
  releasedAt: string | null;
  /** 作品説明。取得できないフロアでは null */
  description: string | null;
  /** 作者・ブランド・出演者などを役割付きで持つ */
  creators: Creator[];
  /** セット商品に収録されている単品のとき、親セットの productId */
  parentProductId: string | null;
  /**
   * 作品メタ（詳細API＋店舗ページ）を取得した時刻。
   * 作品ページの内容は基本的に変わらないので、入っていれば再取得しない。
   */
  metaFetchedAt: number | null;
  /**
   * ダウンロード/視聴などの操作リンク。詳細取得時に保存するので、
   * 2回目以降（通信しないとき）もボタンを出せる。
   */
  links: ProductLink[];
  /** ライセンスキー/シリアルコード。必要な作品にだけ入る */
  serialKey: string | null;
  /** 電子書籍のシリーズ内の所持巻。詳細を開いたときに取る */
  volumes: VolumeSet | null;
  /** 購入価格の表示文字列（"1,650円" など） */
  priceText: string | null;
  coverUrl: string | null;
  /** ローカルキャッシュ済み表紙の app:// URL。未取得なら null */
  coverPath: string | null;
  detailUrl: string | null;
  fileSizeText: string | null;
  fileSizeBytes: number | null;
  isDownloadable: boolean;
  isStreaming: boolean;
  isUnavailable: boolean;
  hasDrm: boolean;
  tags: string[];
  firstSeenAt: number;
  lastSyncedAt: number;
  /** インストール紐付け（Phase 2）。未紐付けなら null */
  installation: Installation | null;
}

/** シリーズ内の1巻ぶん */
export interface ProductVolume {
  contentId: string;
  /** 「第2話」なら 2。取れなければ null */
  volumeNumber: number | null;
  title: string;
  /** 配信日 'YYYY-MM-DD' */
  publishedAt: string | null;
  coverUrl: string | null;
  /** ブラウザビューアで読むURL */
  streamingUrl: string | null;
  /** 端末にダウンロードするURL。無い作品もある */
  downloadUrl: string | null;
}

/** シリーズ内の所持巻。全何巻のうち何巻持っているかが分かるように総数も持つ */
export interface VolumeSet {
  totalCount: number | null;
  owned: ProductVolume[];
}

/** 作品に対して実行できる操作のリンク。詳細取得時に確定し、DBに保存する */
export interface ProductLink {
  /** ボタンに出す文言 */
  label: string;
  url: string;
  /** 'download' = 保存 / 'stream' = ブラウザで読む・見る / 'play' = 起動 / 'page' = 案内ページ */
  kind: 'download' | 'stream' | 'play' | 'page';
  /** 動画のダウンロードの画質（画質の印・サイトの呼び名・容量・並び・パート）。容量は全パートの合計を 1 パート目にだけ持つ */
  quality?: { key: string; name: string | null; sizeMb: number | null; order: number; part: number };
  /** 動画のストリーミングで、4K 作品の H.264 版のプレイヤー */
  codec?: 'h264';
}

export interface Creator {
  /** '著者' / 'ブランド' / '出演' / '監督' / 'サークル' など */
  role: string;
  name: string;
  /** サイト内のID。無ければ null */
  id: string | null;
}

/** dmm_game_player: DMM GAMES PLAYER に入っているゲームと紐付けた（起動は DMM GAMES PLAYER に頼む） */
export type InstallKind = 'linked_existing' | 'managed' | 'dmm_game_player';

/** DMM GAMES PLAYER に入っているゲーム（%APPDATA%/dmmgameplayer5/dmmgame.cnf の contents） */
export interface DgpGame {
  productId: string;
  /** GCL / ACL（クライアントゲーム）、GMAIN / AMAIN（PCゲーム）など */
  gameType: string;
  path: string | null;
  version: string | null;
  installed: boolean;
  /** 作品名との近さ（0..1）。候補を並べるためだけに使う */
  score: number;
}

export interface DgpStatus {
  /** DMMGamePlayer.exe が見つかり、dmmgameplayer:// が登録されている */
  installed: boolean;
  exe: string | null;
  games: DgpGame[];
  /** 読めなかった理由など */
  message: string | null;
}
export type InstallState = 'not_installed' | 'installed' | 'downloading' | 'installing' | 'broken';

/**
 * 手元の状態。have: ダウンロード済み（ファイルがある、または起動の紐付けが済んでいる） /
 * installed: 起動の紐付けが済んでいる / notInstalled: ファイルはあるが紐付けがまだ（候補の無いもの） /
 * linkable: 紐付けの候補がある / broken: 紐付け先（起動ファイル・DMM GAMES PLAYER のゲーム）が見つからない / none: 未取得
 */
export type LocalState = 'have' | 'none' | 'installed' | 'notInstalled' | 'linkable' | 'broken';

/** 起動の紐付けができそうな相手。dgp: DMM GAMES PLAYER のゲーム / program: 導入済みプログラム */
export interface LinkCandidate {
  kind: 'dgp' | 'program';
  name: string;
  score: number;
}

/** 総集編の画面に出す作品の要点 */
export interface ProductBrief {
  id: number;
  siteId: SiteId;
  title: string;
  maker: string | null;
}

/** 収録作品として見つけた、同じサイトの作品（未購入を含む） */
export interface CompilationMatchRef {
  productId: string;
  title: string;
  url: string | null;
  /** タイトルの近さ。手で選んだものは null */
  score: number | null;
}

/** 収録作品として見つけた作品と、それを持っているか */
export interface CompilationMatchView extends CompilationMatchRef {
  /** 手元にある同じ作品（単独で買ったもの、またはセットの中身として一覧にあるもの）。無ければ null */
  owned: ProductBrief | null;
  /** single: 単独で購入済み / set: セットの中身として持っている / null: 単独では未購入 */
  ownedVia: 'single' | 'set' | null;
  /** この作品を収録している、ほかに持っている総集編・セット */
  alsoIn: ProductBrief[];
}

/** 総集編の収録作品 1 つ */
export interface CompilationEntryView {
  position: number;
  title: string;
  matches: CompilationMatchView[];
  /** 手で選び直したか */
  manual: boolean;
}

/** 収録作品を探したサークルの作品一覧 */
export interface CatalogStatus {
  store: string;
  makerId: string;
  fetchedAt: number | null;
  count: number;
  error: string | null;
}

/** 作品の総集編まわり。entries: この作品が総集編なら収録作品 / containedIn: この作品を収録している、持っている総集編 */
export interface CompilationInfo {
  entries: CompilationEntryView[];
  containedIn: ProductBrief[];
  /** 収録作品を探した作品一覧。一覧の無いサイト・区分なら null（手元の作品から探す） */
  catalog: CatalogStatus | null;
}

/** 手で選び直すときの候補 */
export interface CompilationCandidate extends CompilationMatchRef {
  owned: boolean;
}

/** 収録作品の結び付けを手で直す。set: 選んだ作品にする / none: 外す / clear: 手で直したぶんを戻す */
export type CompilationOverrideAction = 'set' | 'none' | 'clear';

/** DMM GAMES PLAYER が要る作品と、DMM GAMES PLAYER の有無 */
export interface DgpSummary {
  installed: boolean;
  exe: string | null;
  /** 「DMM GAMES PLAYER専用」の作品の数 */
  dgpOnly: number;
  /** そのうち紐付け済みの数 */
  linked: number;
}

export interface Installation {
  id: number;
  productRef: number;
  kind: InstallKind;
  installPath: string | null;
  executablePath: string | null;
  /** Windows の Uninstall レジストリキー。既存の導入済みプログラムと紐付けた場合に入る */
  uninstallKey: string | null;
  displayName: string | null;
  version: string | null;
  state: InstallState;
  linkedAt: number;
  lastLaunchedAt: number | null;
  notes: string | null;
}

/** used: 最近使った順（起動した日時と、中身を見た日時の新しい方） */
export type SortKey = 'purchased' | 'released' | 'title' | 'maker' | 'used';
export type SortDir = 'asc' | 'desc';

export interface LibraryQuery {
  /** 'dmm:dlsoft' など。空配列なら全フロア */
  floors?: string[];
  /** 区分での絞り込み。空配列なら全区分 */
  categories?: Category[];
  /** 購入サイトでの絞り込み。空配列なら全サイト */
  siteIds?: string[];
  search?: string;
  /** search を正規表現として扱う（大文字小文字は区別しない） */
  useRegex?: boolean;
  /** ブランド/サークルでの絞り込み。複数指定はOR（どれかに一致する作品） */
  makers?: string[];
  /** 作品の種別での絞り込み。複数指定はOR */
  workTypes?: WorkType[];
  /**
   * 人・シリーズでの絞り込み（作者・原画・シナリオ・声優・シリーズなど）。
   * 役割は問わず名前で一致させる。複数指定はAND（全員が関わっている作品）。
   */
  creators?: string[];
  /** 検索の対象。既定はタイトルとブランド */
  searchFields?: SearchField[];
  /** お気に入りだけに絞る */
  favoriteOnly?: boolean;
  /** 手元の状態での絞り込み。'have' = ダウンロード済み / 'none' = 未取得 */
  /** have: 手元にある / none: 未取得 / notInstalled: 手元にあるが、起動の紐付けが済んでいないゲーム */
  localState?: LocalState;
  /** タグでの絞り込み。複数指定はAND（すべて持つ作品だけ） */
  tags?: string[];
  installedOnly?: boolean;
  /** 並べ替えの基準 */
  sortKey?: SortKey;
  /** 並べ替えの向き */
  sortDir?: SortDir;
  /** セット商品の本体（収録単品ではない側）を一覧から隠す */
  hideSetParents?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * ブランド/サークル一覧の絞り込み条件。
 * 一覧側の絞り込み（区分・購入サイト・タグ）と連動させるため、同じ条件を渡す。
 * makers 自身は含めない（選択中の候補が消えて選び直せなくなるため）。
 */
export type MakerFilter = Pick<
  LibraryQuery,
  'floors' | 'categories' | 'siteIds' | 'tags' | 'workTypes' | 'creators'
>;

/**
 * タグ一覧の絞り込み条件。選択済みのタグとブランドも渡すので、
 * 絞り込むほど「その中で共起するタグ」だけが残る。
 */
export type TagFilter = MakerFilter & { makers?: string[] };

/** 種別ごとの件数。絞り込みの他の条件に連動する */
export type WorkTypeFilter = TagFilter;

/** 検索の対象にできる項目 */
export type SearchField = 'title' | 'maker' | 'description' | 'productId' | 'creators';

export const SEARCH_FIELD_LABELS: Record<SearchField, string> = {
  title: 'タイトル',
  maker: 'ブランド',
  description: '説明文',
  productId: '作品ID',
  creators: '人・シリーズ'
};

export interface LibraryPage {
  items: Product[];
  total: number;
  /** 正規表現が不正だったときの理由。正常なら null */
  regexError?: string | null;
}

export interface FloorCount {
  floorKey: string;
  count: number;
}

/** 本体とは別にログインが要るサービス（FANZA動画・一般向けの DMM ブックス）のうち、未ログインのもの */
export interface ServiceWarning {
  uncertain?: boolean;
  siteId: SiteId;
  service: string;
  /** 設定画面の行の見出し */
  label: string;
  /** 警告の文 */
  text: string;
}

export interface LoginStatus {
  siteId: SiteId;
  loggedIn: boolean;
  /**
   * サービス個別のログイン状態。本体にログイン済みでも別途ログインが要るものだけ入る
   * （現状はFANZA動画）。本体が未ログインのときは判定しないので空になる。
   */
  services?: Record<string, boolean | null>;
  /** 判定に失敗した場合の理由 */
  message: string | null;
  /**
   * 判定そのものに失敗した（＝ログアウトしたのか通信に失敗したのか分からない）。
   * このとき loggedIn は「最後に分かっていた値」で、確定値ではない。
   */
  uncertain: boolean;
  checkedAt: number;
}

export type SyncPhase = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

export interface SyncProgress {
  runId: number;
  phase: SyncPhase;
  floorKey: string | null;
  floorLabel: string | null;
  /** 取得済み件数 / 総件数（総件数不明なら null） */
  fetched: number;
  total: number | null;
  added: number;
  updated: number;
  message: string | null;
  error: string | null;
}

export interface SyncResultSummary {
  runId: number;
  status?: 'done' | 'partial' | 'error' | 'cancelled';
  floors: Array<{ floorKey: string; fetched: number; added: number; updated: number; error: string | null }>;
}

export interface SyncHistoryEntry extends SyncResultSummary {
  startedAt: number;
  finishedAt: number | null;
}

/** 作品メタの裏取得の状態 */
export interface MetaStatus {
  enabled: boolean;
  /** 1件取り終えてから次までの待ち時間（ミリ秒） */
  intervalMs: number;
  /** 同時に取りに行く本数 */
  concurrency: number;
  /** 未取得のうち、いま取りに行ける件数 */
  pending: number;
  /** 未ログインのサイトにあって、いまは取りに行けない件数 */
  blocked: number;
  /** 直近に取得した作品名 */
  lastTitle: string | null;
  running: boolean;
  /** 止まっている理由（同期中・未ログインなど） */
  pausedReason: string | null;
  /** 残りを取り切るまでのおよその秒数（実測の速度から算出） */
  etaSeconds: number | null;
}

/** 保存済みのログイン情報の要約。パスワードそのものは含めない */
export interface CredentialSummary {
  siteId: string;
  loginId: string | null;
  hasPassword: boolean;
  updatedAt: number | null;
  /** 保存はされているが復号できなかった（再入力が必要） */
  unreadable?: boolean;
}

/** ダウンロードの状態 */
export type DownloadState = 'queued' | 'running' | 'paused' | 'done' | 'error' | 'canceled';

/** ダウンロードのキュー1行。1行 = 1ファイル */
export interface DownloadRow {
  id: number;
  productRef: number;
  /** 作品名（表示用。products から引いたもの） */
  title: string;
  siteId: string;
  label: string;
  linkKind: string;
  linkIndex: number;
  state: DownloadState;
  savePath: string | null;
  totalBytes: number | null;
  receivedBytes: number;
  /** 続きから取るときの検証に使う */
  etag: string | null;
  lastModified: string | null;
  attempts: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  /** 作品全体のファイルサイズ（大きさがまだ分からない行の見込みに使う） */
  productBytes: number | null;
  // ── 以下は実行中の様子（DB には無い。一覧を返すときに足す） ──
  /** いまの速さ（バイト/秒） */
  bytesPerSec?: number;
  /** 待機のうち、URL を取り直すなど始める準備をしているもの */
  preparing?: boolean;
  /** 今回のまとまり（キューが空の状態から積んだぶん）に入っているか。件数の進み具合に使う */
  inBatch?: boolean;
}

/** 手元のファイルをごみ箱へ入れた結果 */
export interface TrashResult {
  products: number;
  removed: number;
  bytes: number;
  failed: Array<{ path: string; error: string }>;
}

/** まとめて削除する前の見積もり */
export interface TrashPlan {
  products: number;
  files: number;
  bytes: number;
  /** ダウンロード中・処理中なので外すもの */
  busy: number;
  /** インストール先のフォルダも消えるもの（紐付けを外す） */
  installed: number;
}

/** 手元にあるファイル1件 */
export interface LocalFile {
  id: number;
  productRef: number | null;
  path: string;
  sizeBytes: number | null;
  kind: string | null;
  source: string;
  addedAt: number;
  missingAt: number | null;
  /** 展開してできたフォルダなら、元のアーカイブのパス */
  derivedFrom: string | null;
}

/** 保存先まわりの設定 */
export interface DownloadSettings {
  root: string;
  template: string;
  concurrency: number;
  /** 帯域制限（バイト/秒）。0 なら制限なし */
  maxBytesPerSec: number;
  /** 動画をダウンロードするときの画質の既定（'best'・'h:1080' など。shared/videoQuality.ts） */
  videoQuality: string;
}

/** ダウンロードのあとの処理（展開・FLAC変換）の設定 */
export interface PostProcessSettings {
  /** ゲーム・ツール（展開して使うもの）はダウンロードが終わったら展開する */
  autoExtract: boolean;
  /** 展開して使うものは、展開が済んだらアーカイブを消す（既定: 消す） */
  deleteArchiveAfterExtract: boolean;
  /** 展開したあと、WAV を FLAC にする */
  autoFlac: boolean;
  /** MP3 などが同梱されているボイス作品は、WAV / FLAC を消して MP3 などだけ残す（既定: しない） */
  lossyOnly: boolean;
  /** 画像と同じ内容の PDF（スマホ向けなど）を、ダウンロード後に消して zip を作り直す種別（同人の CG・マンガだけ。既定: なし） */
  stripPdfTypes: PdfStripType[];
  /** 圧縮したまま持つ種別ごとの、ダウンロード後の扱い（既定: すべて圧縮のまま） */
  archiveHandling: Record<ArchiveWorkType, ArchiveHandling>;
  /** 自動変換の対象にする WAV の合計サイズの下限（バイト） */
  flacMinBytes: number;
  /** 変換したあとの元の WAV */
  flacOriginal: FlacOriginal;
  /** 7-Zip（7z.exe）の場所。空なら自動で探す */
  sevenZipPath: string;
  /** ffmpeg の場所。空なら自動で探す */
  ffmpegPath: string;
  /** NeeView の場所。空なら自動で探す */
  neeviewPath?: string;
}

export type FlacOriginal = 'trash' | 'delete' | 'keep';

/** 画像と同じ内容の PDF を消せる種別（同人のもの） */
export type PdfStripType = 'cg' | 'manga';
export const PDF_STRIP_TYPES: PdfStripType[] = ['cg', 'manga'];

/** 圧縮したまま持つ種別（ゲーム・ツールは展開して使うので入らない）。種別が分からない作品は other */
export type ArchiveWorkType = 'manga' | 'cg' | 'voice' | 'music' | 'video' | 'novel' | 'other';
export const ARCHIVE_WORK_TYPES: ArchiveWorkType[] = ['manga', 'cg', 'voice', 'music', 'video', 'novel', 'other'];

/** archive: 圧縮したまま / extract: 展開して使う（zip は残す） / extractDelete: 展開して使い、zip は消す */
export type ArchiveHandling = 'archive' | 'extract' | 'extractDelete';

/** ツールをどこから見つけたか */
export type ToolSource = 'configured' | 'bundled' | 'system' | null;

export type ToolName = 'sevenZip' | 'ffmpeg' | 'neeview';

/** 外部ツールが見つかったか */
export interface ToolStatus {
  sevenZip: string | null;
  ffmpeg: string | null;
  ffprobe: string | null;
  neeview: string | null;
  sources: Record<ToolName, ToolSource>;
  /** 設定画面から入れたツールの置き場所 */
  toolsDir: string | null;
}

/** 設定画面からのツールの取得状況 */
export interface ToolInstallProgress {
  tool: ToolName;
  phase: 'resolving' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'error';
  receivedBytes: number;
  totalBytes: number | null;
  message: string;
  version?: string;
}

/** 入れたツールの記録（tools/<name>/installed.json） */
export interface InstalledToolInfo {
  tool: ToolName;
  version: string;
  source: string;
  sha256: string;
  installedAt: number;
}

/** lossy: MP3 などがある WAV / FLAC を消して軽くする */
export type JobKind = 'extract' | 'flac' | 'move' | 'lossy' | 'pdf';
export type JobState = 'queued' | 'running' | 'done' | 'error' | 'canceled';

/** 展開・FLAC変換のキュー1行 */
export interface JobRow {
  id: number;
  productRef: number | null;
  title: string | null;
  kind: JobKind;
  source: string;
  target: string | null;
  state: JobState;
  progress: number;
  message: string | null;
  error: string | null;
  result: JobResult | null;
  auto: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface JobResult {
  /** FLAC: 変換した数 / 飛ばした数 / 変換前後の合計サイズ */
  converted?: number;
  skipped?: Array<{ path: string; reason: string }>;
  beforeBytes?: number;
  afterBytes?: number;
  /** 展開: できたフォルダと、その中のファイル数 */
  folder?: string;
  files?: number;
  /** MP3 だけ残す: 消した WAV / FLAC の数 */
  removed?: number;
  /** 展開: 消したアーカイブ */
  deletedArchives?: string[];
  /** FLAC（アーカイブ）: 作り直した zip */
  archive?: string;
  /** 移動: 移した件数（移せなかったものは skipped） */
  moved?: number;
}

/** FLAC 変換の見積もり */
export interface FlacEstimate {
  files: number;
  bytes: number;
  /** 圧縮後のおよそのサイズ（実測の傾向から 55% で見積もる） */
  estimatedBytes: number;
}

/** 作品の中身の1ファイル（フォルダ内でもアーカイブ内でもよい） */
export interface ContentEntry {
  /** 読み出し用のURL（mylib://） */
  url: string;
  /** 作品フォルダ（またはアーカイブ）からの相対パス。区切りは '/' */
  relPath: string;
  name: string;
  size: number;
  /** 置き場所（フォルダかアーカイブ）の実パス */
  container: string;
  /** container がアーカイブか */
  inArchive: boolean;
}

/** 音声のグループ（1フォルダ = 1グループ） */
export interface AudioGroup {
  /** フォルダの相対パス（ルートは ''） */
  folder: string;
  /** 表示名。フォルダ名から推定した版のラベルを含む */
  label: string;
  /** SEあり/なし・特典などの推定 */
  tags: string[];
  tracks: ContentEntry[];
}

/** 作品の中身の見取り図 */
export interface ContentIndex {
  productRef: number;
  /** 展開済みフォルダ・アーカイブ・単体ファイル */
  sources: Array<{ path: string; kind: 'folder' | 'archive' | 'file'; error?: string }>;
  audioGroups: AudioGroup[];
  /** 台本・読み物（pdf / txt / html / 台本フォルダの画像） */
  documents: ContentEntry[];
  /** 字幕（.lrc / .vtt / .srt） */
  subtitles: ContentEntry[];
  images: ContentEntry[];
  videos: ContentEntry[];
  /** 書籍（epub など、内蔵では開かないもの） */
  books: ContentEntry[];
  /**
   * MP3 などが同梱されていて消せる WAV / FLAC（置き場所ごと）。
   * container はアーカイブか展開したフォルダの実パス
   */
  lossyOnly: Array<{ container: string; inArchive: boolean; count: number; bytes: number; kept: number }>;
  /** 画像と同じ内容の PDF（スマホ向けなど）を消せるもの。names は消す PDF の名前 */
  pdfStrip: Array<{ container: string; inArchive: boolean; count: number; bytes: number; names: string[] }>;
  /** WAV の合計（FLAC 変換の判断用） */
  wavBytes: number;
  wavCount: number;
  /** アーカイブの中の音声がある（展開せずに再生する。初回はキャッシュに書き出すことがある） */
  audioOnlyInArchive: boolean;
  /** アーカイブごとの中身の概要 */
  archives: ArchiveSummary[];
  /** この作品を展開して使うか、圧縮のまま持つか */
  storage: { mode: 'extract' | 'archive'; reason: string } | null;
}

export interface ArchiveSummary {
  path: string;
  files: number;
  uncompressedBytes: number;
  wavCount: number;
  wavBytes: number;
  hasExecutable: boolean;
  /** 自前の zip 読み取りで読めた（7-Zip を使わない） */
  native: boolean;
  /** 無圧縮で入っているファイル数（Range でそのまま読める） */
  storedMedia: number;
}

/** 展開したフォルダの中身から見た、ゲームの型（DESIGN-download.md §8） */
export type InstallType = 'installer' | 'installer_with_files' | 'portable' | 'patch' | 'unknown';

export interface InstallAnalysis {
  folder: string;
  type: InstallType;
  /** 判定の理由（画面に出す） */
  reasons: string[];
  installers: Array<{ path: string; size: number }>;
  /** 本体exeの候補（見込みの高い順） */
  executables: Array<{ path: string; size: number; depth: number }>;
  /** ブラウザで遊ぶ作品の入口（index.html） */
  htmlEntries: string[];
  readmes: string[];
}

/** Windows の「プログラムと機能」に出ている導入済みソフト */
export interface InstalledProgram {
  key: string;
  displayName: string;
  publisher: string | null;
  installLocation: string | null;
  displayIcon: string | null;
  version: string | null;
  /** タイトルとの近さ（0..1） */
  score: number;
}

/** まとめてキューに入れる前の見積もり */
export interface EnqueueEstimate {
  /** 対象になる作品数（取得済みを除いたもの） */
  products: number;
  /** 落とすファイル数 */
  files: number;
  /** 分かっているぶんの合計バイト数 */
  bytes: number;
  /** サイズが分からない作品の数 */
  unknown: number;
  /** 保存先の空き容量 */
  freeBytes: number | null;
  /** 空きが足りないか */
  short: boolean;
}

/** 取り込みで見つかったファイル1件 */
export interface ScanFile {
  path: string;
  sizeBytes: number;
}

/** 同じフォルダにあって候補も同じファイルのまとまり（同じ作品の一部とみなす） */
export interface ScanGroup {
  /** まとめた親フォルダ（絶対パス） */
  dir: string;
  /** 画面に出すフォルダ名 */
  label: string;
  files: ScanFile[];
  /** 合計バイト数 */
  sizeBytes: number;
  candidates: Array<{ productId: number; title: string; confidence: string; reason: string }>;
}

/** 取り込みの結果 */
export interface ScanResult {
  scanned: number;
  /** 作品IDで自動確定した数 */
  linked: number;
  /** すでに台帳にあって飛ばした数 */
  skipped: number;
  /** ユーザーの判断が要るもの。フォルダごとにまとめてある */
  pending: ScanGroup[];
}

/** 保存先・フォルダ構成を変えたときの移動の1件 */
export interface RelocationItem {
  productRef: number;
  title: string;
  from: string;
  to: string;
  bytes: number;
  kind: 'file' | 'folder';
  /** 別のドライブへの移動（複製になるので時間がかかる） */
  crossDevice: boolean;
}

export interface RelocationPlan {
  root: string;
  template: string;
  items: RelocationItem[];
  totalBytes: number;
  crossDeviceBytes: number;
  skipped: Array<{ path: string; reason: string }>;
}

/** 手元の状態をまとめて最新にするときの進みぐあい */
export interface RefreshProgress {
  phase: 'scan' | 'index' | 'done';
  done: number;
  total: number;
  message: string;
}
