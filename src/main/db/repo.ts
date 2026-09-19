import { LibraryQueryStore } from './libraryQueries';
import { LocalFileStore } from './localFileStore';
import { parseJson, categoryOfFloor, workTypeOf, INSTALLED, BROKEN, HAVE, NEEDS_INSTALL, LINKABLE } from './productRows';
import { SettingsHistoryStore } from './settingsHistory';
import type { DB } from './database';
import type {
  Category,
  CatalogStatus,
  CompilationEntryView,
  CompilationInfo,
  CompilationMatchRef,
  ProductBrief,
  SiteId,
  Creator,
  ProductLink,
  FloorCount,
  Installation,
  InstallKind,
  InstallState,
  JobKind,
  JobResult,
  JobRow,
  JobState,
  LibraryPage,
  LinkCandidate,
  DownloadRow,
  DownloadState,
  LibraryQuery,
  LocalFile,
  MakerFilter,
  SearchField,
  WorkType,
  Product,
  TagFilter,
  VolumeSet
} from '@shared/types';
import { catalogStoreOf } from '../sites/catalogParse';

/** 総集編の収録作品を読み取る材料 */
export interface CompilationMaterial {
  id: number;
  siteId: string;
  floorId: string;
  productId: string;
  contentId: string | null;
  title: string;
  maker: string | null;
  makerId: string | null;
  tags: string[];
  description: string | null;
  productType: string | null;
  parentProductId: string | null;
  detailUrl: string | null;
}

/** アダプタが返す正規化済みレコード（DB用の生値） */
export interface ProductInput {
  siteId: string;
  floorId: string;
  /** サイト横断の区分。未指定なら floor_id から推定する */
  category?: Category;
  productId: string;
  contentId?: string | null;
  title: string;
  maker?: string | null;
  makerId?: string | null;
  authors?: string[];
  genre?: string | null;
  productType?: string | null;
  purchasedAt?: string | null;
  /** 'order' = 実購入日 / 'delivery' = 配信開始日（暫定） */
  purchasedAtSource?: 'order' | 'delivery' | null;
  releasedAt?: string | null;
  description?: string | null;
  creators?: Creator[];
  /** セット収録品なら親セットの productId */
  parentProductId?: string | null;
  links?: ProductLink[];
  serialKey?: string | null;
  priceText?: string | null;
  volumes?: VolumeSet | null;
  coverUrl?: string | null;
  detailUrl?: string | null;
  fileSizeText?: string | null;
  fileSizeBytes?: number | null;
  isDownloadable?: boolean;
  isStreaming?: boolean;
  isUnavailable?: boolean;
  hasDrm?: boolean;
  tags?: string[];
  raw?: unknown;
}

interface DownloadRowRaw {
  id: number;
  product_ref: number;
  title: string;
  site_id: string;
  label: string;
  link_kind: string;
  link_index: number;
  state: string;
  save_path: string | null;
  total_bytes: number | null;
  received_bytes: number;
  etag: string | null;
  last_modified: string | null;
  attempts: number;
  error: string | null;
  created_at: number;
  updated_at: number;
  file_size_bytes: number | null;
}

const DOWNLOAD_SELECT = `
  SELECT d.id, d.product_ref, p.title, p.site_id, d.label, d.link_kind, d.link_index,
         d.state, d.save_path, d.total_bytes, d.received_bytes, d.etag, d.last_modified,
         d.attempts, d.error,
         d.created_at, d.updated_at, p.file_size_bytes
    FROM downloads d JOIN products p ON p.id = d.product_ref`;

function toDownloadRow(r: DownloadRowRaw): DownloadRow {
  return {
    id: r.id,
    productRef: r.product_ref,
    title: r.title,
    siteId: r.site_id,
    label: r.label,
    linkKind: r.link_kind,
    linkIndex: r.link_index,
    state: r.state as DownloadState,
    savePath: r.save_path,
    totalBytes: r.total_bytes,
    receivedBytes: r.received_bytes,
    etag: r.etag,
    lastModified: r.last_modified,
    attempts: r.attempts,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    productBytes: r.file_size_bytes
  };
}

export class Repo {
  private readonly libraryQueries: LibraryQueryStore;
  private readonly localFileStore: LocalFileStore;
  private readonly settingsHistory: SettingsHistoryStore;

  constructor(private db: DB) {
    this.libraryQueries = new LibraryQueryStore(db);
    this.localFileStore = new LocalFileStore(db);
    this.settingsHistory = new SettingsHistoryStore(db);
  }

  /** 同期1件分の書き込み。戻り値は新規追加か更新か。 */
  upsertProduct(input: ProductInput, now = Date.now()): 'added' | 'updated' {
    const existing = this.db
      .prepare('SELECT id FROM products WHERE site_id=? AND floor_id=? AND product_id=?')
      .get(input.siteId, input.floorId, input.productId) as { id: number } | undefined;

    const values = {
      site_id: input.siteId,
      floor_id: input.floorId,
      category: input.category ?? categoryOfFloor(input.floorId),
      work_type: workTypeOf(input.genre, input.category ?? categoryOfFloor(input.floorId)),
      product_id: input.productId,
      content_id: input.contentId ?? null,
      title: input.title,
      maker: input.maker ?? null,
      maker_id: input.makerId ?? null,
      authors: JSON.stringify(input.authors ?? []),
      genre: input.genre ?? null,
      product_type: input.productType ?? null,
      purchased_at: input.purchasedAt ?? null,
      purchased_at_source: input.purchasedAtSource ?? null,
      released_at: input.releasedAt ?? null,
      description: input.description ?? null,
      creators: input.creators === undefined ? null : JSON.stringify(input.creators),
      parent_product_id: input.parentProductId ?? null,
      links: input.links === undefined ? null : JSON.stringify(input.links),
      serial_key: input.serialKey ?? null,
      price_text: input.priceText ?? null,
      volumes: input.volumes === undefined || input.volumes === null ? null : JSON.stringify(input.volumes),
      cover_url: input.coverUrl ?? null,
      detail_url: input.detailUrl ?? null,
      file_size_text: input.fileSizeText ?? null,
      file_size_bytes: input.fileSizeBytes ?? null,
      is_downloadable: input.isDownloadable ? 1 : 0,
      is_streaming: input.isStreaming ? 1 : 0,
      is_unavailable: input.isUnavailable ? 1 : 0,
      has_drm: input.hasDrm ? 1 : 0,
      tags: JSON.stringify(input.tags ?? []),
      raw_json: input.raw === undefined ? null : JSON.stringify(input.raw),
      last_synced_at: now
    };

    if (existing) {
      this.db
        .prepare(
          `UPDATE products SET
             category=@category,
             work_type=coalesce(@work_type, work_type),
             content_id=@content_id, title=@title, maker=@maker, maker_id=@maker_id,
             authors=@authors, genre=@genre, product_type=@product_type,
             purchased_at=CASE
               WHEN purchased_at_source='order' AND @purchased_at_source<>'order' THEN purchased_at
               ELSE coalesce(@purchased_at, purchased_at) END,
             purchased_at_source=CASE
               WHEN purchased_at_source='order' AND @purchased_at_source<>'order' THEN 'order'
               ELSE coalesce(@purchased_at_source, purchased_at_source) END,
             released_at=coalesce(@released_at, released_at),
             description=coalesce(@description, description),
             creators=coalesce(@creators, creators),
             parent_product_id=coalesce(@parent_product_id, parent_product_id),
             links=coalesce(@links, links),
             serial_key=coalesce(@serial_key, serial_key),
             price_text=coalesce(@price_text, price_text),
             volumes=coalesce(@volumes, volumes),
             cover_url=@cover_url, detail_url=@detail_url,
             file_size_text=coalesce(@file_size_text, file_size_text),
             file_size_bytes=coalesce(@file_size_bytes, file_size_bytes),
             is_downloadable=@is_downloadable, is_streaming=@is_streaming,
             is_unavailable=@is_unavailable, has_drm=@has_drm, tags=@tags,
             raw_json=coalesce(@raw_json, raw_json), last_synced_at=@last_synced_at
           WHERE id=@id`
        )
        .run({ ...values, id: existing.id });
      return 'updated';
    }

    this.db
      .prepare(
        `INSERT INTO products
           (site_id, floor_id, category, work_type, product_id, content_id, title, maker, maker_id, authors, genre,
            product_type, purchased_at, purchased_at_source, released_at, description,
            creators, parent_product_id, links, serial_key, price_text, volumes, cover_url, detail_url,
            file_size_text, file_size_bytes,
            is_downloadable, is_streaming, is_unavailable, has_drm, tags, raw_json,
            first_seen_at, last_synced_at)
         VALUES
           (@site_id, @floor_id, @category, @work_type, @product_id, @content_id, @title, @maker, @maker_id, @authors,
            @genre, @product_type, @purchased_at, @purchased_at_source, @released_at,
            @description, coalesce(@creators, '[]'), @parent_product_id,
            coalesce(@links, '[]'), @serial_key, @price_text, @volumes, @cover_url, @detail_url,
            @file_size_text,
            @file_size_bytes, @is_downloadable, @is_streaming, @is_unavailable, @has_drm, @tags,
            @raw_json, @first_seen_at, @last_synced_at)`
      )
      .run({ ...values, first_seen_at: now });
    return 'added';
  }

  upsertMany(inputs: ProductInput[]): { added: number; updated: number } {
    const run = this.db.transaction((rows: ProductInput[]) => {
      let added = 0;
      let updated = 0;
      const now = Date.now();
      for (const row of rows) {
        if (this.upsertProduct(row, now) === 'added') added++;
        else updated++;
      }
      return { added, updated };
    });
    return run(inputs);
  }

  /** 絞り込みに合う作品すべての ID（読み込み済みのページだけでなく、続きも含む） */
  queryLibraryIds(q: LibraryQuery): number[] { return this.libraryQueries.queryLibraryIds(q); }

  queryLibrary(q: LibraryQuery): LibraryPage { return this.libraryQueries.queryLibrary(q); }

  getProduct(id: number): Product | null { return this.libraryQueries.getProduct(id); }

  floorCounts(): FloorCount[] {
    const rows = this.db
      .prepare('SELECT site_id, floor_id, count(*) AS c FROM products GROUP BY site_id, floor_id')
      .all() as Array<{ site_id: string; floor_id: string; c: number }>;
    return rows.map((r) => ({ floorKey: `${r.site_id}:${r.floor_id}`, count: r.c }));
  }

  /** 区分ごとの件数 */
  categoryCounts(): Array<{ category: string; count: number }> {
    return this.db
      .prepare(
        "SELECT coalesce(category, 'other') AS category, count(*) AS count" +
          ' FROM products GROUP BY 1 ORDER BY 2 DESC'
      )
      .all() as Array<{ category: string; count: number }>;
  }

  /** 購入サイトごとの件数 */
  siteCounts(): Array<{ siteId: string; count: number }> {
    return this.db
      .prepare('SELECT site_id AS siteId, count(*) AS count FROM products GROUP BY 1 ORDER BY 2 DESC')
      .all() as Array<{ siteId: string; count: number }>;
  }

  /**
   * ブランド/サークルの一覧。件数は渡された条件（区分・購入サイト・フロア）の中で数える。
   * サイドバーの他の絞り込みと連動させるため、一覧のクエリと同じ条件を受け取る。
   */
  makers(filter: MakerFilter = {}): Array<{ maker: string; count: number }> {
    let sql = "SELECT maker, count(*) AS c FROM products WHERE maker IS NOT NULL AND maker <> ''";
    const params: unknown[] = [];
    if (filter.floors && filter.floors.length) {
      const clauses = filter.floors.map(() => '(site_id=? AND floor_id=?)');
      sql += ` AND (${clauses.join(' OR ')})`;
      for (const f of filter.floors) {
        const [s, fl] = f.split(':');
        params.push(s, fl);
      }
    }
    if (filter.categories && filter.categories.length) {
      sql += ` AND category IN (${filter.categories.map(() => '?').join(', ')})`;
      params.push(...filter.categories);
    }
    if (filter.siteIds && filter.siteIds.length) {
      sql += ` AND site_id IN (${filter.siteIds.map(() => '?').join(', ')})`;
      params.push(...filter.siteIds);
    }
    // 選択中のタグに連動させる（そのタグを持つ作品のブランドだけ出す）
    for (const tag of filter.tags ?? []) {
      sql += ' AND EXISTS (SELECT 1 FROM json_each(products.tags) jt WHERE jt.value = ?)';
      params.push(tag);
    }
    sql += ' GROUP BY maker ORDER BY c DESC, maker ASC';
    const rows = this.db.prepare(sql).all(...params) as Array<{ maker: string; c: number }>;
    return rows.map((r) => ({ maker: r.maker, count: r.c }));
  }

  // ── ダウンロード ───────────────────────────────────────

  /** 同じ作品の同じ導線は1行にまとめる（積み直しても重複しない） */
  upsertDownload(input: {
    productRef: number;
    label: string;
    linkKind: string;
    linkIndex: number;
    state: DownloadState;
    error?: string | null;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO downloads
           (product_ref, label, link_kind, link_index, state, error, created_at, updated_at)
         VALUES (@product_ref, @label, @link_kind, @link_index, @state, @error, @now, @now)
         ON CONFLICT(product_ref, link_kind, link_index) DO UPDATE SET
           label=@label,
           state=CASE WHEN downloads.state='done' THEN 'done' ELSE @state END,
           error=@error,
           updated_at=@now`
      )
      .run({
        product_ref: input.productRef,
        label: input.label,
        link_kind: input.linkKind,
        link_index: input.linkIndex,
        state: input.state,
        error: input.error ?? null,
        now
      });
  }

  updateDownload(
    id: number,
    patch: {
      state?: DownloadState;
      savePath?: string | null;
      totalBytes?: number | null;
      receivedBytes?: number;
      etag?: string | null;
      lastModified?: string | null;
      urlChain?: string | null;
      attempts?: number;
      error?: string | null;
    }
  ): void {
    const columns: Record<string, string> = {
      state: 'state',
      savePath: 'save_path',
      totalBytes: 'total_bytes',
      receivedBytes: 'received_bytes',
      etag: 'etag',
      lastModified: 'last_modified',
      urlChain: 'url_chain',
      attempts: 'attempts',
      error: 'error'
    };
    const fields: string[] = [];
    const params: Record<string, unknown> = { id, now: Date.now() };
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        fields.push(`${column}=@${key}`);
        params[key] = (patch as Record<string, unknown>)[key];
      }
    }
    if (fields.length === 0) return;
    this.db
      .prepare(`UPDATE downloads SET ${fields.join(', ')}, updated_at=@now WHERE id=@id`)
      .run(params);
  }

  deleteDownload(id: number): void {
    this.db.prepare('DELETE FROM downloads WHERE id = ?').run(id);
  }

  getDownload(id: number): DownloadRow | null {
    const row = this.db.prepare(`${DOWNLOAD_SELECT} WHERE d.id = ?`).get(id) as
      | DownloadRowRaw
      | undefined;
    return row ? toDownloadRow(row) : null;
  }

  listDownloads(limit = 300): DownloadRow[] {
    const rows = this.db
      .prepare(
        `${DOWNLOAD_SELECT}
          ORDER BY CASE d.state
                     WHEN 'running' THEN 0 WHEN 'paused' THEN 1 WHEN 'queued' THEN 2
                     WHEN 'error' THEN 3 WHEN 'done' THEN 4 ELSE 5 END,
                   d.updated_at DESC
          LIMIT ?`
      )
      .all(limit) as DownloadRowRaw[];
    return rows.map(toDownloadRow);
  }

  /** 次に走らせる1件。積んだ順 */
  /** 待機中の行を、積んだ順に */
  queuedDownloads(): DownloadRow[] {
    const rows = this.db
      .prepare(`${DOWNLOAD_SELECT} WHERE d.state = 'queued' ORDER BY d.created_at, d.id`)
      .all() as DownloadRowRaw[];
    return rows.map(toDownloadRow);
  }

  /** その作品の「完了」の行を消す（手元のファイルを消したあと、もう一度ダウンロードできるように） */
  deleteDoneDownloads(productRef: number): number {
    return this.db.prepare("DELETE FROM downloads WHERE product_ref = ? AND state = 'done'").run(productRef).changes;
  }

  /** 「完了」「中止」の行をまとめて消す（一覧の片付け） */
  deleteFinishedDownloads(): number {
    return this.db.prepare("DELETE FROM downloads WHERE state IN ('done','canceled')").run().changes;
  }

  /** 起動時。前回「実行中」のまま落ちたものを待機に戻す */
  requeueRunningDownloads(): void {
    this.db
      .prepare("UPDATE downloads SET state='queued', updated_at=? WHERE state='running'")
      .run(Date.now());
  }

  // ── 手元のファイル ─────────────────────────────────────

  addLocalFile(input: {
    productRef: number | null;
    path: string;
    sizeBytes: number | null;
    kind: string | null;
    source: string;
    derivedFrom?: string | null;
  }): void { return this.localFileStore.addLocalFile(input); }

  /** 台帳の1行の大きさを付け直す（FLAC 変換でフォルダが縮んだときなど） */
  updateLocalFileSize(filePath: string, sizeBytes: number | null): void { return this.localFileStore.updateLocalFileSize(filePath, sizeBytes); }

  /** そのアーカイブを展開してできたフォルダ（まだ在るもの） */
  extractedFrom(archivePath: string): LocalFile | null { return this.localFileStore.extractedFrom(archivePath); }

  getLocalFileById(id: number): LocalFile | null { return this.localFileStore.getLocalFileById(id); }

  /** 台帳にあって実在する全パス。mylib:// で読ませてよい範囲の判定に使う */
  allLocalPaths(): string[] { return this.localFileStore.allLocalPaths(); }

  /** 台帳の中身から作る印。ファイルの増減・移動・大きさの変化で変わる（中身の見取り図を作り直す合図） */
  localFileSignature(productRef: number): string { return this.localFileStore.localFileSignature(productRef); }

  getContentCache(productRef: number): { signature: string; indexJson: string; installJson: string; updatedAt: number } | null { return this.localFileStore.getContentCache(productRef); }

  setContentCache(productRef: number, signature: string, indexJson: string, installJson: string): void { return this.localFileStore.setContentCache(productRef, signature, indexJson, installJson); }

  deleteContentCache(productRef: number): void { return this.localFileStore.deleteContentCache(productRef); }

  /** 台帳にある全ファイル（移動の計画用） */
  allLocalFiles(): LocalFile[] { return this.localFileStore.allLocalFiles(); }

  /**
   * ファイル・フォルダを移したあとに、パスを参照しているところをまとめて付け替える。
   * 台帳・展開元の記録・ダウンロード履歴の保存先・インストールの場所（配下の exe を含む）。
   */
  relocatePath(from: string, to: string): void { return this.localFileStore.relocatePath(from, to); }

  /**
   * 台帳に載っているフォルダの中にあるファイルの行を外す（そのフォルダの一部なので、個別の行は要らない）。
   * 以前の取り込みスキャンが、展開したゲームの中の exe や readme を別々に拾っていたのを片付ける。
   * @returns 外した件数
   */
  removeNestedLocalFiles(isInside: (child: string, folder: string) => boolean): number { return this.localFileStore.removeNestedLocalFiles(isInside); }

  setLocalFileMissing(id: number, missingAt: number | null): void { return this.localFileStore.setLocalFileMissing(id, missingAt); }

  removeLocalFile(filePath: string): void { return this.localFileStore.removeLocalFile(filePath); }

  localFiles(productRef: number): LocalFile[] { return this.localFileStore.localFiles(productRef); }

  // ── 展開・FLAC変換のキュー ───────────────────────────────

  addJob(input: {
    productRef: number | null;
    kind: JobKind;
    source: string;
    target?: string | null;
    auto?: boolean;
    options?: unknown;
  }): number {
    // 同じ対象の同じ処理が待っている・走っているなら積まない
    const dup = this.db
      .prepare(
        `SELECT id FROM jobs WHERE kind = ? AND source = ? AND state IN ('queued','running') LIMIT 1`
      )
      .get(input.kind, input.source) as { id: number } | undefined;
    if (dup) return dup.id;
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO jobs (product_ref, kind, source, target, state, auto, options, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`
      )
      .run(
        input.productRef,
        input.kind,
        input.source,
        input.target ?? null,
        input.auto ? 1 : 0,
        input.options === undefined ? null : JSON.stringify(input.options),
        now,
        now
      );
    return Number(info.lastInsertRowid);
  }

  updateJob(
    id: number,
    patch: {
      state?: JobState;
      progress?: number;
      message?: string | null;
      error?: string | null;
      result?: JobResult | null;
      target?: string | null;
    }
  ): void {
    const fields: string[] = [];
    const params: Record<string, unknown> = { id, now: Date.now() };
    for (const key of ['state', 'progress', 'message', 'error', 'target'] as const) {
      if (key in patch) {
        fields.push(`${key}=@${key}`);
        params[key] = patch[key];
      }
    }
    if ('result' in patch) {
      fields.push('result=@result');
      params.result = patch.result ? JSON.stringify(patch.result) : null;
    }
    if (fields.length === 0) return;
    this.db.prepare(`UPDATE jobs SET ${fields.join(', ')}, updated_at=@now WHERE id=@id`).run(params);
  }

  getJob(id: number): (JobRow & { options: unknown }) | null {
    const r = this.db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(id) as JobRaw | undefined;
    return r ? { ...toJob(r), options: safeJson(r.options) } : null;
  }

  listJobs(limit = 200): JobRow[] {
    const rows = this.db
      .prepare(
        `${JOB_SELECT}
          ORDER BY CASE j.state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
                   CASE WHEN j.state IN ('running','queued') THEN j.created_at ELSE -j.updated_at END
          LIMIT ?`
      )
      .all(limit) as JobRaw[];
    return rows.map(toJob);
  }

  nextQueuedJob(): (JobRow & { options: unknown }) | null {
    const r = this.db
      .prepare(`${JOB_SELECT} WHERE j.state = 'queued' ORDER BY j.created_at LIMIT 1`)
      .get() as JobRaw | undefined;
    return r ? { ...toJob(r), options: safeJson(r.options) } : null;
  }

  deleteJob(id: number): void {
    this.db.prepare("DELETE FROM jobs WHERE id = ? AND state <> 'running'").run(id);
  }

  /** 起動時: 前回走っていたものは待機に戻す（途中の成果物は各処理が片付けてからやり直す） */
  requeueRunningJobs(): void {
    this.db.prepare("UPDATE jobs SET state='queued', updated_at=? WHERE state='running'").run(Date.now());
  }

  jobsForProduct(productRef: number): JobRow[] {
    return (
      this.db
        .prepare(`${JOB_SELECT} WHERE j.product_ref = ? ORDER BY j.created_at DESC LIMIT 20`)
        .all(productRef) as JobRaw[]
    ).map(toJob);
  }

  // ── インストール（Phase 2） ─────────────────────────────

  upsertInstallation(input: {
    productRef: number;
    kind: InstallKind;
    installPath: string | null;
    executablePath: string | null;
    uninstallKey?: string | null;
    displayName?: string | null;
    version?: string | null;
    state?: InstallState;
    notes?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO installations (product_ref, kind, install_path, executable_path, uninstall_key,
                                    display_name, version, state, linked_at, notes)
         VALUES (@product_ref, @kind, @install_path, @executable_path, @uninstall_key,
                 @display_name, @version, @state, @linked_at, @notes)
         ON CONFLICT(product_ref) DO UPDATE SET
           kind=@kind, install_path=@install_path, executable_path=@executable_path,
           uninstall_key=@uninstall_key, display_name=@display_name, version=@version,
           state=@state, linked_at=@linked_at, notes=@notes`
      )
      .run({
        product_ref: input.productRef,
        kind: input.kind,
        install_path: input.installPath,
        executable_path: input.executablePath,
        uninstall_key: input.uninstallKey ?? null,
        display_name: input.displayName ?? null,
        version: input.version ?? null,
        state: input.state ?? 'installed',
        linked_at: Date.now(),
        notes: input.notes ?? null
      });
  }

  removeInstallation(productRef: number): void {
    this.db.prepare('DELETE FROM installations WHERE product_ref = ?').run(productRef);
  }

  /** 一般向けの DMM ブックス（book.dmm.com）の作品数。dmm.com のログインが要るかの判断に使う */
  countGeneralBooks(): number {
    const row = this.db
      .prepare("SELECT count(*) AS c FROM products WHERE floor_id = 'book' AND detail_url LIKE 'https://book.dmm.com/%'")
      .get() as { c: number };
    return row.c;
  }

  markViewed(productRef: number): void {
    this.db.prepare('UPDATE products SET viewed_at = ? WHERE id = ?').run(Date.now(), productRef);
  }

  markLaunched(productRef: number): void {
    this.db
      .prepare('UPDATE installations SET last_launched_at = ? WHERE product_ref = ?')
      .run(Date.now(), productRef);
  }

  /** 突き合わせ用に、作品を軽い形で全部出す */
  allProductsForMatching(): Array<{
    id: number;
    productId: string;
    contentId: string | null;
    title: string;
    siteId: string;
    category: string;
  }> {
    return this.db
      .prepare(
        `SELECT id, product_id AS productId, content_id AS contentId, title,
                site_id AS siteId, coalesce(category, 'other') AS category
           FROM products`
      )
      .all() as Array<{
      id: number;
      productId: string;
      contentId: string | null;
      title: string;
      siteId: string;
      category: string;
    }>;
  }

  /** すでに台帳にあるパス（無視したものを含む）。再提示しないために使う */
  knownLocalPaths(): Set<string> { return this.localFileStore.knownLocalPaths(); }

  /** 手元にあるファイルの件数（サイドバー表示用） */
  localCounts(): { have: number; none: number; installed: number; notInstalled: number; linkable: number; broken: number } {
    const row = this.db
      .prepare(
        `SELECT
           sum(CASE WHEN ${HAVE} THEN 1 ELSE 0 END) AS have,
           sum(CASE WHEN ${NEEDS_INSTALL} THEN 1 ELSE 0 END) AS not_installed,
           sum(CASE WHEN ${LINKABLE} THEN 1 ELSE 0 END) AS linkable,
           sum(CASE WHEN ${INSTALLED} THEN 1 ELSE 0 END) AS installed,
           sum(CASE WHEN ${BROKEN} THEN 1 ELSE 0 END) AS broken,
           count(*) AS total
         FROM products p`
      )
      .get() as { have: number | null; not_installed: number | null; linkable: number | null; installed: number | null; broken: number | null; total: number };
    const have = row.have ?? 0;
    return {
      have,
      none: row.total - have,
      installed: row.installed ?? 0,
      notInstalled: row.not_installed ?? 0,
      linkable: row.linkable ?? 0,
      broken: row.broken ?? 0
    };
  }

  /** 紐付けが生きているかを確かめる対象（紐付け済み・リンク切れ） */
  linkHealthTargets(): Array<{ productRef: number; kind: InstallKind; installPath: string | null; executablePath: string | null; uninstallKey: string | null; state: InstallState }> {
    const rows = this.db
      .prepare("SELECT product_ref, kind, install_path, executable_path, uninstall_key, state FROM installations WHERE state IN ('installed', 'broken')")
      .all() as Array<{ product_ref: number; kind: string; install_path: string | null; executable_path: string | null; uninstall_key: string | null; state: string }>;
    return rows.map((r) => ({
      productRef: r.product_ref,
      kind: r.kind as InstallKind,
      installPath: r.install_path,
      executablePath: r.executable_path,
      uninstallKey: r.uninstall_key,
      state: r.state as InstallState
    }));
  }

  /** 紐付けの状態だけを変える（リンク切れ ⇔ 紐付け済み） */
  setInstallationState(productRef: number, state: InstallState): void {
    this.db.prepare('UPDATE installations SET state = ? WHERE product_ref = ?').run(state, productRef);
  }

  /**
   * 紐付けの候補を探す対象: まだ紐付けていない作品のうち、ゲーム・ツール（PCゲーム区分で種別不明を含む）か、
   * 「DMM GAMES PLAYER専用」のタグがあるもの
   */
  linkCandidateTargets(): Array<Pick<Product, 'id' | 'title' | 'maker' | 'productId' | 'tags'>> {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.title, p.maker, p.product_id, p.tags FROM products p
          WHERE NOT ${INSTALLED}
            AND (p.work_type IN ('game', 'tool')
                 OR (p.category = 'game' AND (p.work_type IS NULL OR p.work_type = 'other'))
                 OR p.tags LIKE '%DMM GAMES PLAYER専用%')`
      )
      .all() as Array<{ id: number; title: string; maker: string | null; product_id: string; tags: string }>;
    return rows.map((r) => ({ id: r.id, title: r.title, maker: r.maker, productId: r.product_id, tags: parseJson<string[]>(r.tags, []) }));
  }

  /** 紐付けの候補をまとめて入れ替える（候補の無いものは null にする） */
  setLinkCandidates(candidates: Map<number, LinkCandidate | null>): void {
    const stmt = this.db.prepare('UPDATE products SET link_candidate = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const [id, c] of candidates) stmt.run(c ? JSON.stringify(c) : null, id);
    })();
  }

  // ── 総集編の収録作品 ─────────────────────────────

  /** 収録作品を読み取る材料（全作品） */
  compilationMaterial(): CompilationMaterial[] {
    const rows = this.db
      .prepare(
        `SELECT id, site_id, floor_id, product_id, content_id, title, maker, maker_id, tags, description,
                product_type, parent_product_id, detail_url
           FROM products`
      )
      .all() as Array<{
      id: number;
      site_id: string;
      floor_id: string;
      product_id: string;
      content_id: string | null;
      title: string;
      maker: string | null;
      maker_id: string | null;
      tags: string;
      description: string | null;
      product_type: string | null;
      parent_product_id: string | null;
      detail_url: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      siteId: r.site_id,
      floorId: r.floor_id,
      productId: r.product_id,
      contentId: r.content_id,
      title: r.title,
      maker: r.maker,
      makerId: r.maker_id,
      tags: parseJson<string[]>(r.tags, []),
      description: r.description,
      productType: r.product_type,
      parentProductId: r.parent_product_id,
      detailUrl: r.detail_url
    }));
  }

  /** サークルの作品一覧の作り置き */
  catalogStatus(store: string, makerId: string): CatalogStatus | null {
    const row = this.db
      .prepare('SELECT fetched_at, item_count, error FROM store_catalog_makers WHERE store = ? AND maker_id = ?')
      .get(store, makerId) as { fetched_at: number; item_count: number; error: string | null } | undefined;
    return row ? { store, makerId, fetchedAt: row.fetched_at, count: row.item_count, error: row.error } : null;
  }

  catalogItems(store: string, makerId: string): Array<{ productId: string; title: string; url: string }> {
    return (
      this.db
        .prepare('SELECT product_id, title, url FROM store_catalog WHERE store = ? AND maker_id = ? ORDER BY rowid')
        .all(store, makerId) as Array<{ product_id: string; title: string; url: string }>
    ).map((r) => ({ productId: r.product_id, title: r.title, url: r.url }));
  }

  /** 取った一覧で入れ替える。失敗したときは、前に取れた一覧を残して失敗だけ記録する */
  saveCatalog(store: string, makerId: string, result: { items: Array<{ productId: string; title: string; url: string }> } | { error: string }): void {
    const now = Date.now();
    this.db.transaction(() => {
      if ('error' in result) {
        const prev = this.catalogStatus(store, makerId);
        this.db
          .prepare(
            `INSERT INTO store_catalog_makers (store, maker_id, fetched_at, item_count, error) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (store, maker_id) DO UPDATE SET fetched_at = excluded.fetched_at, error = excluded.error`
          )
          .run(store, makerId, now, prev?.count ?? 0, result.error);
        return;
      }
      this.db.prepare('DELETE FROM store_catalog WHERE store = ? AND maker_id = ?').run(store, makerId);
      const ins = this.db.prepare('INSERT OR IGNORE INTO store_catalog (store, maker_id, product_id, title, url) VALUES (?, ?, ?, ?, ?)');
      for (const item of result.items) ins.run(store, makerId, item.productId, item.title, item.url);
      this.db
        .prepare(
          `INSERT INTO store_catalog_makers (store, maker_id, fetched_at, item_count, error) VALUES (?, ?, ?, ?, NULL)
           ON CONFLICT (store, maker_id) DO UPDATE SET fetched_at = excluded.fetched_at, item_count = excluded.item_count, error = NULL`
        )
        .run(store, makerId, now, result.items.length);
    })();
  }

  /** 読み取り直した収録作品で入れ替える。手で選び直したぶん（compilation_overrides）は残す */
  replaceCompilations(results: Map<number, Array<{ position: number; title: string; matches: CompilationMatchRef[] }>>): void {
    const insEntry = this.db.prepare('INSERT INTO compilation_entries (compilation_ref, position, title, matches) VALUES (?, ?, ?, ?)');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM compilation_entries').run();
      for (const [ref, entries] of results) {
        for (const e of entries) insEntry.run(ref, e.position, e.title, JSON.stringify(e.matches));
      }
    })();
  }

  /** 収録作品の結び付けを手で直す。matches が null なら手で直したぶんを消す（自動に戻す） */
  setCompilationOverride(compilationRef: number, entryTitle: string, matches: CompilationMatchRef[] | null): void {
    if (matches === null) {
      this.db.prepare('DELETE FROM compilation_overrides WHERE compilation_ref = ? AND entry_title = ?').run(compilationRef, entryTitle);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO compilation_overrides (compilation_ref, entry_title, matches, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (compilation_ref, entry_title) DO UPDATE SET matches = excluded.matches, updated_at = excluded.updated_at`
      )
      .run(compilationRef, entryTitle, JSON.stringify(matches), Date.now());
  }

  /**
   * 作品の総集編まわり（収録作品と、持っているかどうか・この作品を収録している総集編）。
   * 持っているかは、同じサイトの作品 ID（product_id・content_id）で見る。
   */
  compilationOf(productRef: number): CompilationInfo {
    const self = this.db
      .prepare('SELECT id, site_id, floor_id, product_id, content_id, maker_id, detail_url FROM products WHERE id = ?')
      .get(productRef) as
      | { id: number; site_id: string; floor_id: string; product_id: string; content_id: string | null; maker_id: string | null; detail_url: string | null }
      | undefined;
    if (!self) return { entries: [], containedIn: [], catalog: null };

    const products = this.db
      .prepare('SELECT id, site_id, product_id, content_id, title, maker, parent_product_id FROM products WHERE site_id = ?')
      .all(self.site_id) as Array<{ id: number; site_id: string; product_id: string; content_id: string | null; title: string; maker: string | null; parent_product_id: string | null }>;
    const brief = (r: { id: number; site_id: string; title: string; maker: string | null }): ProductBrief => ({
      id: r.id,
      siteId: r.site_id as SiteId,
      title: r.title,
      maker: r.maker
    });
    const byRef = new Map(products.map((r) => [r.id, r]));
    // 作品 ID → 手元の作品（単独で買ったものを先に）
    const ownedById = new Map<string, (typeof products)[number]>();
    for (const r of [...products].sort((a, b) => Number(!!a.parent_product_id) - Number(!!b.parent_product_id))) {
      for (const key of [r.product_id, r.content_id]) if (key && !ownedById.has(key)) ownedById.set(key, r);
    }

    const rows = this.db
      .prepare(
        `SELECT e.compilation_ref, e.position, e.title, e.matches, o.matches AS override
           FROM compilation_entries e
           JOIN products p ON p.id = e.compilation_ref
           LEFT JOIN compilation_overrides o ON o.compilation_ref = e.compilation_ref AND o.entry_title = e.title
          WHERE p.site_id = ?
          ORDER BY e.compilation_ref, e.position`
      )
      .all(self.site_id) as Array<{ compilation_ref: number; position: number; title: string; matches: string; override: string | null }>;
    // 作品 ID → それを収録している総集編
    const compilationsById = new Map<string, Set<number>>();
    const effective = rows.map((r) => {
      const matches = parseJson<CompilationMatchRef[]>(r.override ?? r.matches, []);
      for (const m of matches) {
        const set = compilationsById.get(m.productId) ?? new Set<number>();
        set.add(r.compilation_ref);
        compilationsById.set(m.productId, set);
      }
      return { ...r, manual: r.override !== null, list: matches };
    });

    const entries: CompilationEntryView[] = effective
      .filter((r) => r.compilation_ref === productRef)
      .map((r) => ({
        position: r.position,
        title: r.title,
        manual: r.manual,
        matches: r.list.map((m) => {
          const owned = ownedById.get(m.productId) ?? null;
          const alsoIn = [...(compilationsById.get(m.productId) ?? [])]
            .filter((ref) => ref !== productRef && byRef.has(ref))
            .map((ref) => brief(byRef.get(ref)!));
          return {
            ...m,
            owned: owned && owned.id !== productRef ? brief(owned) : null,
            ownedVia: owned && owned.id !== productRef ? (owned.parent_product_id ? 'set' : 'single') : null,
            alsoIn
          };
        })
      }));

    const containedIn = [...new Set([self.product_id, self.content_id].flatMap((key) => (key ? [...(compilationsById.get(key) ?? [])] : [])))]
      .filter((ref) => ref !== productRef && byRef.has(ref))
      .map((ref) => brief(byRef.get(ref)!));

    const store = catalogStoreOf({ siteId: self.site_id, floorId: self.floor_id, makerId: self.maker_id, detailUrl: self.detail_url });
    const catalog = store ? (this.catalogStatus(store.store, store.makerId) ?? { ...store, fetchedAt: null, count: 0, error: null }) : null;
    return { entries, containedIn, catalog };
  }

  /** 導線だけを入れ替える（動画の再生・ダウンロードの導線を取り直したときなど） */
  setLinks(productRef: number, links: ProductLink[], flags: { isDownloadable?: boolean; isStreaming?: boolean } = {}): void {
    this.db
      .prepare(
        `UPDATE products SET links = @links,
                is_downloadable = CASE WHEN @dl IS NULL THEN is_downloadable ELSE @dl END,
                is_streaming = CASE WHEN @st IS NULL THEN is_streaming ELSE @st END
          WHERE id = @id`
      )
      .run({
        id: productRef,
        links: JSON.stringify(links),
        dl: flags.isDownloadable === undefined ? null : flags.isDownloadable ? 1 : 0,
        st: flags.isStreaming === undefined ? null : flags.isStreaming ? 1 : 0
      });
  }

  /** セット商品の中身（購入履歴にセットの子として並んでいる作品）の ID */
  setChildIds(productRef: number): number[] {
    return this.db
      .prepare(
        `SELECT c.id FROM products s
           JOIN products c ON c.site_id = s.site_id AND c.floor_id = s.floor_id AND c.parent_product_id = s.product_id
          WHERE s.id = ? AND s.product_type = 'set'
          ORDER BY c.id`
      )
      .pluck()
      .all(productRef) as number[];
  }

  /** 紐付けに使っている相手（導入済みプログラムの Uninstall キー、DMM GAMES PLAYER のキー） */
  linkedKeys(): Set<string> {
    const rows = this.db
      .prepare("SELECT uninstall_key FROM installations WHERE uninstall_key IS NOT NULL AND state = 'installed'")
      .pluck()
      .all() as string[];
    return new Set(rows);
  }

  /** 「DMM GAMES PLAYER専用」の作品の数と、そのうち紐付け済みの数 */
  dgpOnlyCounts(): { dgpOnly: number; linked: number } {
    const row = this.db
      .prepare(
        `SELECT count(*) AS total, sum(CASE WHEN ${INSTALLED} THEN 1 ELSE 0 END) AS linked
           FROM products p WHERE p.tags LIKE '%DMM GAMES PLAYER専用%'`
      )
      .get() as { total: number; linked: number | null };
    return { dgpOnly: row.total, linked: row.linked ?? 0 };
  }

  /** 実体が消えたファイルに印を付ける（行は消さない） */
  markMissingFiles(check: (path: string) => boolean): number { return this.localFileStore.markMissingFiles(check); }

  /** markMissingFiles の非同期版（メインプロセスを止めないため、確認は並べて投げる） */
  async markMissingFilesAsync(check: (path: string) => Promise<boolean>): Promise<number> { return this.localFileStore.markMissingFilesAsync(check); }

  /** 作品ごとの「手元にあるか」。一覧のバッジ用 */
  productsWithFiles(): Set<number> { return this.localFileStore.productsWithFiles(); }

  /** お気に入りの登録・解除。付けた時刻を残すので「最近入れた順」も出せる */
  setFavorite(productRef: number, favorite: boolean, at = Date.now()): void {
    this.db
      .prepare('UPDATE products SET favorite_at = ? WHERE id = ?')
      .run(favorite ? at : null, productRef);
  }

  /** お気に入りの件数（サイドバーの表示用） */
  favoriteCount(): number {
    const row = this.db
      .prepare('SELECT count(*) AS c FROM products WHERE favorite_at IS NOT NULL')
      .get() as { c: number };
    return row.c;
  }

  /** 種別ごとの件数。他の絞り込みに連動する */
  workTypeCounts(filter: TagFilter = {}): Array<{ workType: string; count: number }> {
    const where: string[] = ['work_type IS NOT NULL'];
    const params: Record<string, unknown> = {};
    if (filter.categories?.length) {
      where.push(`category IN (${filter.categories.map((c, i) => ((params[`c${i}`] = c), `@c${i}`)).join(', ')})`);
    }
    if (filter.siteIds?.length) {
      where.push(`site_id IN (${filter.siteIds.map((s2, i) => ((params[`si${i}`] = s2), `@si${i}`)).join(', ')})`);
    }
    if (filter.makers?.length) {
      where.push(`maker IN (${filter.makers.map((m, i) => ((params[`mk${i}`] = m), `@mk${i}`)).join(', ')})`);
    }
    for (const [i, tag] of (filter.tags ?? []).entries()) {
      params[`tag${i}`] = tag;
      where.push(`EXISTS (SELECT 1 FROM json_each(products.tags) x WHERE x.value = @tag${i})`);
    }
    for (const [i, name] of (filter.creators ?? []).entries()) {
      params[`cr${i}`] = name;
      where.push(
        `EXISTS (SELECT 1 FROM json_each(products.creators) jc WHERE jc.value ->> '$.name' = @cr${i})`
      );
    }
    const rows = this.db
      .prepare(
        `SELECT work_type AS workType, count(*) AS c FROM products
          WHERE ${where.join(' AND ')} GROUP BY work_type ORDER BY c DESC`
      )
      .all(params) as Array<{ workType: string; c: number }>;
    return rows.map((r) => ({ workType: r.workType, count: r.c }));
  }

  /**
   * タグの一覧と件数。区分・購入サイト・選択中のタグの中だけで数えるので、
   * 絞り込むほど「その中で共起するタグ」だけが残る。
   */
  tags(filter: TagFilter = {}): Array<{ tag: string; count: number }> {
    const where: string[] = ["jt.value <> ''"];
    const params: Record<string, unknown> = {};
    if (filter.floors && filter.floors.length) {
      const clauses = filter.floors.map((f, i) => {
        const [site, floor] = f.split(':');
        params[`s${i}`] = site;
        params[`f${i}`] = floor;
        return `(p.site_id=@s${i} AND p.floor_id=@f${i})`;
      });
      where.push(`(${clauses.join(' OR ')})`);
    }
    if (filter.categories && filter.categories.length) {
      const keys = filter.categories.map((cat, i) => {
        params[`c${i}`] = cat;
        return `@c${i}`;
      });
      where.push(`p.category IN (${keys.join(', ')})`);
    }
    if (filter.siteIds && filter.siteIds.length) {
      const keys = filter.siteIds.map((site, i) => {
        params[`si${i}`] = site;
        return `@si${i}`;
      });
      where.push(`p.site_id IN (${keys.join(', ')})`);
    }
    for (const [i, tag] of (filter.tags ?? []).entries()) {
      params[`tag${i}`] = tag;
      where.push(`EXISTS (SELECT 1 FROM json_each(p.tags) x WHERE x.value = @tag${i})`);
    }
    // 選択中のブランドに連動させる（そのブランドの作品が持つタグだけ出す）
    if (filter.makers && filter.makers.length) {
      const keys = filter.makers.map((maker, i) => {
        params[`mk${i}`] = maker;
        return `@mk${i}`;
      });
      where.push(`p.maker IN (${keys.join(', ')})`);
    }
    const rows = this.db
      .prepare(
        `SELECT jt.value AS tag, count(*) AS c
           FROM products p, json_each(p.tags) jt
          WHERE ${where.join(' AND ')}
          GROUP BY jt.value
          ORDER BY c DESC, jt.value ASC`
      )
      .all(params) as Array<{ tag: string; c: number }>;
    return rows.map((r) => ({ tag: r.tag, count: r.c }));
  }

  /**
   * 差分同期用。すでに持っている作品IDと、そのうち操作リンクまで埋まっているIDを返す。
   * 一覧APIは購入日の新しい順に並ぶので、「そのページが全部これに含まれていたら
   * それ以降は既知」とみなして打ち切れる。
   */
  syncState(
    siteId: string,
    floorId: string
  ): { ids: Set<string>; withLinks: Set<string>; withSerial: Set<string> } {
    const rows = this.db
      .prepare(
        `SELECT product_id, links, serial_key FROM products WHERE site_id = ? AND floor_id = ?`
      )
      .all(siteId, floorId) as Array<{
      product_id: string;
      links: string | null;
      serial_key: string | null;
    }>;
    const ids = new Set<string>();
    const withLinks = new Set<string>();
    const withSerial = new Set<string>();
    for (const r of rows) {
      ids.add(r.product_id);
      if (r.links && r.links !== '[]') withLinks.add(r.product_id);
      if (r.serial_key) withSerial.add(r.product_id);
    }
    return { ids, withLinks, withSerial };
  }

  /**
   * バックグラウンドで詳細を取る対象を1件。購入日の新しい順＝ユーザーが見る可能性が高い順。
   * 何度も失敗する作品（販売終了など）で止まらないよう、試行回数で足切りする。
   */
  /** 並列取得用に候補を複数返す。呼び出し側が取りかかり中のぶんを避けて選ぶ */
  nextMetaTargets(
    maxAttempts = 3,
    siteIds: string[] = [],
    limit = 1
  ): Array<{ id: number; title: string }> {
    if (siteIds.length === 0) return [];
    const keys = siteIds.map((_, i) => `@s${i}`).join(', ');
    const params: Record<string, unknown> = { maxAttempts, limit: Math.max(1, limit) };
    siteIds.forEach((id, i) => (params[`s${i}`] = id));
    return this.db
      .prepare(
        `SELECT id, title FROM products
          WHERE meta_fetched_at IS NULL AND meta_attempts < @maxAttempts
            AND site_id IN (${keys})
          ORDER BY purchased_at IS NULL, purchased_at DESC, id DESC
          LIMIT @limit`
      )
      .all(params) as Array<{ id: number; title: string }>;
  }

  nextMetaTarget(maxAttempts = 3, siteIds: string[] = []): { id: number; title: string } | null {
    // ログインしていないサイトの作品を選ぶと、失敗して試行回数だけ減ってしまう。
    // 取りに行けるサイトに限って選ぶ。
    if (siteIds.length === 0) return null;
    const keys = siteIds.map((_, i) => `@s${i}`).join(', ');
    const params: Record<string, unknown> = { maxAttempts };
    siteIds.forEach((id, i) => (params[`s${i}`] = id));
    const row = this.db
      .prepare(
        `SELECT id, title FROM products
          WHERE meta_fetched_at IS NULL AND meta_attempts < @maxAttempts
            AND site_id IN (${keys})
          ORDER BY purchased_at IS NULL, purchased_at DESC, id DESC
          LIMIT 1`
      )
      .get(params) as { id: number; title: string } | undefined;
    return row ?? null;
  }

  /**
   * 詳細が未取得の残り件数（打ち切ったものは数えない）。
   * siteIds を渡すと、そのサイトぶんだけ数える（＝いま実際に取りに行ける件数）。
   */
  metaPendingCount(maxAttempts = 3, siteIds?: string[]): number {
    if (!siteIds) {
      const row = this.db
        .prepare(
          'SELECT count(*) AS c FROM products WHERE meta_fetched_at IS NULL AND meta_attempts < ?'
        )
        .get(maxAttempts) as { c: number };
      return row.c;
    }
    if (siteIds.length === 0) return 0;
    const keys = siteIds.map((_, i) => `@s${i}`).join(', ');
    const params: Record<string, unknown> = { maxAttempts };
    siteIds.forEach((id, i) => (params[`s${i}`] = id));
    const row = this.db
      .prepare(
        `SELECT count(*) AS c FROM products
          WHERE meta_fetched_at IS NULL AND meta_attempts < @maxAttempts
            AND site_id IN (${keys})`
      )
      .get(params) as { c: number };
    return row.c;
  }

  /**
   * 失敗回数をリセットする。ログインし直したときに呼ぶ。
   * 未ログインが原因で打ち切られた作品を、もう一度対象に戻すため。
   */
  resetMetaAttempts(siteId: string): void {
    this.db
      .prepare('UPDATE products SET meta_attempts = 0 WHERE site_id = ? AND meta_fetched_at IS NULL')
      .run(siteId);
  }

  /** 取得に失敗した回数を1つ進める */
  bumpMetaAttempt(productRef: number): void {
    this.db
      .prepare('UPDATE products SET meta_attempts = meta_attempts + 1 WHERE id = ?')
      .run(productRef);
  }

  /** 作品メタを取り切ったことを記録する（次に開いたときは取りに行かない） */
  markMetaFetched(productRef: number, at = Date.now()): void {
    this.db
      .prepare('UPDATE products SET meta_fetched_at = ?, meta_attempts = 0 WHERE id = ?')
      .run(at, productRef);
  }

  setCoverFile(productRef: number, file: string): void {
    this.db.prepare('UPDATE products SET cover_file = ? WHERE id = ?').run(file, productRef);
  }

  productsMissingCover(limit: number): Array<{ id: number; cover_url: string }> {
    return this.db
      .prepare(
        `SELECT id, cover_url FROM products
         WHERE cover_file IS NULL AND cover_url IS NOT NULL AND cover_url <> '' LIMIT ?`
      )
      .all(limit) as Array<{ id: number; cover_url: string }>;
  }

  getSetting(key: string): string | null { return this.settingsHistory.getSetting(key); }
  setSetting(key: string, value: string): void { this.settingsHistory.setSetting(key, value); }
  startSyncRun(siteId: string): number { return this.settingsHistory.startSyncRun(siteId); }
  finishSyncRun(id: number, status: string, detail: unknown): void { this.settingsHistory.finishSyncRun(id, status, detail); }
  lastSuccessfulSyncAt(): number | null { return this.settingsHistory.lastSuccessfulSyncAt(); }
  syncHistory(): import('@shared/types').SyncHistoryEntry[] { return this.settingsHistory.syncHistory(); }

}

const JOB_SELECT = `SELECT j.id, j.product_ref, p.title, j.kind, j.source, j.target, j.state, j.progress,
       j.message, j.error, j.result, j.auto, j.options, j.created_at, j.updated_at
  FROM jobs j LEFT JOIN products p ON p.id = j.product_ref`;

interface JobRaw {
  id: number;
  product_ref: number | null;
  title: string | null;
  kind: string;
  source: string;
  target: string | null;
  state: string;
  progress: number;
  message: string | null;
  error: string | null;
  result: string | null;
  auto: number;
  options: string | null;
  created_at: number;
  updated_at: number;
}

function safeJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toJob(r: JobRaw): JobRow {
  return {
    id: r.id,
    productRef: r.product_ref,
    title: r.title,
    kind: r.kind as JobKind,
    source: r.source,
    target: r.target,
    state: r.state as JobState,
    progress: r.progress,
    message: r.message,
    error: r.error,
    result: safeJson(r.result) as JobResult | null,
    auto: !!r.auto,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}
