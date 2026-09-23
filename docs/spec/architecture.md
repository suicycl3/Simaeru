# 構成

## プロセス

| 種類 | 実体 | 役割 |
|---|---|---|
| メインプロセス | `src/main`（Node.js） | データベース、購入履歴の同期、ダウンロード、後処理、ファイル操作、外部ツールの実行、ウィンドウの管理 |
| preload | `src/preload` | 画面に `window.api` を公開する（`contextBridge`）。画面の言語を同期で渡す |
| レンダラ | `src/renderer`（React 18） | 画面。データベースやファイルには直接触れず、`window.api` を通す |

メインプロセスが開くウィンドウ:

| ウィンドウ | セッション | 用途 |
|---|---|---|
| 主ウィンドウ | 既定 | アプリの画面 |
| ログインウィンドウ | サイトごとのパーティション | サイトの画面でログインする |
| ダウンロード用ウィンドウ（非表示） | サイトごとのパーティション | ダウンロード 1 行につき 1 つ。`webContents.downloadURL()` でダウンロードを始める |
| アプリ内ブラウザ | サイトごとのパーティション（sandbox） | 作品の「ブラウザで読む・遊ぶ」の導線を開く |

子プロセス: `7z.exe`・`ffmpeg.exe`・`ffprobe.exe`・`NeeView.exe`・`powershell.exe`（導入済みプログラムの一覧）・`reg.exe`・`tasklist.exe`。
DMM GAMES PLAYER は URL スキーム（`dmmgameplayer://`）で起動を依頼します。

独自のプロトコル:

| スキーム | 内容 |
|---|---|
| `libcover://<ファイル名>` | 表紙のキャッシュ（`covers\`） |
| `mylib://f/<base64url(パス)>` | 台帳にあるファイル（Range 対応） |
| `mylib://a/<base64url(アーカイブのパス)>/<base64url(中のパス)>` | アーカイブの中の 1 ファイル |

## モジュール

### メインプロセス（src/main）

| モジュール | 内容 |
|---|---|
| `index.ts` | 起動と終了の順序、多重起動の禁止、データの置き場所の決定 |
| `ipc.ts` | IPC の登録。画面からの要求を各サービスに渡す |
| `db/database.ts` | データベースを開く、移行、破損時の立て直し、終了時の後始末 |
| `db/schema.ts` | 移行の SQL（`MIGRATIONS`、配列の長さが現在の版） |
| `db/repo.ts` | 問い合わせと更新（作品・インストール・ダウンロード・台帳・ジョブ・作り置き・設定） |
| `db/playlistStore.ts` | プレイリスト（作る・名前を変える・消す・出し入れ・並び） |
| `auth/loginWindow.ts` | ログインウィンドウと、保存した ID/パスワードの入力 |
| `auth/credentials.ts` | ID/パスワードの暗号化保存 |
| `sites/*` | 購入サイトごとのアダプタ（ログインの確認・購入履歴・作品の詳細・店舗ページ） |
| `sync/syncService.ts` | 同期の実行 |
| `meta/metaCrawler.ts` | 作品の詳細の順次取得 |
| `meta/compilations.ts` | 総集編・セットの収録作品の組み立て、作品一覧の取得、選び直す候補 |
| `sites/catalog.ts`・`sites/catalogParse.ts` | サークル・ブランドの作品一覧（ストアの公開ページ）の取得と読み取り |
| `install/linkHealth.ts` | 紐付けが生きているか（リンク切れ）の見回り |
| `install/dmmPlayer.ts` | DMM Player の検出と、ダウンロードした動画を渡す |
| `images/imageCache.ts` | 表紙のキャッシュ |
| `download/downloadManager.ts` | ダウンロードのキュー |
| `download/paths.ts` | 保存先のフォルダ構成 |
| `download/relocate.ts` | 保存先・構成の変更に伴う移動 |
| `download/throttle.ts` | 帯域制限 |
| `jobs/jobRunner.ts` | 後処理のキュー（展開・FLAC・MP3 だけ残す・PDF を消す・移動） |
| `archive/zipReader.ts` | zip の読み取り（目次・無圧縮エントリの範囲読み・deflate） |
| `archive/sevenZip.ts` | 7-Zip の実行（一覧・展開・作成・検査） |
| `archive/archiveAccess.ts` | アーカイブの中の 1 ファイルを返す（一時キャッシュを含む） |
| `content/contentIndex.ts` | 中身の一覧（見取り図）を作る |
| `content/contentCache.ts` | 見取り図の作り置き |
| `content/localProtocol.ts` | `mylib://` の処理 |
| `media/flac.ts` | WAV → FLAC 変換と検証 |
| `import/scanner.ts`・`import/matcher.ts` | 手元のファイルの取り込みと作品との照合 |
| `install/installService.ts` | インストールの判定、導入済みプログラムの一覧、起動 |
| `install/dmmGamePlayer.ts` | DMM GAMES PLAYER の検出・起動 |
| `install/linkCandidates.ts` | 紐付け候補の検出 |
| `tools/toolInstaller.ts`・`tools/externalTools.ts` | 外部ツールの取得と場所の解決 |
| `viewer/neeview.ts`・`viewer/neeviewSettings.ts` | NeeView での表示と初期設定 |
| `viewer/siteBrowser.ts` | アプリ内ブラウザ |
| `fsRetry.ts` | 一時的に開けないファイルのやり直し |

### レンダラ（src/renderer/src）

| モジュール | 内容 |
|---|---|
| `App.tsx` | 画面全体の状態、一覧の問い合わせ、選択モード、各パネルの開閉、通知の受け取り |
| `components/Sidebar.tsx` | 絞り込み、手元の状態、警告 |
| `components/Toolbar.tsx` | 検索、並べ替え、表示の切り替え、ダウンロードと同期のメニュー |
| `components/LibraryGrid.tsx` | 作品の一覧（仮想化） |
| `components/DetailPanel.tsx` | 作品の詳細 |
| `components/CompilationSection.tsx` | 総集編・セットの収録作品（持っているか）・収録している総集編 |
| `components/LocalFilesSection.tsx` | 手元のファイル |
| `components/InstallSection.tsx` | インストール・起動・紐付け |
| `components/DownloadPanel.tsx` | ダウンロード管理 |
| `components/SettingsPanel.tsx` | 設定 |
| `components/ImportPanel.tsx` | 取り込み |
| `components/viewer/MediaViewer.tsx` | 画像・PDF・動画のビューア |
| `components/viewer/VoicePlayer.tsx` | ボイスプレイヤー |
| `components/viewer/PdfView.tsx`・`TextView.tsx` | PDF・テキストの表示 |
| `lib/viewerPrefs.ts` | ビューアの表示設定（localStorage） |

### 共通（src/shared）

| モジュール | 内容 |
|---|---|
| `types.ts` | 型と表示用の表 |
| `contentRules.ts` | 中身の判定の規則 |
| `storagePolicy.ts` | 保存のしかたの規則 |
| `compilation.ts` | 総集編・セットの収録作品の読み取りと照らし合わせの規則 |
| `i18n/` | 多言語化（`index.ts`・`en.ts`・`zh.ts`） |
| `appInfo.ts` | 表示名と `APP_ID` |

## 起動の順序

1. データの置き場所を `%APPDATA%\<APP_ID>` に決める（環境変数 `SIMAERU_USER_DATA` があればそのフォルダ）。
2. 多重起動を禁止する。2 つ目のプロセスは、既存の主ウィンドウを前面に出して終了する。
3. `libcover://`・`mylib://` をスキームとして登録する。
4. データベースを開く（[処理 §データベースの開き方](processing.md#データベースの開き方)）。
5. 画面の言語を決める（設定 `app.language` → OS の表示言語 → English）。
6. 保存済み ID/パスワードの控えファイルを確認する。
7. アーカイブ用の一時キャッシュを設定し、上限を超えたぶんを消す。`mylib://` のハンドラを登録する。
8. IPC を登録し、ダウンロード・後処理・詳細の順次取得の各サービスを作る。紐付け候補の検出を 20 秒後に予約する。
9. 主ウィンドウを開く。表紙のキャッシュの不足ぶんを取得する。
10. 詳細の順次取得を開始する。
11. ダウンロードを開始する（「取得中」の行を「待機」に戻す、完了扱いで実体の無い行を直す、見回りを始める）。
12. 後処理を開始する（作業フォルダを片付け、「処理中」のジョブを「待機」に戻す）。

## 終了の順序

1. 詳細の順次取得・ダウンロード・後処理を止める（ダウンロードは一時停止し、次回続きから取る）。
2. データベースの WAL をチェックポイントして閉じる。
3. 各サイトのパーティションの Cookie を書き出す。

## プロセス間通信（IPC）

### 要求（`ipcMain.handle`）

| 系統 | チャンネル |
|---|---|
| アプリ | `app:info`・`app:about`・`app:setLanguage`・`app:langSync`（同期） |
| ログイン | `auth:status`・`auth:login`・`auth:logout` |
| ID/パスワード | `credentials:list`・`credentials:get`・`credentials:reveal`・`credentials:clear`（保存を含む） |
| 一覧 | `library:query`・`library:facets`・`library:makers`・`library:tags`・`library:workTypes`・`library:product`・`library:detail`・`library:setFavorite`・`library:setUsed`・`library:autoUsed`・`library:setAutoUsed`・`library:markViewed`・`library:files`・`library:files2`・`library:removeFile`・`library:refreshLocal`・`library:trashFiles`・`library:trashPlan`・`library:trashMany`・`library:compilation`・`library:compilationGuess`・`library:setCompilationGuess`・`library:compilationCandidates`・`library:setCompilationOverride`・`library:refreshCatalog`・`library:openCompilationItem` |
| プレイリスト | `playlists:list`・`playlists:create`・`playlists:rename`・`playlists:delete`・`playlists:add`・`playlists:remove`・`playlists:of` |
| 同期 | `sync:start`・`sync:cancel`・`sync:lastAt` |
| 詳細の順次取得 | `meta:status`・`meta:setEnabled`・`meta:setSpeed`・`meta:runNow` |
| ダウンロード | `download:enqueue`・`download:redownload`・`download:estimate`・`download:list`・`download:pause`・`download:resume`・`download:cancel`・`download:retry`・`download:remove`・`download:resumeAll`・`download:pauseAll`・`download:clearFinished`・`download:settings`・`download:saveSettings`・`download:pickRoot`・`download:relocationPlan`・`download:relocate` |
| 後処理 | `jobs:list`・`jobs:forProduct`・`jobs:settings`・`jobs:saveSettings`・`jobs:extract`・`jobs:flac`・`jobs:flacEstimate`・`jobs:lossyOnly`・`jobs:stripPdf`・`jobs:removeExtracted`・`jobs:cancel`・`jobs:retry`・`jobs:remove`・`jobs:pickTool` |
| 中身 | `content:index`・`content:verify`・`player:getState`・`player:setState` |
| 取り込み | `import:folders`・`import:addFolder`・`import:removeFolder`・`import:scan` |
| インストール | `install:analyze`・`install:runInstaller`・`install:useFolder`・`install:pickFolder`・`install:pickExe`・`install:folderCandidates`・`install:linkInstalled`・`install:programs`・`install:programExes`・`install:linkExisting`・`install:dgpStatus`・`install:linkDgp`・`install:openDgp`・`install:dgpSummary`・`install:refreshCandidates`・`install:checkLink`・`install:dmmPlayerStatus`・`install:unlink`・`install:launch` |
| ツール | `tools:status`・`tools:plan`・`tools:install`・`tools:uninstall`・`tools:openDir`・`tools:pick`・`tools:clearPath`・`tools:neeviewDefaults` |
| 表示・外部 | `viewer:open`・`viewer:openDmmPlayer`・`viewer:neeview`・`viewer:setNeeView`・`browser:open`・`shell:openExternal`・`shell:openPath`・`shell:showInFolder` |

画面からの呼び出しの形（引数と戻り値の型）は `src/preload/index.ts` の `window.api` が正です。

### 通知（メイン → 画面、`webContents.send`）

| チャンネル | 内容 |
|---|---|
| `sync:progress` | 同期の進み具合 |
| `meta:progress` | 詳細の順次取得の状態 |
| `covers:progress` | 表紙のキャッシュの進み具合 |
| `auth:changed` | ログイン状態が変わった |
| `download:progress` | ダウンロードの行の一覧（実行中の情報を含む） |
| `jobs:progress` | 後処理の行の一覧 |
| `library:changed` | 作品の情報が変わった（`productRef`、全体なら `null`） |
| `library:filesChanged` | 手元のファイルが変わった（`productRef`、全体なら `null`） |
| `library:refreshProgress` | 「最新にする」の進み具合 |
| `library:compilationsChanged` | 総集編・セットの収録作品を組み立て直した・手で直した（`count`。手で直したときは `null`） |
| `content:updated` | 見取り図を作り直した（`productRef`） |
| `import:progress` | 取り込みの進み具合 |
| `tools:progress` | ツールの取得の進み具合 |

画面は `library:changed` と `library:filesChanged` を 400 ミリ秒まとめてから、件数と該当する作品の表示を更新します。
手元の状態で絞り込んでいるとき、並べ替えが「利用日順」のとき、`productRef` が `null` のときは、一覧を読み直します。
