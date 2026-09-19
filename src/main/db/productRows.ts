import type { Category, Creator, ProductLink, VolumeSet, Product, WorkType, Installation, LinkCandidate } from '@shared/types';


/** JSON の列を読む。壊れていたら fallback */
export function parseJson<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
export interface ProductRow {
  id: number;
  site_id: string;
  floor_id: string;
  category: string | null;
  work_type: string | null;
  favorite_at: number | null;
  has_local: number;
  needs_install: number;
  is_compilation: number;
  product_id: string;
  content_id: string | null;
  title: string;
  maker: string | null;
  maker_id: string | null;
  authors: string;
  genre: string | null;
  product_type: string | null;
  purchased_at: string | null;
  purchased_at_source: string | null;
  meta_fetched_at: number | null;
  links: string;
  serial_key: string | null;
  price_text: string | null;
  volumes: string | null;
  released_at: string | null;
  description: string | null;
  creators: string;
  parent_product_id: string | null;
  cover_url: string | null;
  cover_file: string | null;
  detail_url: string | null;
  file_size_text: string | null;
  file_size_bytes: number | null;
  is_downloadable: number;
  is_streaming: number;
  is_unavailable: number;
  has_drm: number;
  tags: string;
  first_seen_at: number;
  last_synced_at: number;
  inst_id: number | null;
  viewed_at: number | null;
  link_candidate: string | null;
  inst_kind: string | null;
  inst_install_path: string | null;
  inst_executable_path: string | null;
  inst_uninstall_key: string | null;
  inst_display_name: string | null;
  inst_version: string | null;
  inst_state: string | null;
  inst_linked_at: number | null;
  inst_last_launched_at: number | null;
  inst_notes: string | null;
}

/**
 * 「ダウンロード済み・未インストール」: 手元にファイルがあり、展開して使う種別（ゲーム・ツール、
 * PCゲーム区分で種別不明）で、起動の紐付けがまだのもの。
 * DLsite の VJ（PCゲーム区分）にはボイスなども入るので、区分ではなく種別で見る。
 */
export const INSTALLED = `EXISTS (SELECT 1 FROM installations ins WHERE ins.product_ref = p.id AND ins.state = 'installed')`;
/** 紐付けたのに、起動ファイルやインストール先・DMM GAMES PLAYER のゲームが見つからなくなったもの（アンインストール・移動） */
export const BROKEN = `EXISTS (SELECT 1 FROM installations ins WHERE ins.product_ref = p.id AND ins.state = 'broken')`;
export const HAS_FILE = `EXISTS (SELECT 1 FROM local_files lf WHERE lf.product_ref = p.id AND lf.missing_at IS NULL)`;
/** 紐付けの候補がある（まだ紐付けていない）もの。未インストールとは分けて数える */
export const LINKABLE = `(p.link_candidate IS NOT NULL AND NOT ${INSTALLED})`;
/**
 * 「ダウンロード済み」: 手元にファイルがある、または起動の紐付けが済んでいる
 * （DMM GAMES PLAYER や既存の導入先と紐付けた作品は、アプリ経由のファイルが無くても手元にある）。
 */
export const HAVE = `(${HAS_FILE} OR ${INSTALLED})`;
export const NEEDS_INSTALL = `${HAS_FILE}
  AND (p.work_type IN ('game', 'tool') OR (p.category = 'game' AND (p.work_type IS NULL OR p.work_type = 'other')))
  AND NOT ${INSTALLED}
  AND NOT ${BROKEN}
  AND p.link_candidate IS NULL`;

/**
 * 検索語が総集編・セットの収録作品のタイトル（説明文から読んだもの・一覧で見つけた作品名）に当たるか。
 * 単独では持っていない作品を検索したときに、それを収録した総集編が出るようにする。@like を使う
 */
export const IN_COMPILATION = `p.id IN (
  SELECT e.compilation_ref FROM compilation_entries e
    LEFT JOIN compilation_overrides o ON o.compilation_ref = e.compilation_ref AND o.entry_title = e.title
   WHERE e.title LIKE @like OR coalesce(o.matches, e.matches) LIKE @like)`;

export const SELECT_COLUMNS = `
  p.id, p.site_id, p.floor_id, p.category, p.work_type, p.favorite_at, p.viewed_at, p.link_candidate,
  EXISTS (SELECT 1 FROM local_files lf WHERE lf.product_ref = p.id AND lf.missing_at IS NULL) AS has_local,
  (${NEEDS_INSTALL}) AS needs_install,
  EXISTS (SELECT 1 FROM compilation_entries ce WHERE ce.compilation_ref = p.id) AS is_compilation,
  p.product_id, p.content_id, p.title, p.maker, p.maker_id,
  p.authors, p.genre, p.product_type, p.purchased_at, p.purchased_at_source,
  p.released_at, p.description, p.creators, p.parent_product_id, p.meta_fetched_at, p.links, p.serial_key, p.price_text, p.volumes, p.cover_url,
  p.cover_file, p.detail_url,
  p.file_size_text, p.file_size_bytes, p.is_downloadable, p.is_streaming, p.is_unavailable,
  p.has_drm, p.tags, p.first_seen_at, p.last_synced_at,
  i.id AS inst_id, i.kind AS inst_kind, i.install_path AS inst_install_path,
  i.executable_path AS inst_executable_path, i.uninstall_key AS inst_uninstall_key,
  i.display_name AS inst_display_name, i.version AS inst_version, i.state AS inst_state,
  i.linked_at AS inst_linked_at, i.last_launched_at AS inst_last_launched_at, i.notes AS inst_notes
`;

export function safeArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function safeCreators(json: string | null): Creator[] {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v)
      ? v
          .filter((c) => c && typeof c.name === 'string')
          .map((c) => ({ role: String(c.role ?? ''), name: String(c.name), id: c.id ?? null }))
      : [];
  } catch {
    return [];
  }
}

/** 区分が指定されていない古い呼び出し向けの推定。DMMのフロア名から決める */
export function categoryOfFloor(floorId: string): Category {
  if (floorId === 'dlsoft') return 'game';
  if (floorId === 'doujin') return 'doujin';
  if (floorId === 'book') return 'book';
  if (floorId === 'video') return 'video';
  return 'other';
}

/**
 * 作品の種別を genre から決める。サイトで呼び方が違う（DMM「コミック」/ DLsite「マンガ」、
 * DMM「CG」/ DLsite「CG・イラスト」）ので、ここで1つに揃える。
 * マイグレーション v17 の CASE と同じ規則にしてある。
 */
export function workTypeOf(genre: string | null | undefined, category: Category): WorkType | null {
  const g = (genre ?? '').trim();
  // genre に表示名ではなくコードが入っていることがある
  // （DMM PCゲーム=Apcgame、DMM動画=AV/AMATEUR、DLsite=MNG/ICG/SOU/MOV/RPG…）
  const CODES: Record<string, WorkType> = {
    MNG: 'manga',
    ICG: 'cg',
    SOU: 'voice',
    MOV: 'video',
    MUS: 'music',
    TOL: 'tool',
    NRE: 'novel',
    ADV: 'game',
    RPG: 'game',
    SLN: 'game',
    ACN: 'game',
    STG: 'game',
    QIZ: 'game',
    TBL: 'game',
    PZL: 'game',
    TYP: 'game',
    DNV: 'game'
  };
  if (CODES[g]) return CODES[g];
  if (g) {
    if (g.includes('コミック') || g.includes('マンガ')) return 'manga';
    if (g.startsWith('CG') || g.includes('イラスト')) return 'cg';
    if (g.includes('ボイス') || g.includes('ASMR')) return 'voice';
    if (g.includes('動画')) return 'video';
    if (
      g.includes('ゲーム') ||
      ['ロールプレイング', 'アドベンチャー', 'シミュレーション', 'アクション', 'クイズ',
       'テーブル', 'TBL', 'パズル', 'シューティング', 'タイピング', 'デジタルノベル'].includes(g)
    ) {
      return 'game';
    }
    if (g.includes('小説') || g.includes('ノベル')) return 'novel';
    if (g.includes('音楽')) return 'music';
    if (g.includes('ツール') || g.includes('アクセサリ')) return 'tool';
    // 判定しきれないときは区分に落とす（PCゲームは全部ゲーム、動画は全部動画）
    if (category === 'game') return 'game';
    if (category === 'video') return 'video';
    return 'other';
  }
  // 種別が無いフロアは区分がそのまま種別になる
  if (category === 'game') return 'game';
  if (category === 'video') return 'video';
  if (category === 'book') return 'manga';
  return null;
}

export function safeLinks(json: string | null): ProductLink[] {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v)
      ? v.filter((l) => l && typeof l.url === 'string' && typeof l.label === 'string')
      : [];
  } catch {
    return [];
  }
}

/** 巻一覧は形が崩れていたら「無い」扱いにする（表示のために落ちないことを優先） */
export function safeVolumes(json: string | null): VolumeSet | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as VolumeSet;
    if (!v || !Array.isArray(v.owned)) return null;
    return { totalCount: typeof v.totalCount === 'number' ? v.totalCount : null, owned: v.owned };
  } catch {
    return null;
  }
}

export function toProduct(row: ProductRow): Product {
  const installation: Installation | null =
    row.inst_id === null
      ? null
      : {
          id: row.inst_id,
          productRef: row.id,
          kind: row.inst_kind as Installation['kind'],
          installPath: row.inst_install_path,
          executablePath: row.inst_executable_path,
          uninstallKey: row.inst_uninstall_key,
          displayName: row.inst_display_name,
          version: row.inst_version,
          state: (row.inst_state ?? 'not_installed') as Installation['state'],
          linkedAt: row.inst_linked_at ?? 0,
          lastLaunchedAt: row.inst_last_launched_at,
          notes: row.inst_notes
        };
  return {
    id: row.id,
    siteId: row.site_id as Product['siteId'],
    floorId: row.floor_id,
    category: (row.category as Category) ?? 'other',
    workType: (row.work_type as WorkType) ?? null,
    favoriteAt: row.favorite_at,
    viewedAt: row.viewed_at,
    hasLocalFile: !!row.has_local,
    needsInstall: !!row.needs_install,
    isCompilation: !!row.is_compilation,
    linkCandidate: parseJson<LinkCandidate | null>(row.link_candidate, null),
    productId: row.product_id,
    contentId: row.content_id,
    title: row.title,
    maker: row.maker,
    makerId: row.maker_id,
    authors: safeArray(row.authors),
    genre: row.genre,
    productType: row.product_type,
    purchasedAt: row.purchased_at,
    purchasedAtSource: (row.purchased_at_source as Product['purchasedAtSource']) ?? null,
    releasedAt: row.released_at,
    description: row.description,
    creators: safeCreators(row.creators),
    parentProductId: row.parent_product_id,
    metaFetchedAt: row.meta_fetched_at,
    links: safeLinks(row.links),
    serialKey: row.serial_key,
    priceText: row.price_text,
    volumes: safeVolumes(row.volumes),
    coverUrl: row.cover_url,
    coverPath: row.cover_file,
    detailUrl: row.detail_url,
    fileSizeText: row.file_size_text,
    fileSizeBytes: row.file_size_bytes,
    isDownloadable: !!row.is_downloadable,
    isStreaming: !!row.is_streaming,
    isUnavailable: !!row.is_unavailable,
    hasDrm: !!row.has_drm,
    tags: safeArray(row.tags),
    firstSeenAt: row.first_seen_at,
    lastSyncedAt: row.last_synced_at,
    installation
  };
}

