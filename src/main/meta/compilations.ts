import type { CompilationMaterial, Repo } from '../db/repo';
import type { CompilationCandidate, CompilationMatchRef } from '@shared/types';
import {
  entrySimilarity,
  isCompilationLike,
  matchCompilationEntries,
  parseCompilationEntries,
  titleCore,
  type PoolItem
} from '@shared/compilation';
import { catalogStoreOf, type CatalogItem, type CatalogStore } from '../sites/catalogParse';
import { fetchMakerCatalog } from '../sites/catalog';
import { htmlToText } from '@shared/htmlText';

/** 同人・CG などの総集編の収録作品を、説明文から推定するか（'1' で推定する。既定はしない） */
export const COMPILATION_GUESS_SETTING = 'compilation.guess';

/**
 * 推定しなくても収録作品が分かる作品か。
 * - セット商品で、中身が購入履歴に並んでいるもの
 * - PCゲーム（DMM の dlsoft）のセット商品（タグ「セット商品」・セット販売）。説明文の一覧がはっきりしていて、ブランドの作品一覧で確かめられる
 */
export function isClearCompilation(p: CompilationMaterial, hasChildren: boolean): boolean {
  if (p.productType === 'set' && hasChildren) return true;
  return p.siteId === 'dmm' && p.floorId === 'dlsoft';
}

/** サークルの作品一覧を取り直すまでの日数（新作が増えるので、ときどき取り直す） */
export const CATALOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** 取れなかった一覧を、もう一度試すまで */
export const CATALOG_RETRY_MS = 24 * 60 * 60 * 1000;

export interface CatalogKey {
  store: CatalogStore;
  makerId: string;
}

export interface CompilationBuild {
  results: Map<number, Array<{ position: number; title: string; matches: CompilationMatchRef[] }>>;
  /** 一覧が無い・古いので取りに行きたいサークル */
  needed: CatalogKey[];
}

/**
 * 全作品から総集編・セットの収録作品を組み立てる（通信しない）。
 * - セット商品で、中身が購入履歴に並んでいる（parent_product_id）ものは、その中身を収録作品にする
 * - それ以外は説明文の一覧を読み、同じサイトの同じサークルの作品一覧（未購入を含む）と照らし合わせる。
 *   一覧がまだ無いときは、手元にある同じサークルの作品で照らし合わせ、一覧を取りに行く対象に入れる
 * @param catalogOf 作り置きの一覧（無ければ items: null）と、取り直す時期か
 */
export function buildCompilations(
  material: CompilationMaterial[],
  catalogOf: (key: CatalogKey) => { items: CatalogItem[] | null; stale: boolean },
  /** false なら、推定しなくても分かるもの（isClearCompilation）だけ */
  guess = true
): CompilationBuild {
  const results: CompilationBuild['results'] = new Map();
  const needed = new Map<string, CatalogKey>();
  const childrenOf = new Map<string, CompilationMaterial[]>();
  for (const m of material) {
    if (!m.parentProductId) continue;
    const key = `${m.siteId}|${m.floorId}|${m.parentProductId}`;
    childrenOf.set(key, [...(childrenOf.get(key) ?? []), m]);
  }

  for (const p of material) {
    const children = childrenOf.get(`${p.siteId}|${p.floorId}|${p.productId}`) ?? [];
    if (p.productType === 'set' && children.length > 0) {
      results.set(
        p.id,
        children.map((c, i) => ({
          position: i + 1,
          title: c.title,
          matches: [{ productId: c.productId, title: c.title, url: c.detailUrl, score: 1 }]
        }))
      );
      continue;
    }
    if (!guess && !isClearCompilation(p, children.length > 0)) continue;
    if (!p.description || !isCompilationLike({ ...p, description: htmlToText(p.description) })) continue;

    const key = catalogStoreOf(p);
    const catalog = key ? catalogOf(key) : { items: null, stale: false };
    if (key && (catalog.items === null || catalog.stale)) needed.set(`${key.store}|${key.makerId}`, key);

    const refs = new Map<string, CompilationMatchRef>();
    const pool: PoolItem[] = [];
    const add = (productId: string, title: string, url: string | null): void => {
      if (productId === p.productId || productId === p.contentId || refs.has(productId)) return;
      refs.set(productId, { productId, title, url, score: null });
      pool.push({ key: productId, title, sameMaker: true });
    };
    for (const item of catalog.items ?? []) add(item.productId, item.title, item.url);
    // 一覧に無い（販売終了など）手元の作品も、同じサークルなら相手にする
    for (const m of material) {
      if (m.siteId !== p.siteId || m.id === p.id) continue;
      const sameMaker = p.makerId ? m.makerId === p.makerId : !!p.maker && m.maker === p.maker;
      if (sameMaker) add(m.productId, m.title, m.detailUrl);
    }

    const matched = matchCompilationEntries(parseCompilationEntries(htmlToText(p.description)), pool);
    if (matched.length < 2) continue;
    results.set(
      p.id,
      matched.map((e) => ({
        position: e.position,
        title: e.title,
        matches: e.matches.map((m) => ({ ...refs.get(m.key)!, score: m.score }))
      }))
    );
  }
  return { results, needed: [...needed.values()] };
}

/** 作り置きの一覧を引く（無ければ null、取り直す時期なら stale） */
export function cachedCatalog(repo: Repo, key: CatalogKey, now = Date.now()): { items: CatalogItem[] | null; stale: boolean } {
  const status = repo.catalogStatus(key.store, key.makerId);
  if (!status) return { items: null, stale: true };
  const age = now - (status.fetchedAt ?? 0);
  return { items: repo.catalogItems(key.store, key.makerId), stale: age > (status.error ? CATALOG_RETRY_MS : CATALOG_MAX_AGE_MS) };
}

/** 収録作品を組み立て直して保存する（通信しない） */
export async function refreshCompilations(repo: Repo): Promise<{ count: number; needed: CatalogKey[] }> {
  const material = repo.compilationMaterial();
  await new Promise((r) => setImmediate(r));
  const guess = repo.getSetting(COMPILATION_GUESS_SETTING) === '1';
  const { results, needed } = buildCompilations(material, (key) => cachedCatalog(repo, key), guess);
  repo.replaceCompilations(results);
  return { count: results.size, needed };
}

/** サークルの作品一覧を取り、作り置きする。取れなければ失敗を記録する */
export async function updateCatalog(repo: Repo, key: CatalogKey): Promise<number> {
  try {
    const items = await fetchMakerCatalog(key.store, key.makerId);
    repo.saveCatalog(key.store, key.makerId, { items });
    return items.length;
  } catch (err) {
    repo.saveCatalog(key.store, key.makerId, { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/** 手で選び直すときの候補。サークルの作品一覧と手元の同じサークルの作品を、タイトルの近い順に */
export function compilationCandidates(repo: Repo, compilationRef: number, entryTitle: string, limit = 10): CompilationCandidate[] {
  const material = repo.compilationMaterial();
  const self = material.find((m) => m.id === compilationRef);
  if (!self) return [];
  const ownedIds = new Set(material.filter((m) => m.siteId === self.siteId).flatMap((m) => [m.productId, m.contentId ?? '']));
  const key = catalogStoreOf(self);
  const pool = new Map<string, CompilationMatchRef>();
  for (const item of key ? repo.catalogItems(key.store, key.makerId) : []) {
    pool.set(item.productId, { productId: item.productId, title: item.title, url: item.url, score: null });
  }
  for (const m of material) {
    if (m.siteId !== self.siteId || pool.has(m.productId)) continue;
    const sameMaker = self.makerId ? m.makerId === self.makerId : !!self.maker && m.maker === self.maker;
    if (sameMaker) pool.set(m.productId, { productId: m.productId, title: m.title, url: m.detailUrl, score: null });
  }
  const core = titleCore(entryTitle);
  return [...pool.values()]
    .filter((c) => c.productId !== self.productId && c.productId !== self.contentId)
    .map((c) => ({ ...c, score: Math.round(entrySimilarity(core, titleCore(c.title)) * 100) / 100, owned: ownedIds.has(c.productId) }))
    .filter((c) => c.score >= 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** 総集編の作品から、一覧を取るサークルを引く */
export function catalogKeyOf(repo: Repo, compilationRef: number): CatalogKey | null {
  const self = repo.compilationMaterial().find((m) => m.id === compilationRef);
  return self ? catalogStoreOf(self) : null;
}
