# データモデル

## データの置き場所

| 場所 | 内容 |
|---|---|
| `%APPDATA%\simaeru\library.db`（`-wal`・`-shm`） | データベース（SQLite、WAL） |
| `%APPDATA%\simaeru\library.db.corrupt-<日時>` | 破損していたデータベースの退避先 |
| `%APPDATA%\simaeru\credentials.dpapi` | 保存した ID/パスワードの控え（DPAPI で暗号化） |
| `%APPDATA%\simaeru\covers\` | 表紙のキャッシュ |
| `%APPDATA%\simaeru\tools\7zip\`・`ffmpeg\`・`NeeView\` | アプリが取得した外部ツール。各フォルダに `installed.json` |
| `%APPDATA%\simaeru\tools\NeeView\Profile\UserSetting.json` | アプリが取得した NeeView の設定 |
| `%APPDATA%\simaeru\Partitions\` | サイトごとのセッション |
| `%TEMP%\Simaeru-cache\` | アーカイブの中の音声・動画の一時書き出し（上限 3 GB） |
| `%TEMP%\Simaeru-work\job-<id>\` | 後処理の作業フォルダ |
| ダウンロードの保存先 | 設定 `download.root`（既定 `ドキュメント\Simaeru`） |

`simaeru` は `APP_ID`（`src/shared/appInfo.ts`）です。

## データベース

- 版は `PRAGMA user_version`。現在 **28**。移行は `src/main/db/schema.ts` の `MIGRATIONS` を順に適用する前方移行だけです。
- 外部キーは有効（`PRAGMA foreign_keys = ON`）。
- 真偽値は `INTEGER`（0 / 1）、配列・構造は JSON の `TEXT` です。

### products — 作品

| 列 | 型 | 内容 |
|---|---|---|
| `id` | INTEGER PK | |
| `site_id` | TEXT NOT NULL | 購入サイト（`dmm`・`dlsite`） |
| `floor_id` | TEXT NOT NULL | サイト内の区画（`dlsoft`・`doujin`・`book`・`video`・`library`） |
| `product_id` | TEXT NOT NULL | サイトの作品 ID |
| `content_id` | TEXT | サイトのコンテンツ ID（区画によって作品 ID と異なる） |
| `title` | TEXT NOT NULL | タイトル |
| `maker` / `maker_id` | TEXT | ブランド・サークルと、その ID |
| `authors` | TEXT NOT NULL `'[]'` | 作者名の配列（JSON） |
| `genre` | TEXT | サイトのジャンル表記 |
| `product_type` | TEXT | 商品の形態（`set` = セット商品 など） |
| `category` | TEXT | 区分（`game`・`doujin`・`book`・`video`・`other`） |
| `work_type` | TEXT | 種別（`manga`・`cg`・`voice`・`video`・`game`・`novel`・`music`・`tool`・`other`、不明は NULL） |
| `purchased_at` | TEXT | 購入日（ISO 8601 形式の日付または日時） |
| `purchased_at_source` | TEXT | 購入日の出どころ（`order` = 注文日、`delivery` = 配信開始日） |
| `released_at` | TEXT | 発売日 |
| `description` | TEXT | 説明文 |
| `creators` | TEXT NOT NULL `'[]'` | クリエイターの配列（JSON、[形](#creator)） |
| `tags` | TEXT NOT NULL `'[]'` | タグの配列（JSON） |
| `parent_product_id` | TEXT | セット商品に収録されている単品のとき、親の作品 ID |
| `links` | TEXT NOT NULL `'[]'` | 操作の導線の配列（JSON、[形](#productlink)） |
| `volumes` | TEXT | 所持巻（JSON、[形](#volumeset)） |
| `serial_key` | TEXT | ライセンスキー |
| `price_text` | TEXT | 購入価格の表示 |
| `cover_url` | TEXT | 表紙の URL |
| `cover_file` | TEXT | 表紙のキャッシュのファイル名（取得失敗は空文字） |
| `detail_url` | TEXT | 作品ページの URL（動画は `https://video.dmm.co.jp/<floor の小文字>/content/?id=<content_id>`） |
| `file_size_text` / `file_size_bytes` | TEXT / INTEGER | ファイルサイズの表示とバイト数 |
| `is_downloadable` / `is_streaming` / `is_unavailable` / `has_drm` | INTEGER NOT NULL 0 | ダウンロード可・ストリーミング可・配信終了・DRM あり |
| `raw_json` | TEXT | 取得した一覧の応答 |
| `meta_fetched_at` | INTEGER | 詳細を取得した時刻 |
| `meta_attempts` | INTEGER NOT NULL 0 | 詳細の取得を試みた回数 |
| `favorite_at` | INTEGER | お気に入りに入れた時刻（NULL = 未登録） |
| `viewed_at` | INTEGER | 最後に中身を開いた時刻（♡「使った」を押した時刻を含む。もう一度押すと NULL）。`LibraryQuery.usedOnly` はこの列で絞り込みます |
| `link_candidate` | TEXT | 紐付け候補（JSON、[形](#linkcandidate)。無ければ NULL） |
| `first_seen_at` / `last_synced_at` | INTEGER NOT NULL | 最初に取り込んだ時刻 / 最後に同期した時刻 |

- 一意: `(site_id, floor_id, product_id)`
- 索引: `category`・`favorite_at`・`(site_id, floor_id)`・`maker`・`(site_id, floor_id, parent_product_id)`・`purchased_at DESC`・`released_at DESC`・`site_id`・`work_type`
- 全文検索: `products_fts`（FTS5、`title`・`maker`・`authors`・`tags`、`tokenize='trigram'`）。`products` の INSERT / UPDATE / DELETE のトリガーで同期します。

### installations — インストール（起動の紐付け）

| 列 | 型 | 内容 |
|---|---|---|
| `id` | INTEGER PK | |
| `product_ref` | INTEGER NOT NULL UNIQUE → products | 作品（1 作品につき 1 行、作品の削除で削除） |
| `kind` | TEXT NOT NULL | `managed`（アプリで紐付け）・`linked_existing`（導入済みプログラム）・`dmm_game_player` |
| `install_path` | TEXT | 導入先のフォルダ |
| `executable_path` | TEXT | 起動するファイル（`dmm_game_player` は NULL） |
| `uninstall_key` | TEXT | 導入済みプログラムのレジストリのキー、または `dgp:<gameType>:<productId>` |
| `display_name` / `version` / `notes` | TEXT | 表示名・版・メモ |
| `state` | TEXT NOT NULL `'not_installed'` | `installed`・`not_installed`・`downloading`・`installing`・`broken` |
| `linked_at` | INTEGER NOT NULL | 紐付けた時刻 |
| `last_launched_at` | INTEGER | 最後に起動した時刻 |

### downloads — ダウンロード（1 行 = 1 ファイル）

| 列 | 型 | 内容 |
|---|---|---|
| `id` | INTEGER PK | |
| `product_ref` | INTEGER NOT NULL → products | 作品（作品の削除で削除） |
| `label` | TEXT NOT NULL | 表示名（日本語で保存し、表示時に翻訳） |
| `link_kind` | TEXT NOT NULL | `main`（1 ファイル）・`split`（分割の 1 つ） |
| `link_index` | INTEGER NOT NULL 0 | 作品のダウンロード導線の中の位置 |
| `state` | TEXT NOT NULL | `queued`・`running`・`paused`・`done`・`error`・`canceled` |
| `save_path` | TEXT | 保存先（保存中は `<save_path>.part`） |
| `total_bytes` / `received_bytes` | INTEGER / INTEGER NOT NULL 0 | 全体の大きさ / 受け取った量 |
| `etag` / `last_modified` / `url_chain` | TEXT | 続きから取るための情報（`url_chain` は JSON 配列） |
| `attempts` | INTEGER NOT NULL 0 | 失敗した回数 |
| `error` | TEXT | 失敗の理由 |
| `created_at` / `updated_at` | INTEGER NOT NULL | |

- 一意: `(product_ref, link_kind, link_index)`
- 索引: `(state, created_at)`・`product_ref`
- ダウンロードの URL は保存しません（実行の直前に作品の詳細から取り直します）。

### local_files — 手元のファイルの台帳

| 列 | 型 | 内容 |
|---|---|---|
| `id` | INTEGER PK | |
| `product_ref` | INTEGER → products | 作品（作品の削除で NULL） |
| `path` | TEXT NOT NULL UNIQUE | ファイルまたはフォルダの絶対パス |
| `size_bytes` | INTEGER | 大きさ（フォルダは中身の合計） |
| `kind` | TEXT | `archive`・`installer`・`book`・`video`・`audio`・`folder`・`other` |
| `source` | TEXT NOT NULL | 出どころ（`download`・`extract`・`flac`・`lossy`・`pdf`・`scan`） |
| `added_at` | INTEGER NOT NULL | 登録した時刻 |
| `missing_at` | INTEGER | 実体が見つからなくなった時刻（見つかれば NULL） |
| `derived_from` | TEXT | 展開してできたフォルダのとき、元のアーカイブのパス |

- 索引: `product_ref`

### playlists / playlist_items — プレイリスト

自分で作る一覧。作品の実体やファイルには触れません。

| 列 | 型 | 内容 |
|---|---|---|
| `id` | INTEGER PK | |
| `name` | TEXT NOT NULL UNIQUE | 名前（同じ名前は作らず、既にあるものを使う） |
| `created_at` / `updated_at` | INTEGER NOT NULL | 作った時刻 / 中身か名前を変えた時刻 |

| 列（`playlist_items`） | 型 | 内容 |
|---|---|---|
| `playlist_ref` | INTEGER → playlists | プレイリスト（削除で一緒に消える） |
| `product_ref` | INTEGER → products | 作品（作品の削除で一緒に消える） |
| `position` | INTEGER NOT NULL | 並び（末尾に足すたび `max(position) + 1`） |
| `added_at` | INTEGER NOT NULL | 入れた時刻 |

- 主キー: `(playlist_ref, product_ref)`（同じ作品は二重に入らない）
- 索引: `(playlist_ref, position)`・`product_ref`
- 一覧の絞り込みは `LibraryQuery.playlistId`、並べ替えの `playlist` はそのプレイリストの `position` 順です。

### jobs — 後処理

| 列 | 型 | 内容 |
|---|---|---|
| `id` | INTEGER PK | |
| `product_ref` | INTEGER → products | 作品（作品の削除で削除。移動のジョブは NULL） |
| `kind` | TEXT NOT NULL | `extract`・`flac`・`lossy`・`pdf`・`move` |
| `source` / `target` | TEXT NOT NULL / TEXT | 対象 / 出力先 |
| `state` | TEXT NOT NULL | `queued`・`running`・`done`・`error`・`canceled` |
| `progress` | REAL NOT NULL 0 | 0〜1 |
| `message` / `error` | TEXT | 状況の文 / 失敗の理由 |
| `result` | TEXT | 結果（JSON、[形](#jobresult)） |
| `auto` | INTEGER NOT NULL 0 | ダウンロード後に自動で積んだもの |
| `options` | TEXT | 実行の条件（JSON、[形](#joboptions)） |
| `created_at` / `updated_at` | INTEGER NOT NULL | |

- 索引: `(state, created_at)`・`product_ref`

### content_cache — 見取り図の作り置き

| 列 | 型 | 内容 |
|---|---|---|
| `product_ref` | INTEGER PK → products | 作品 |
| `signature` | TEXT NOT NULL | 作り置きの署名（`v4\|<台帳の署名>`） |
| `index_json` | TEXT NOT NULL | 見取り図（`ContentIndex`） |
| `install_json` | TEXT NOT NULL | インストールの判定（`InstallAnalysis[]`） |
| `updated_at` | INTEGER NOT NULL | |

### compilation_entries — 総集編・セットの収録作品

読み取った収録作品と、同じサイトで見つけた作品です。組み立て直すたびに作り直します（→ [処理](processing.md#総集編セットの収録作品)）。

| 列 | 型 | 内容 |
|---|---|---|
| `compilation_ref` | INTEGER NOT NULL → products | 総集編・セットの作品 |
| `position` | INTEGER NOT NULL | 並び順（1 から） |
| `title` | TEXT NOT NULL | 収録作品のタイトル（説明文から読み取ったもの、またはセットの中身の作品名） |
| `matches` | TEXT NOT NULL `'[]'` | 見つけた作品（JSON、[CompilationMatchRef](#compilationmatchref) の配列。0〜3 件） |

- 主キー: `(compilation_ref, position)`

### compilation_overrides — 収録作品の手での直し

| 列 | 型 | 内容 |
|---|---|---|
| `compilation_ref` | INTEGER NOT NULL → products | 総集編・セットの作品 |
| `entry_title` | TEXT NOT NULL | 収録作品のタイトル（`compilation_entries.title`） |
| `matches` | TEXT NOT NULL | 手で選んだ作品（JSON、[CompilationMatchRef](#compilationmatchref) の配列）。`[]` は「外した」 |
| `updated_at` | INTEGER NOT NULL | |

- 主キー: `(compilation_ref, entry_title)`
- 行があれば、`compilation_entries.matches` の代わりにこちらを使います。
- 収録作品のタイトルで持つので、説明文が変わって並び順がずれても残ります。

### store_catalog — サークルの作品一覧の作り置き

ストアの公開の作品一覧（未購入の作品を含む）から読み取った作品です。

| 列 | 型 | 内容 |
|---|---|---|
| `store` | TEXT NOT NULL | `dmm-doujin`（DMM 同人）・`dmm-dlsoft`（DMM PCゲーム）・`dlsite-<フロア>`（DLsite。フロアは作品ページの URL から） |
| `maker_id` | TEXT NOT NULL | サークル・ブランドの ID（`products.maker_id`） |
| `product_id` | TEXT NOT NULL | 作品 ID |
| `title` | TEXT NOT NULL | 作品名 |
| `url` | TEXT NOT NULL | 作品ページ |

- 主キー: `(store, maker_id, product_id)`

### store_catalog_makers — 作品一覧を取った記録

| 列 | 型 | 内容 |
|---|---|---|
| `store` / `maker_id` | TEXT NOT NULL | 上と同じ |
| `fetched_at` | INTEGER NOT NULL | 最後に取った（取ろうとした）日時 |
| `item_count` | INTEGER NOT NULL | 作品数 |
| `error` | TEXT | 失敗したときの内容。成功すれば NULL（失敗しても前に取れた一覧は残す） |

- 主キー: `(store, maker_id)`

### credentials — 保存した ID/パスワード

| 列 | 型 | 内容 |
|---|---|---|
| `site_id` | TEXT PK | サイト |
| `login_id` / `secret` | BLOB | 暗号化した ID / パスワード |
| `updated_at` | INTEGER NOT NULL | |

### sync_runs — 同期の記録

| 列 | 型 | 内容 |
|---|---|---|
| `id` | INTEGER PK | |
| `site_id` | TEXT NOT NULL | サイト |
| `started_at` / `finished_at` | INTEGER NOT NULL / INTEGER | |
| `status` | TEXT NOT NULL | `running`・`done`・`partial`（一部の区画が失敗）・`cancelled` |
| `detail` | TEXT | 区画ごとの結果（JSON 配列: `floorKey`・`fetched`・`added`・`updated`・`error`） |

### settings — 設定

| 列 | 型 | 内容 |
|---|---|---|
| `key` | TEXT PK | [設定キー](#設定キー) |
| `value` | TEXT NOT NULL | 真偽は `'1'` / `'0'`、構造は JSON |

## JSON の形

### ProductLink

```ts
{
  label: string; url: string; kind: 'download' | 'stream' | 'play' | 'page';
  quality?: { key: string; name: string | null; sizeMb: number | null; order: number; part: number };
  codec?: 'h264';
}
```

`kind`: `download` = ファイルの保存、`stream` = ブラウザで読む・見る、`play` = ブラウザで遊ぶ、`page` = 案内ページ。`label` は日本語で保存します。

- `quality`（動画のダウンロード）: 画質の印（`300`〜`6000`・`4k` など）、サイトの呼び名、容量（MB。全パートの合計を 1 パート目にだけ持つ）、並び（大きいほど高画質）、パート番号。
- `codec: 'h264'`（動画のストリーミング）: 4K 作品の H.264 版のプレイヤー。

### Creator

```ts
{ role: string; name: string; id: string | null }
```

`role` は日本語の役割名（`著者`・`ブランド`・`サークル`・`出演`・`監督`・`声優` など）。

### VolumeSet

```ts
{
  totalCount: number | null;
  owned: Array<{
    contentId: string; volumeNumber: number | null; title: string;
    publishedAt: string | null; coverUrl: string | null; streamingUrl: string | null; downloadUrl: string | null;
  }>;
}
```

### LinkCandidate

```ts
{ kind: 'dgp' | 'program'; name: string; score: number }
```

`dgp` = DMM GAMES PLAYER のゲーム（`name` はフォルダ名）、`program` = 導入済みプログラム（`name` は表示名）。`score` は 0〜1。

### CompilationMatchRef

```ts
{ productId: string; title: string; url: string | null; score: number | null }
```

同じサイトの作品 ID・作品名・作品ページ。`score` はタイトルの近さ（0〜1）、手で選んだものとセットの中身は NULL または 1。

### JobOptions

| `kind` | 形 |
|---|---|
| `extract` | `{ deleteArchive?: boolean; archivedToo?: boolean }` |
| `flac`・`pdf` | `{ original: 'trash' \| 'delete' \| 'keep' }` |
| `lossy` | `{ original: 'trash' \| 'delete' \| 'keep'; thenFlac: boolean }` |
| `move` | `{ items: RelocationItem[]; roots: string[] }` |

### JobResult

```ts
{
  converted?: number; removed?: number; moved?: number;
  beforeBytes?: number; afterBytes?: number;
  archive?: string; folder?: string; files?: number; deletedArchives?: string[];
  skipped?: Array<{ path: string; reason: string }>;
}
```

### ContentIndex（`content_cache.index_json`）

| キー | 内容 |
|---|---|
| `sources` | 読んだ元（`path`・`kind` = `file` / `folder` / `archive`・`error`） |
| `archives` | アーカイブごとの概要（ファイル数・展開後の大きさ・WAV の数と大きさ・実行ファイルの有無・自前で読めたか） |
| `audioGroups` | 音声のグループ（フォルダ・版のラベル・トラック） |
| `documents` / `subtitles` / `images` / `videos` / `books` | 台本・字幕・画像・動画・電子書籍（`url`・`relPath`・`name`・`size`・`container`・`inArchive`） |
| `wavCount` / `wavBytes` | WAV の数と大きさ |
| `audioOnlyInArchive` | 音声がアーカイブの中にだけあるか |
| `lossyOnly` | 消せる WAV / FLAC（`container`・`inArchive`・`count`・`bytes`・`kept`） |
| `pdfStrip` | 消せる PDF（`container`・`inArchive`・`count`・`bytes`・`names`） |
| `storage` | 保存のしかた（`mode` = `extract` / `archive`・`reason`） |

型の正は `src/shared/types.ts` です。

## 設定キー

| キー | 値 | 既定 |
|---|---|---|
| `app.language` | `ja`・`en`・`zh` | OS の表示言語（ja / zh、ほかは en） |
| `download.root` | 保存先のパス | `ドキュメント\Simaeru` |
| `download.rootHistory` | 以前の保存先（JSON 配列、最大 10） | — |
| `download.template` | フォルダ構成 | `{site}/{category}/{maker}/{workType}/[{maker}] {title}` |
| `download.concurrency` | 同時に落とす数（1〜8） | 1 |
| `download.maxBytesPerSec` | 帯域制限（バイト/秒、0 = なし） | 0 |
| `download.videoQuality` | 動画の画質の既定（`best`・`h:<縦の画素数>`） | `best` |
| `compilation.guess` | 同人・CG などの総集編の収録作品を推定する（`'1'` / `'0'`） | `0` |
| `library.autoUsed` | 閲覧・再生で♡「使った」を付ける（`'0'` のときだけ付けない） | `1`（未設定はオン） |
| `download.videoQuality.<productRef>` | 作品ごとに選んだ画質（`q:<画質の印>`） | — |
| `post.autoExtract` | 展開して使う作品を自動で展開 | `1` |
| `post.deleteArchiveAfterExtract` | 上の展開後にアーカイブを削除 | `1` |
| `post.autoFlac` | WAV を自動で FLAC に | `1` |
| `post.flacMinBytes` | 自動 FLAC の対象にする WAV の合計の下限（バイト） | 209715200（200 MiB） |
| `post.flacOriginal` | 作り直したときの元の扱い（`trash`・`delete`・`keep`） | `trash` |
| `post.lossyOnly` | MP3 だけ残すを自動で | `0` |
| `post.stripPdfTypes` | PDF を消す種別（JSON 配列、`cg`・`manga`） | `[]` |
| `post.archiveHandling` | 圧縮で持つ種別ごとの扱い（JSON、キー `manga`・`cg`・`voice`・`music`・`video`・`novel`・`other`、値 `archive`・`extract`・`extractDelete`） | すべて `archive` |
| `tools.sevenZip` / `tools.ffmpeg` / `viewer.neeview` | ツールの場所の指定 | 空（自動で探す） |
| `import.folders` | 取り込みで走査するフォルダ（JSON 配列） | 保存先 |
| `meta.auto.enabled` | 詳細の順次取得 | `1` |
| `meta.auto.intervalMs` / `meta.auto.concurrency` | 詳細の順次取得の間隔（ミリ秒）と並列数 | 500 / 2 |
| `player.state.<productRef>` | 聴いた位置・読んだページ（JSON） | — |

フォルダ構成のトークン: `{site}`・`{category}`・`{workType}`・`{maker}`・`{title}`・`{productId}`・`{floor}`・`{year}`・`{month}`（購入年月）。

### 画面の設定（localStorage）

| キー | 内容 |
|---|---|
| `library.sortKey` / `library.sortDir` / `library.view` | 並べ替え（`purchased`・`released`・`title`・`maker`・`used`）・向き・表示 |
| `viewer.prefs` | ビューアの表示（`wheelInvert`・`pageInterval`・`smoothing`・`sharpen`） |
| `viewer.spread` / `viewer.rtl.<種別>` | 見開き / 綴じ方向 |

## 手元の状態

一覧の絞り込み（`LibraryQuery.localState`）とサイドバーの件数は、次の条件で数えます。

| 状態 | 条件 |
|---|---|
| `have`（ダウンロード済み） | `local_files` に実体（`missing_at IS NULL`）がある、または `installations.state = 'installed'` |
| `installed`（インストール済み） | `installations.state = 'installed'` |
| `notInstalled`（未インストール） | 実体がある ∧ ゲーム・ツール ∧ `installed` でない ∧ `broken` でない ∧ `link_candidate IS NULL` |
| `linkable`（紐付け候補あり） | `link_candidate IS NOT NULL` ∧ `installed` でない |
| `broken`（リンク切れ） | `installations.state = 'broken'`（→ [処理](processing.md#リンク切れ)） |
| `none`（未取得） | `have` でない |

ゲーム・ツール: `work_type` が `game`・`tool`、または `category = 'game'` で `work_type` が NULL・`other`。

`Product.hasLocalFile` は「`local_files` に実体がある」だけを表します。`Product.isCompilation` は `compilation_entries` に行があることを表します。

## 並べ替え

| `sortKey` | 列 |
|---|---|
| `purchased` | `purchased_at` |
| `released` | `released_at` |
| `title` | `title` |
| `maker` | `maker` |
| `used` | `max(installations.last_launched_at, viewed_at)`（どちらも無ければ NULL） |

値が NULL の作品は、向きによらず後ろに並びます。同じ値は `id` で並べます。
