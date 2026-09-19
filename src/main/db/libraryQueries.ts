import type { DB } from './database';
import type { LibraryQuery, LibraryPage, SearchField, Product } from '@shared/types';
import { HAVE, NEEDS_INSTALL, INSTALLED, LINKABLE, BROKEN, IN_COMPILATION, SELECT_COLUMNS, toProduct, type ProductRow } from './productRows';

export class LibraryQueryStore {
  constructor(private db: DB) {}

  /** 絞り込みに合う作品すべての ID（読み込み済みのページだけでなく、続きも含む） */
  queryLibraryIds(q: LibraryQuery): number[] {
    return this.queryLibrary({ ...q, limit: 1_000_000, offset: 0 }).items.map((p) => p.id);
  }

  queryLibrary(q: LibraryQuery): LibraryPage {
    const where: string[] = [];
    const params: Record<string, unknown> = {};

    if (q.floors && q.floors.length > 0) {
      const clauses = q.floors.map((f, i) => {
        const [siteId, floorId] = f.split(':');
        params[`s${i}`] = siteId;
        params[`f${i}`] = floorId;
        return `(p.site_id=@s${i} AND p.floor_id=@f${i})`;
      });
      where.push(`(${clauses.join(' OR ')})`);
    }
    if (q.categories && q.categories.length > 0) {
      const keys = q.categories.map((cat, i) => {
        params[`c${i}`] = cat;
        return `@c${i}`;
      });
      where.push(`p.category IN (${keys.join(', ')})`);
    }
    if (q.siteIds && q.siteIds.length > 0) {
      const keys = q.siteIds.map((site, i) => {
        params[`si${i}`] = site;
        return `@si${i}`;
      });
      where.push(`p.site_id IN (${keys.join(', ')})`);
    }
    // 1作品につきブランドは1つなので、複数選択は OR（どれかに一致）
    if (q.makers && q.makers.length > 0) {
      const keys = q.makers.map((maker, i) => {
        params[`mk${i}`] = maker;
        return `@mk${i}`;
      });
      where.push(`p.maker IN (${keys.join(', ')})`);
    }
    if (q.workTypes && q.workTypes.length > 0) {
      const keys = q.workTypes.map((wt, i) => {
        params[`wt${i}`] = wt;
        return `@wt${i}`;
      });
      where.push(`p.work_type IN (${keys.join(', ')})`);
    }
    // 人・シリーズ。役割は問わず名前で一致させる。複数指定は AND（全員が関わっている作品）
    for (const [i, name] of (q.creators ?? []).entries()) {
      params[`cr${i}`] = name;
      where.push(
        `EXISTS (SELECT 1 FROM json_each(p.creators) jc WHERE jc.value ->> '$.name' = @cr${i})`
      );
    }
    // タグはJSON配列で持っているので json_each で展開して突き合わせる。
    // 複数指定は AND（指定タグをすべて持つ作品だけ）。
    for (const [i, tag] of (q.tags ?? []).entries()) {
      params[`tag${i}`] = tag;
      where.push(
        `EXISTS (SELECT 1 FROM json_each(p.tags) jt WHERE jt.value = @tag${i})`
      );
    }
    if (q.hideSetParents) {
      where.push("p.product_type IS NOT 'set'");
    }
    if (q.favoriteOnly) {
      where.push('p.favorite_at IS NOT NULL');
    }
    if (q.localState) {
      where.push(
        q.localState === 'have'
          ? HAVE
          : q.localState === 'notInstalled'
            ? `(${NEEDS_INSTALL})`
            : q.localState === 'installed'
              ? INSTALLED
              : q.localState === 'linkable'
              ? LINKABLE
              : q.localState === 'broken'
              ? BROKEN
              : `NOT ${HAVE}`
      );
    }
    if (q.installedOnly) {
      where.push("i.id IS NOT NULL AND i.state = 'installed'");
    }

    const search = (q.search ?? '').trim();
    const from = 'FROM products p LEFT JOIN installations i ON i.product_ref = p.id';
    let regexError: string | null = null;

    // 検索対象。既定はタイトルとブランドで、説明文・作品ID・人を足せる。
    const fields: SearchField[] = q.searchFields?.length ? q.searchFields : ['title', 'maker'];
    const columnOf: Record<SearchField, string> = {
      title: 'p.title',
      maker: "coalesce(p.maker, '')",
      description: "coalesce(p.description, '')",
      productId: "p.product_id || ' ' || coalesce(p.content_id, '')",
      creators: "p.creators || ' ' || p.authors"
    };
    const searchColumns = fields.map((f) => columnOf[f]);
    // 全文検索の索引はタイトル/ブランド/作者/タグしか持っていないので、
    // 説明文や作品IDを対象に入れたときは総当たりに切り替える。
    const ftsUsable = fields.every((f) => f === 'title' || f === 'maker');

    if (q.useRegex && search.length > 0) {
      // 正規表現モードは索引が使えないので総当たり。
      // 不正なパターンで落とさないよう、組み立てられるか確かめてから渡す。
      try {
        new RegExp(search);
        const extra = fields.includes('title') ? ['p.tags'] : [];
        where.push(`(${[...searchColumns, ...extra].map((c) => `${c} REGEXP @re`).join(' OR ')})`);
        params.re = search;
      } catch (err) {
        regexError = err instanceof Error ? err.message : String(err);
        where.push('0'); // 直せるまでは0件にする
      }
    } else if (!ftsUsable && search.length > 0) {
      where.push(`(${[...searchColumns.map((c) => `${c} LIKE @like`), ...(fields.includes('title') ? [IN_COMPILATION] : [])].join(' OR ')})`);
      params.like = `%${search}%`;
    } else if (search.length >= 3) {
      // trigram トークナイザは3文字以上でのみ索引が効く。収録作品のタイトルでも総集編を拾うので、索引は IN で引く
      where.push(`(p.id IN (SELECT rowid FROM products_fts WHERE products_fts MATCH @ftsq) OR ${IN_COMPILATION})`);
      params.ftsq = `"${search.replace(/"/g, '""')}"`;
      params.like = `%${search}%`;
    } else if (search.length > 0) {
      where.push(`(p.title LIKE @like OR p.maker LIKE @like OR ${IN_COMPILATION})`);
      params.like = `%${search}%`;
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT count(*) AS c ${from} ${whereSql}`).get(params) as {
      c: number;
    };

    // 値が無い行（購入日/発売日が取れていない等）は向きによらず常に最後に置く
    const columns: Record<string, string> = {
      purchased: 'p.purchased_at',
      released: 'p.released_at',
      title: 'p.title',
      maker: 'p.maker',
      // ゲーム・ツールは起動した日時、それ以外は中身を見た日時。どちらも「使った」ので新しい方で並べる
      used: 'NULLIF(max(coalesce(i.last_launched_at, 0), coalesce(p.viewed_at, 0)), 0)'
    };
    const column = columns[q.sortKey ?? 'purchased'] ?? columns.purchased;
    const dir = q.sortDir === 'asc' ? 'ASC' : 'DESC';
    const order = `${column} IS NULL, ${column} ${dir}, p.id ${dir}`;

    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} ${from} ${whereSql} ORDER BY ${order} LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit: q.limit ?? 200, offset: q.offset ?? 0 }) as ProductRow[];

    return { items: rows.map(toProduct), total: total.c, regexError };
  }

  getProduct(id: number): Product | null {
    const row = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM products p
         LEFT JOIN installations i ON i.product_ref = p.id WHERE p.id = ?`
      )
      .get(id) as ProductRow | undefined;
    return row ? toProduct(row) : null;
  }
}
