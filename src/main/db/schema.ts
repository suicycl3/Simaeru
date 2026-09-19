/**
 * スキーマは user_version による前方移行のみ。既存行を壊す変更は新しいマイグレーションを足す。
 * 生レスポンス(raw_json)を保持しているので、後からカラムを足しても再同期なしで埋め直せる。
 */
export const MIGRATIONS: string[] = [
  // v1: 初版
  `
  CREATE TABLE products (
    id              INTEGER PRIMARY KEY,
    site_id         TEXT    NOT NULL,
    floor_id        TEXT    NOT NULL,
    product_id      TEXT    NOT NULL,
    content_id      TEXT,
    title           TEXT    NOT NULL,
    maker           TEXT,
    maker_id        TEXT,
    authors         TEXT    NOT NULL DEFAULT '[]',
    genre           TEXT,
    product_type    TEXT,
    purchased_at    TEXT,
    cover_url       TEXT,
    cover_file      TEXT,
    detail_url      TEXT,
    file_size_text  TEXT,
    file_size_bytes INTEGER,
    is_downloadable INTEGER NOT NULL DEFAULT 0,
    is_streaming    INTEGER NOT NULL DEFAULT 0,
    is_unavailable  INTEGER NOT NULL DEFAULT 0,
    has_drm         INTEGER NOT NULL DEFAULT 0,
    tags            TEXT    NOT NULL DEFAULT '[]',
    raw_json        TEXT,
    first_seen_at   INTEGER NOT NULL,
    last_synced_at  INTEGER NOT NULL,
    UNIQUE(site_id, floor_id, product_id)
  );
  CREATE INDEX idx_products_floor    ON products(site_id, floor_id);
  CREATE INDEX idx_products_purchased ON products(purchased_at DESC);
  CREATE INDEX idx_products_maker    ON products(maker);

  -- 日本語は語境界がないため trigram トークナイザで部分一致検索する（FTS5 3.34+）
  CREATE VIRTUAL TABLE products_fts USING fts5(
    title, maker, authors, tags,
    content='products', content_rowid='id', tokenize='trigram'
  );
  CREATE TRIGGER products_ai AFTER INSERT ON products BEGIN
    INSERT INTO products_fts(rowid, title, maker, authors, tags)
    VALUES (new.id, new.title, coalesce(new.maker,''), new.authors, new.tags);
  END;
  CREATE TRIGGER products_ad AFTER DELETE ON products BEGIN
    INSERT INTO products_fts(products_fts, rowid, title, maker, authors, tags)
    VALUES ('delete', old.id, old.title, coalesce(old.maker,''), old.authors, old.tags);
  END;
  CREATE TRIGGER products_au AFTER UPDATE ON products BEGIN
    INSERT INTO products_fts(products_fts, rowid, title, maker, authors, tags)
    VALUES ('delete', old.id, old.title, coalesce(old.maker,''), old.authors, old.tags);
    INSERT INTO products_fts(rowid, title, maker, authors, tags)
    VALUES (new.id, new.title, coalesce(new.maker,''), new.authors, new.tags);
  END;

  -- インストール管理（Phase 2 の受け皿）。
  -- 同名タイトルでも購入サイトが違えば認証系が変わるため、必ず products 側の
  -- (site_id, floor_id, product_id) に紐付けて1対1で持つ。
  CREATE TABLE installations (
    id               INTEGER PRIMARY KEY,
    product_ref      INTEGER NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
    kind             TEXT    NOT NULL,   -- 'linked_existing' | 'managed'
    install_path     TEXT,
    executable_path  TEXT,
    uninstall_key    TEXT,               -- Windows Uninstall レジストリキー（既存導入との紐付け用）
    display_name     TEXT,
    version          TEXT,
    state            TEXT    NOT NULL DEFAULT 'not_installed',
    linked_at        INTEGER NOT NULL,
    last_launched_at INTEGER,
    notes            TEXT
  );

  CREATE TABLE sync_runs (
    id          INTEGER PRIMARY KEY,
    site_id     TEXT    NOT NULL,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    status      TEXT    NOT NULL,
    detail      TEXT
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,

  // v2: 電子書籍の同一性キーを content_id（＝最後に買った巻。買い足すたびに変わる）から
  //     series_id へ変更した。旧キーの行は重複になるので捨て、次の同期で入れ直す。
  `
  DELETE FROM products WHERE site_id = 'dmm' AND floor_id = 'book';
  `,

  // v3: purchased_at が「本当に買った日」なのか「作品の配信開始日」なのかを区別する。
  //     PCゲームの一覧APIは注文日を返さず deliveryBeginDate しか無いため、
  //     詳細API(order.orderDate)を取るまでは暫定値であることを持たせておく。
  //     'order' = 実際の購入/注文日、'delivery' = 配信開始日（暫定）。
  `
  ALTER TABLE products ADD COLUMN purchased_at_source TEXT;
  UPDATE products SET purchased_at_source = 'order'
    WHERE purchased_at IS NOT NULL AND floor_id IN ('doujin', 'video');
  UPDATE products SET purchased_at_source = 'delivery'
    WHERE purchased_at IS NOT NULL AND floor_id = 'dlsoft';
  `,

  // v4: 発売日を購入日とは別に持つ。あわせて作品メタ（説明文・クリエイター）と、
  //     セット商品に収録されている単品を一覧へ展開するための親子関係を追加する。
  `
  ALTER TABLE products ADD COLUMN released_at TEXT;
  ALTER TABLE products ADD COLUMN description TEXT;
  ALTER TABLE products ADD COLUMN creators TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE products ADD COLUMN parent_product_id TEXT;

  -- PCゲームは purchased_at に配信開始日（＝ほぼ発売日）が入っていたので発売日側へ写す。
  -- purchased_at 側は詳細取得で本物の注文日に差し替わる。
  UPDATE products SET released_at = purchased_at
    WHERE floor_id = 'dlsoft' AND purchased_at_source = 'delivery';

  CREATE INDEX idx_products_released ON products(released_at DESC);
  CREATE INDEX idx_products_parent ON products(site_id, floor_id, parent_product_id);
  `,

  // v5: 全文検索を external content 方式から独立方式へ変更する。
  //
  // external content（content='products'）では、削除・更新のたびに
  // 「索引時とまったく同じ値」を 'delete' コマンドで渡す必要があり、
  // 一度でも食い違うと索引が黙って壊れる。実際に破損を起こしたので、
  // 自前でテキストを持つ普通のFTS5表にして rowid 指定で消せるようにする。
  // 容量は増えるが、トリガとデータの整合という壊れやすい前提が消える。
  `
  DROP TRIGGER IF EXISTS products_ai;
  DROP TRIGGER IF EXISTS products_ad;
  DROP TRIGGER IF EXISTS products_au;
  DROP TABLE IF EXISTS products_fts;

  CREATE VIRTUAL TABLE products_fts USING fts5(title, maker, authors, tags, tokenize='trigram');

  INSERT INTO products_fts(rowid, title, maker, authors, tags)
    SELECT id, title, coalesce(maker, ''), authors, tags FROM products;

  CREATE TRIGGER products_ai AFTER INSERT ON products BEGIN
    INSERT INTO products_fts(rowid, title, maker, authors, tags)
    VALUES (new.id, new.title, coalesce(new.maker, ''), new.authors, new.tags);
  END;
  CREATE TRIGGER products_ad AFTER DELETE ON products BEGIN
    DELETE FROM products_fts WHERE rowid = old.id;
  END;
  CREATE TRIGGER products_au AFTER UPDATE ON products BEGIN
    DELETE FROM products_fts WHERE rowid = old.id;
    INSERT INTO products_fts(rowid, title, maker, authors, tags)
    VALUES (new.id, new.title, coalesce(new.maker, ''), new.authors, new.tags);
  END;
  `,

  // v6: 作品メタ（詳細API＋店舗ページ）を取得済みかどうかを持つ。
  //     作品ページの内容は基本的に変わらないので、一度取れたら二度目は取りに行かない。
  //     取り直したいときは UI の「再取得」から force 付きで呼ぶ。
  `
  ALTER TABLE products ADD COLUMN meta_fetched_at INTEGER;
  `,

  // v7: 電子書籍の購入日が ISO8601（"2026-02-24T18:47:54+09:00"）のまま入っていたので、
  //     他フロアと同じ "YYYY-MM-DD HH:mm" に揃える。表記が混ざると並べ替えの順序も狂う。
  `
  UPDATE products
     SET purchased_at = substr(purchased_at, 1, 10) || ' ' || substr(purchased_at, 12, 5)
   WHERE purchased_at LIKE '____-__-__T__:__%';
  `,

  // v8: ダウンロード/視聴リンクを保存する。詳細取得の結果にしか出てこないため、
  //     キャッシュ表示（通信しない）ときにボタンが消えてしまうのを防ぐ。
  `
  ALTER TABLE products ADD COLUMN links TEXT NOT NULL DEFAULT '[]';
  `,

  // v9: 「どのサイトで買ったか」と「作品の区分」を別の軸にする。
  //     floor_id はサイト固有の取得単位（DMMのフロア / DLsiteのライブラリ）のままにし、
  //     区分は DMM の分け方に揃えた category で横断的に持つ。
  `
  ALTER TABLE products ADD COLUMN category TEXT;

  UPDATE products SET category = 'game'   WHERE floor_id = 'dlsoft';
  UPDATE products SET category = 'doujin' WHERE floor_id = 'doujin';
  UPDATE products SET category = 'book'   WHERE floor_id = 'book';
  UPDATE products SET category = 'video'  WHERE floor_id = 'video';

  CREATE INDEX idx_products_category ON products(category);
  CREATE INDEX idx_products_site ON products(site_id);
  `,

  // v10: v9 より前に取り込んだ DLsite の行は区分が空のままなので、
  //      保存してある生レスポンスの site_id から埋め直す（再同期不要）。
  //      対応は library.ts の SITE_CATEGORIES と同じ。
  `
  UPDATE products SET category = CASE json_extract(raw_json, '$.site_id')
      WHEN 'maniax' THEN 'doujin'
      WHEN 'home'   THEN 'doujin'
      WHEN 'books'  THEN 'book'
      WHEN 'comic'  THEN 'book'
      WHEN 'pro'    THEN 'game'
      WHEN 'soft'   THEN 'game'
      ELSE 'doujin'
    END
   WHERE site_id = 'dlsite' AND category IS NULL AND raw_json IS NOT NULL;

  -- 生レスポンスが無い行が残っていたら、区分不明として other に寄せる
  UPDATE products SET category = 'other' WHERE category IS NULL;
  `,

  // v11: DLsite のライセンスキー（シリアル）と購入価格。
  //      どちらも play API には無く、旧www側の購入履歴/シリアルページにしかない。
  `
  ALTER TABLE products ADD COLUMN serial_key TEXT;
  ALTER TABLE products ADD COLUMN price_text TEXT;
  `,

  // v12: DLsite は容量をバイト数でしか持っていなかったので、表示用の文字列を作る。
  //      再同期を待たずに一覧・詳細へ出したいので、ここで既存行を埋めておく。
  //      刻みは 1024（DLsiteの作品ページの表記に合わせる）。
  `
  UPDATE products SET file_size_text = CASE
      WHEN file_size_bytes >= 1073741824 THEN printf('%.2fGB', file_size_bytes / 1073741824.0)
      WHEN file_size_bytes >= 1048576    THEN printf('%.2fMB', file_size_bytes / 1048576.0)
      WHEN file_size_bytes >= 1024       THEN printf('%.2fKB', file_size_bytes / 1024.0)
      ELSE printf('%dB', file_size_bytes)
    END
   WHERE site_id = 'dlsite'
     AND file_size_bytes > 0
     AND (file_size_text IS NULL OR file_size_text = '');
  `,

  // v13: DLsite の「取得済み」フラグを落とす。
  //      v12 以前はライセンスキーしか取っておらず作品ページ（説明文・スタッフ・動作環境）を
  //      読んでいなかったので、取得済みの印が実態と合っていない。次に開いたとき取り直す。
  `
  UPDATE products SET meta_fetched_at = NULL WHERE site_id = 'dlsite';
  `,

  // v14: 電子書籍の「シリーズ内の所持巻」。本棚APIはシリーズ単位でしか返さないので、
  //      作品を開いたときに巻一覧APIから拾って持っておく。
  //      形は {"totalCount": 16, "owned": [{contentId, volumeNumber, ...}]}。
  `
  ALTER TABLE products ADD COLUMN volumes TEXT;
  `,

  // v15: 詳細（作品メタ）をバックグラウンドで少しずつ取るための土台と、
  //      サイトのログイン情報の保管場所。
  //      - meta_attempts: 取得に失敗した回数。何度も同じ作品で詰まらないよう上限で打ち切る
  //      - credentials  : 値は OS の安全な保管領域（Windowsなら DPAPI）で暗号化して入れる。
  //                       平文では絶対に置かない。
  `
  ALTER TABLE products ADD COLUMN meta_attempts INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE credentials (
    site_id    TEXT PRIMARY KEY,
    login_id   BLOB,
    secret     BLOB,
    updated_at INTEGER NOT NULL
  );
  `,

  // v16: 表紙を大きい版に差し替える。
  //      同人の一覧APIは 100x75 の縮小版（`d_xxxpl-100x75.jpg`）、
  //      PCゲームは ps（125x200）を返していて、カードに引き伸ばすとぼやけていた。
  //      サイズ指定を外す / pl にすると原寸（560x420 / 411x560）が取れる（実測）。
  //      cover_file を空にして、起動時の先読みで取り直させる。
  `
  UPDATE products
     SET cover_url = replace(cover_url, 'pl-100x75.', 'pl.'),
         cover_file = NULL
   WHERE floor_id = 'doujin' AND cover_url LIKE '%pl-100x75.%';

  UPDATE products
     SET cover_url = substr(cover_url, 1, length(cover_url) - 6) || 'pl.jpg',
         cover_file = NULL
   WHERE floor_id = 'dlsoft' AND cover_url LIKE '%ps.jpg';
  `,

  // v17: 作品の「種別」を横断で揃える。
  //      同人はマンガもCGもボイスもゲームも同じ区分に入っていて見分けられない。
  //      サイトごとに呼び方が違う（DMM「コミック」= DLsite「マンガ」など）ので、
  //      genre を正規化したバケットを持たせて絞り込みに使う。
  `
  ALTER TABLE products ADD COLUMN work_type TEXT;

  UPDATE products SET work_type = CASE
      WHEN genre IS NULL OR genre = ''                       THEN NULL
      WHEN genre LIKE '%コミック%' OR genre LIKE '%マンガ%'   THEN 'manga'
      WHEN genre LIKE 'CG%'                                   THEN 'cg'
      WHEN genre LIKE '%ボイス%' OR genre LIKE '%ASMR%'      THEN 'voice'
      WHEN genre LIKE '%動画%'                                THEN 'video'
      WHEN genre LIKE '%ゲーム%' OR genre IN (
             'ロールプレイング', 'アドベンチャー', 'シミュレーション', 'アクション',
             'クイズ', 'テーブル', 'TBL', 'パズル', 'シューティング', 'タイピング',
             'デジタルノベル', 'その他ゲーム'
           )                                                  THEN 'game'
      WHEN genre LIKE '%小説%' OR genre LIKE '%ノベル%'      THEN 'novel'
      WHEN genre LIKE '%音楽%'                                THEN 'music'
      WHEN genre LIKE '%ツール%' OR genre LIKE '%アクセサリ%' THEN 'tool'
      WHEN genre LIKE '%イラスト%'                            THEN 'cg'
      ELSE 'other'
    END;

  -- PCゲーム・動画・電子書籍は区分そのものが種別なので、空なら区分から埋める
  UPDATE products SET work_type = 'game'  WHERE work_type IS NULL AND category = 'game';
  UPDATE products SET work_type = 'video' WHERE work_type IS NULL AND category = 'video';
  UPDATE products SET work_type = 'manga' WHERE work_type IS NULL AND category = 'book';

  CREATE INDEX idx_products_work_type ON products(work_type);
  `,

  // v18: 種別が「その他」に流れていたぶんを拾い直す。
  //      genre には表示名ではなくコードが入っていることがある
  //      （DMM PCゲーム=Apcgame、DMM動画=AV/AMATEUR、DLsite=MNG/ICG/SOU/MOV/RPG…）。
  `
  UPDATE products SET work_type = CASE genre
      WHEN 'MNG' THEN 'manga'
      WHEN 'ICG' THEN 'cg'
      WHEN 'SOU' THEN 'voice'
      WHEN 'MOV' THEN 'video'
      WHEN 'MUS' THEN 'music'
      WHEN 'TOL' THEN 'tool'
      WHEN 'NRE' THEN 'novel'
      WHEN 'ADV' THEN 'game'
      WHEN 'RPG' THEN 'game'
      WHEN 'SLN' THEN 'game'
      WHEN 'ACN' THEN 'game'
      WHEN 'STG' THEN 'game'
      WHEN 'QIZ' THEN 'game'
      WHEN 'TBL' THEN 'game'
      WHEN 'PZL' THEN 'game'
      WHEN 'TYP' THEN 'game'
      WHEN 'DNV' THEN 'game'
      ELSE work_type
    END
   WHERE work_type = 'other';

  -- PCゲーム・動画は区分そのものが種別。コードが何であれ揃える。
  UPDATE products SET work_type = 'game'  WHERE work_type = 'other' AND category = 'game';
  UPDATE products SET work_type = 'video' WHERE work_type = 'other' AND category = 'video';
  `,

  // v19: お気に入り。付けた時刻を入れる（null なら未登録）。
  //      真偽値ではなく時刻にしておくと「最近お気に入りにした順」も出せる。
  `
  ALTER TABLE products ADD COLUMN favorite_at INTEGER;
  CREATE INDEX idx_products_favorite ON products(favorite_at);
  `,

  // v20: ダウンロードのキュー／履歴と、手元にあるファイルの台帳（DESIGN-download.md §3-5）。
  //      URLは期限付き・セッション依存なので**保存しない**。積むのは「どの作品のどの導線か」だけで、
  //      実行の直前に取り直す。
  `
  CREATE TABLE downloads (
    id             INTEGER PRIMARY KEY,
    product_ref    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    label          TEXT    NOT NULL,
    link_kind      TEXT    NOT NULL,
    link_index     INTEGER NOT NULL DEFAULT 0,
    state          TEXT    NOT NULL,
    save_path      TEXT,
    total_bytes    INTEGER,
    received_bytes INTEGER NOT NULL DEFAULT 0,
    etag           TEXT,
    last_modified  TEXT,
    url_chain      TEXT,
    attempts       INTEGER NOT NULL DEFAULT 0,
    error          TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );
  CREATE INDEX idx_downloads_state ON downloads(state, created_at);
  CREATE INDEX idx_downloads_product ON downloads(product_ref);
  CREATE UNIQUE INDEX idx_downloads_link ON downloads(product_ref, link_kind, link_index);

  CREATE TABLE local_files (
    id          INTEGER PRIMARY KEY,
    product_ref INTEGER REFERENCES products(id) ON DELETE SET NULL,
    path        TEXT    NOT NULL UNIQUE,
    size_bytes  INTEGER,
    kind        TEXT,
    source      TEXT    NOT NULL,
    added_at    INTEGER NOT NULL,
    missing_at  INTEGER
  );
  CREATE INDEX idx_local_files_product ON local_files(product_ref);
  `,

  // v21: ダウンロードのあとの処理（展開・FLAC変換）のキューと、展開してできたフォルダの出どころ。
  //      展開したフォルダも local_files に1行で持ち、derived_from に元のアーカイブのパスを入れる。
  `
  ALTER TABLE local_files ADD COLUMN derived_from TEXT;

  CREATE TABLE jobs (
    id          INTEGER PRIMARY KEY,
    product_ref INTEGER REFERENCES products(id) ON DELETE CASCADE,
    kind        TEXT    NOT NULL,              -- 'extract' | 'flac'
    source      TEXT    NOT NULL,              -- 対象のファイル／フォルダ
    target      TEXT,                          -- 展開先など
    state       TEXT    NOT NULL,              -- 'queued' | 'running' | 'done' | 'error' | 'canceled'
    progress    REAL    NOT NULL DEFAULT 0,    -- 0..1
    message     TEXT,
    error       TEXT,
    result      TEXT,                          -- JSON（削減量など）
    auto        INTEGER NOT NULL DEFAULT 0,    -- ダウンロード後に自動で積んだもの
    options     TEXT,                          -- JSON（元のWAVの扱いなど）
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_jobs_state ON jobs(state, created_at);
  CREATE INDEX idx_jobs_product ON jobs(product_ref);
  `,

  // v22: 作品の中身の見取り図とインストール判定の保存先。
  //      詳細を開くたびにアーカイブやフォルダを読み直さないよう、ダウンロード・展開・変換のあとに作っておく。
  //      signature は台帳（local_files）の中身から作る印で、ファイルが増減・移動したら一致しなくなる。
  `
  CREATE TABLE content_cache (
    product_ref  INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
    signature    TEXT    NOT NULL,
    index_json   TEXT    NOT NULL,
    install_json TEXT    NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  `,

  // v23: 最後に中身を見た日時（内蔵ビューア・プレイヤー・NeeView で開いたとき）。「最近見た順」の並べ替えに使う。
  //      起動した日時は installations.last_launched_at にある。
  `
  ALTER TABLE products ADD COLUMN viewed_at INTEGER;
  `,

  // v24: 起動の紐付けができそうな相手（導入済みプログラム・DMM GAMES PLAYER のゲーム）。JSON。
  //      「紐付け候補あり」を未インストールと分けて数えるために、見回りの結果を持っておく。
  `
  ALTER TABLE products ADD COLUMN link_candidate TEXT;
  `,

  // v25: 動画の作品ページ URL を直す。GraphQL の floor（AV・AMATEUR）を大文字のまま入れていて、開いても作品ページにならなかった。
  //      あわせて、再生・ダウンロードの導線が空のまま「取得済み」になっている動画（素人の shop 名違い・導線を持つ前に取得したもの）を取り直させる。
  `
  UPDATE products
     SET detail_url = 'https://video.dmm.co.jp/' || lower(genre) || '/content/?id=' || coalesce(content_id, product_id)
   WHERE site_id = 'dmm' AND floor_id = 'video' AND genre IS NOT NULL AND genre <> '';
  UPDATE products
     SET meta_fetched_at = NULL, meta_attempts = 0
   WHERE site_id = 'dmm' AND floor_id = 'video' AND (links IS NULL OR links = '[]');
  `,

  // v26: 総集編・詰め合わせの収録作品。説明文から読み取った一覧（entries）と、手元の作品との結び付き（links）。
  //      entries と source='auto' の links は読み直すたびに作り直す。source='manual'（手で結び付けた）・'rejected'（手で外した）は残す。
  //      links は収録作品のタイトルで持つ（説明文が変わって並び順がずれても、手で直したぶんが迷子にならないように）。
  `
  CREATE TABLE compilation_entries (
    compilation_ref INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    position        INTEGER NOT NULL,
    title           TEXT    NOT NULL,
    PRIMARY KEY (compilation_ref, position)
  );
  CREATE TABLE compilation_links (
    compilation_ref INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    entry_title     TEXT    NOT NULL,
    product_ref     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    score           REAL,
    source          TEXT    NOT NULL,          -- 'auto' | 'manual' | 'rejected'
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (compilation_ref, entry_title, product_ref)
  );
  CREATE INDEX idx_compilation_links_product ON compilation_links(product_ref);
  `,

  // v27: 総集編・セットの収録作品を、手元の作品ではなく「同じサイトの同じサークルの作品一覧（未購入を含む）」で探す。
  //      単独では未購入の作品を、総集編で持っているのに買い直さないようにするため。
  //      - compilation_entries.matches: 一覧で見つけた作品（JSON: productId・title・url・score の配列）
  //      - compilation_overrides: 手で選び直した結び付き（収録作品のタイトルごと。matches が [] なら「外した」）
  //      - store_catalog / store_catalog_makers: サークルの作品一覧の作り置き
  //      v26 の compilation_links は手元の作品 ID で持っていたので、手で結び付けたものだけ作品 ID に直して移す。
  `
  ALTER TABLE compilation_entries ADD COLUMN matches TEXT NOT NULL DEFAULT '[]';

  CREATE TABLE compilation_overrides (
    compilation_ref INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    entry_title     TEXT    NOT NULL,
    matches         TEXT    NOT NULL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (compilation_ref, entry_title)
  );
  INSERT OR IGNORE INTO compilation_overrides (compilation_ref, entry_title, matches, updated_at)
    SELECT l.compilation_ref, l.entry_title,
           json_group_array(json_object('productId', p.product_id, 'title', p.title, 'url', p.detail_url, 'score', NULL)),
           max(l.updated_at)
      FROM compilation_links l JOIN products p ON p.id = l.product_ref
     WHERE l.source = 'manual'
     GROUP BY l.compilation_ref, l.entry_title;
  DROP TABLE compilation_links;

  CREATE TABLE store_catalog (
    store       TEXT    NOT NULL,              -- 'dmm-doujin' | 'dmm-dlsoft' | 'dlsite-<フロア>'
    maker_id    TEXT    NOT NULL,
    product_id  TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    url         TEXT    NOT NULL,
    PRIMARY KEY (store, maker_id, product_id)
  );
  CREATE TABLE store_catalog_makers (
    store       TEXT    NOT NULL,
    maker_id    TEXT    NOT NULL,
    fetched_at  INTEGER NOT NULL,
    item_count  INTEGER NOT NULL,
    error       TEXT,
    PRIMARY KEY (store, maker_id)
  );
  `
];
