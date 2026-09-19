# 開発

改修の検討には [仕様](spec/README.md)（構成・IPC・テーブル定義・処理・判定の規則）も参照してください。

## 必要なもの

- Windows 10 / 11
- Node.js 20 以降
- （テストの一部）7-Zip・ffmpeg。設定画面から入れたものか、PC に入っているもの

```bash
npm install
```

## コマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` / `Simaeru.bat dev` | 開発モード（electron-vite。画面の変更がすぐ反映） |
| `npm run build` | ビルド（`out/`） |
| `npm start` | ビルド済みの確認起動 |
| `npm run typecheck` | 型チェック（メイン・レンダラ） |
| `npm run rebuild` | better-sqlite3 を Electron に合わせて再ビルド |

## 構成

```
src/
  main/       Electron のメインプロセス（DB・同期・ダウンロード・後処理・ツール・インストール）
    db/         SQLite（better-sqlite3）の移行とリポジトリ
    sites/      購入サイトごとの取得（dmm / dlsite）
    download/   ダウンロードのキュー・保存先
    jobs/       展開・FLAC 化などの後処理
    archive/    zip の読み取り・7-Zip
    content/    作品の中身の一覧と、画面にファイルを渡す mylib:// プロトコル
    install/    インストール判定・起動・DMM GAMES PLAYER・紐付け候補
    tools/      外部ツールの取得
    viewer/     NeeView・アプリ内ブラウザ
  preload/    画面に渡す API（window.api）
  renderer/   画面（React 18）
  shared/     メインと画面で共通の型・判定の規則・多言語化
tools/        テスト・調査・開発用のスクリプト
docs/         機能ドキュメント（docs/spec/ に仕様）
```

## テスト

| コマンド | 内容 |
|---|---|
| `npm test` | 通常の全テスト。固定サンプル・生成ファイル・使い捨て DB だけを使い、結果を `out/test-results/all` に保存 |
| `npm run test:unit` | Node.js だけで動くテスト |
| `npm run test:integration` | Electron、7-Zip、ffmpeg を使う統合テスト |
| `node tools/test-content-rules.mjs` | 作品の中身の振り分け・保存のしかた・消すファイルの選び方・多言語化など |
| `node tools/i18n-keys.cjs --check` | 翻訳の不足と差し込み名の食い違い（英語・中国語） |
| `node tools/test-paths.mjs` | 保存先のフォルダ構成 |
| `node tools/test-import-match.mjs` | 取り込み時の作品との突き合わせ |
| `node tools/test-dlsite-split.mjs` | 分割リンクの解析・順序・重複除去、旧エラー行から全パートのキューへの置き換え（通信なし） |
| `npx electron tools/test-postprocess.js --encoding-only` | UTF-8 フラグあり・なし、Shift_JIS の生成 ZIP で「MP3だけ残す」を検証（7-Zip が必要） |
| `node tools/test-dlsite-purchase.mjs` / `test-dlsite-store.mjs` / `test-dlsite-map.mjs` / `test-store-parse.mjs` | サイト応答の解析（リポジトリ内で生成する固定サンプル） |
| `node tools/test-statusbar.mjs` | ステータスバーを描画し、ダウンロード・後処理の失敗件数を検証 |
| `npx electron tools/test-credentials.js` | ID/PW の保存（使い捨てのデータフォルダで） |
| `npx electron tools/test-postprocess.js` | 展開・FLAC・MP3 だけ残す・PDF を消す・アーカイブの直読み・ツールの取得（本物の 7-Zip / ffmpeg を使う） |
| `npx electron tools/test-library-local.js` | 中身の作り置き・手元の状態・紐付け候補・並べ替え・ファイルの移動・ダウンロードのキュー・DB の立て直し |

通常テストは、使い捨てのデータフォルダと生成したアーカイブだけを使い、ふだんのデータや作品ファイルには触りません。`--encoding-only` は文字コード別の生成 ZIP だけを短時間で検証します。


動作確認でふだんのデータを使いたくないときは、環境変数 `SIMAERU_USER_DATA` にフォルダを指定して起動すると、そのフォルダをデータの置き場所として使います。

## 画面の文言と翻訳

- 画面の文言は日本語で書き、`t()` を通します。日本語がそのまま辞書のキーになります。

  ```ts
  import { t } from '@shared/i18n';
  t('{count} 件をダウンロード', { count });
  ```

- 差し込みは `{名前}` で、訳文でも同じ名前を使います。`false` / `null` / `undefined` は空文字になります。
- 文言を足したら、`node tools/i18n-keys.cjs` で辞書に無い文言を出し、`src/shared/i18n/en.ts`（英語）と `zh.ts`（简体中文）に足します。
  `node tools/i18n-keys.cjs --check` で、不足や差し込み名の食い違いが無いことを確かめます。
- データベースに保存する日本語（ダウンロードのラベルなど）は訳さずに保存し、表示するときに訳します。

### 言語を足すとき

1. `src/shared/i18n/<言語>.ts` を `en.ts` と同じ形で作る
2. `src/shared/i18n/index.ts` の `Lang`・`LANGS`・`DICTS`・`normalizeLang`・`locale` に足す
3. `tools/i18n-keys.cjs` の `dicts` に足す

## ライセンス表示

`node tools/gen-notices.js` で、依存パッケージと外部ツールのライセンス（`THIRD_PARTY_NOTICES.md`・`THIRD_PARTY_NOTICES.en.md`）を作り直します。

## アプリ名の変更

表示名は `src/shared/appInfo.ts` の `APP_NAME` と `package.json` の `productName` の 2 か所です。
`APP_ID`（データの置き場所のフォルダ名）は変えなくても、表示名だけを変えられます。
