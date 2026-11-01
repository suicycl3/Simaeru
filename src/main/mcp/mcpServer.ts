import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { CATEGORY_LABELS, WORK_TYPE_LABELS, type Category, type LibraryQuery, type McpStatus, type Product, type SortKey, type WorkType } from '@shared/types';
import { buildPurchaseStats, type StatsFilter } from '@shared/purchaseStats';
import { dictionaryOf, isAttributeTag, parseTagOverrides, type TagRuleOverrides } from '@shared/tagRules';
import { APP_NAME } from '@shared/appInfo';
import type { Repo } from '../db/repo';
import type { DownloadManager } from '../download/downloadManager';
import type { MetaCrawlerStatus } from '../meta/metaCrawler';
import { knownBlurbTags } from '../stats/blurbTags';

/**
 * MCP サーバー。AI のアプリ（Claude Code・Claude Desktop など）から、ライブラリを調べたり操作したりできる。
 *
 * - 待ち受けるのは **この PC の中だけ**（127.0.0.1）。設定でオンにしたときだけ動く（既定はオフ）
 * - 鍵（トークン）を知っているクライアントだけを通す（Authorization: Bearer）。鍵は設定で作り直せる
 * - ブラウザのページからの呼び出し（Origin が付く）は断る。Host もこの PC の名前だけ受け付ける（DNS リバインディング対策）
 * - ID/PW・Cookie・ダウンロードの URL・ライセンスキー・手元のファイルの場所は返さない
 * - ファイルを消す・ログインする、のような操作は用意しない
 * - セッションは持たない（問い合わせごとに作って捨てる）。状態はすべてアプリ側にある
 */

const SETTING_ENABLED = 'mcp.enabled';
const SETTING_PORT = 'mcp.port';
const SETTING_TOKEN = 'mcp.token';
const STATS_TAG_RULES_SETTING = 'stats.tagRules';
export const MCP_DEFAULT_PORT = 47615;
const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 1024 * 1024;

export interface McpDeps {
  repo: Repo;
  downloads: Pick<DownloadManager, 'enqueue' | 'list'>;
  /** 画面へ知らせる（一覧を読み直させる・作品を開かせる・同期を始めさせる） */
  send: (channel: string, payload: unknown) => void;
  /** 画面（ウィンドウ）があるか。作品を開く・同期は画面に頼むので、無ければできない */
  hasWindow: () => boolean;
  /** ウィンドウを前に出す */
  focusWindow: () => void;
  isSyncRunning: () => boolean;
  metaStatus: () => MetaCrawlerStatus;
}

export class McpService {
  private server: http.Server | null = null;
  private error: string | null = null;
  /** 状態が変わったときに知らせる先（画面のステータスバー・タスクトレイのメニュー） */
  private listeners = new Set<(status: McpStatus) => void>();

  constructor(private deps: McpDeps) {}

  get enabled(): boolean {
    return this.deps.repo.getSetting(SETTING_ENABLED) === '1';
  }

  get port(): number {
    const raw = Number(this.deps.repo.getSetting(SETTING_PORT));
    return Number.isInteger(raw) && raw >= 1024 && raw <= 65535 ? raw : MCP_DEFAULT_PORT;
  }

  /** 鍵。無ければ作る */
  get token(): string {
    let token = this.deps.repo.getSetting(SETTING_TOKEN);
    if (!token) {
      token = crypto.randomBytes(24).toString('base64url');
      this.deps.repo.setSetting(SETTING_TOKEN, token);
    }
    return token;
  }

  status(): McpStatus {
    return {
      enabled: this.enabled,
      running: !!this.server?.listening,
      port: this.port,
      url: `http://127.0.0.1:${this.port}${MCP_PATH}`,
      token: this.token,
      error: this.error
    };
  }

  /** 状態が変わるたびに呼ばれる。戻り値で登録をやめる */
  onChange(listener: (status: McpStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    const status = this.status();
    for (const listener of this.listeners) listener(status);
  }

  async setEnabled(enabled: boolean): Promise<McpStatus> {
    this.deps.repo.setSetting(SETTING_ENABLED, enabled ? '1' : '0');
    if (enabled) await this.start();
    else await this.stop();
    this.changed();
    return this.status();
  }

  /** 止めてから待ち受け直す（ポートが空いたあとにやり直すときなど）。オフなら何もしない */
  async restart(): Promise<McpStatus> {
    if (this.enabled) {
      await this.stop();
      await this.start();
      this.changed();
    }
    return this.status();
  }

  async setPort(port: number): Promise<McpStatus> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('port must be 1024-65535');
    this.deps.repo.setSetting(SETTING_PORT, String(port));
    if (this.enabled) {
      await this.stop();
      await this.start();
    }
    this.changed();
    return this.status();
  }

  /** 鍵を作り直す（前の鍵は使えなくなる） */
  regenerateToken(): McpStatus {
    this.deps.repo.setSetting(SETTING_TOKEN, crypto.randomBytes(24).toString('base64url'));
    return this.status();
  }

  async startIfEnabled(): Promise<void> {
    if (this.enabled) await this.start();
    this.changed();
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.error = null;
    const server = http.createServer((req, res) => void this.handle(req, res));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      this.server = server;
      console.log(`[mcp] 待ち受け開始: 127.0.0.1:${this.port}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      this.error = code === 'EADDRINUSE' ? `port ${this.port} is in use` : err instanceof Error ? err.message : String(err);
      console.warn(`[mcp] 待ち受けられませんでした: ${this.error}`);
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections?.();
    console.log('[mcp] 待ち受け終了');
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reject = (status: number, message: string): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== MCP_PATH) return reject(404, 'not found');
      // ブラウザのページからは呼ばせない。名前の付け替え（DNS リバインディング）で来た問い合わせも断る
      if (req.headers.origin) return reject(403, 'browser requests are not allowed');
      const host = (req.headers.host ?? '').toLowerCase();
      if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return reject(403, 'bad host');
      const auth = req.headers.authorization ?? '';
      if (!timingSafeEqual(auth, `Bearer ${this.token}`)) return reject(401, 'unauthorized');
      // セッションを持たないので、POST（1 回ごとの問い合わせ）だけを受け付ける
      if (req.method !== 'POST') return reject(405, 'method not allowed');

      const body = await readJson(req);
      const server = createMcpServer(this.deps);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.warn('[mcp] 問い合わせの処理に失敗:', err);
      if (!res.headersSent) reject(500, err instanceof Error ? err.message : String(err));
    }
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ── 道具（ツール） ────────────────────────────────────────

const CATEGORIES = ['game', 'doujin', 'book', 'video', 'other'] as const;
const WORK_TYPES = ['manga', 'cg', 'voice', 'video', 'game', 'novel', 'music', 'tool', 'other'] as const;
const SORTS = ['purchased', 'released', 'title', 'maker', 'used', 'downloaded'] as const;

/** 結果を AI に返す形（JSON の文字列） */
/** その日の日付（この PC の時刻で 'YYYY-MM-DD'） */
const localDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * 統計の期間。'YYYY-MM'（月単位）と 'YYYY-MM-DD'（日単位）を受ける。days は今日を含む直近の日数。
 * 統計は月単位で絞るので、日単位のときは購入日で先に絞っておく
 */
export function statsPeriod(a: { from?: string; to?: string; days?: number }, now = new Date()): { from: string | null; to: string | null; daily: boolean } {
  let from = a.from ?? null;
  let to = a.to ?? null;
  if (a.days) {
    const start = new Date(now);
    start.setDate(start.getDate() - (a.days - 1));
    from = localDate(start);
    to = localDate(now);
  }
  return { from, to, daily: (from?.length ?? 0) === 10 || (to?.length ?? 0) === 10 };
}

const json = (value: unknown): { content: Array<{ type: 'text'; text: string }> } => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 1) }]
});
const fail = (message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } => ({
  content: [{ type: 'text', text: message }],
  isError: true
});

/** タグの決まり（統計の設定の上書き）。カードに出すタグと同じく、作品の属性だけを返すのに使う */
function tagRules(repo: Repo): TagRuleOverrides {
  return { ...parseTagOverrides(repo.getSetting(STATS_TAG_RULES_SETTING)), blurbs: knownBlurbTags(repo) };
}

/** 一覧向けの短い形 */
function summary(p: Product, isTag: (tag: string, p: Product) => boolean): Record<string, unknown> {
  return {
    id: p.id,
    productId: p.productId,
    title: p.title,
    site: p.siteId,
    category: CATEGORY_LABELS[p.category] ?? p.category,
    workType: p.workType ? (WORK_TYPE_LABELS[p.workType as WorkType] ?? p.workType) : null,
    brand: p.maker,
    voiceActors: [...new Set(p.creators.filter((c) => ['声優', '出演', 'CV'].includes(c.role)).map((c) => c.name))],
    tags: p.tags.filter((tag) => isTag(tag, p)),
    purchasedAt: p.purchasedAt,
    releasedAt: p.releasedAt,
    favorite: !!p.favoriteAt,
    used: !!p.viewedAt,
    downloaded: p.hasLocalFile
  };
}

export function createMcpServer(deps: McpDeps): McpServer {
  const { repo } = deps;
  const server = new McpServer({ name: APP_NAME, version: '0.1.0' });
  const rules = tagRules(repo);
  const dictionary = dictionaryOf(rules);
  const blurbs = new Set(rules.blurbs ?? []);
  const isTag = (tag: string, p: Product): boolean => isAttributeTag(tag, p, rules, dictionary, blurbs);
  /** 作品を ID（数字）か作品 ID（d_123456・RJ123456 など）で探す */
  const findWork = (ref: number | string): Product | null => {
    if (typeof ref === 'number') return repo.getProduct(ref);
    const page = repo.queryLibrary({ search: ref, searchFields: ['productId'], limit: 20 });
    return page.items.find((p) => p.productId.toLowerCase() === ref.toLowerCase()) ?? null;
  };
  const workRef = z.union([z.number().int(), z.string()]).describe('Work id (number from search results) or store product id such as "RJ01234567" or "d_123456"');
  const notify = (productRef: number | null): void => deps.send('library:changed', { productRef });

  // ── 読み取り ──
  server.registerTool(
    'search_works',
    {
      title: 'Search the library',
      description:
        'Search purchased works in the Simaeru library. All filters are optional and combined with AND (makers and workTypes are OR within themselves). ' +
        'Returns a page of works with id, title, brand/circle, voice actors, tags and flags (favorite, used, downloaded).',
      inputSchema: {
        query: z.string().optional().describe('Text to look for in titles and brand names'),
        tags: z.array(z.string()).optional().describe('Works must have all of these tags (Japanese tag names as shown by list_tags)'),
        brands: z.array(z.string()).optional().describe('Brand / circle names (any of them)'),
        people: z.array(z.string()).optional().describe('Voice actors, authors or series names (all of them)'),
        category: z.enum(CATEGORIES).optional(),
        workTypes: z.array(z.enum(WORK_TYPES)).optional(),
        site: z.enum(['dmm', 'dlsite']).optional(),
        favoriteOnly: z.boolean().optional(),
        usedOnly: z.boolean().optional(),
        downloaded: z.boolean().optional().describe('true: only works with local files, false: only works without'),
        playlistId: z.number().int().optional(),
        sort: z.enum(SORTS).optional().describe('Default: purchased'),
        order: z.enum(['asc', 'desc']).optional().describe('Default: desc'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 20'),
        offset: z.number().int().min(0).optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (a) => {
      const q: LibraryQuery = {
        search: a.query,
        tags: a.tags,
        makers: a.brands,
        creators: a.people,
        categories: a.category ? [a.category as Category] : undefined,
        workTypes: a.workTypes as WorkType[] | undefined,
        siteIds: a.site ? [a.site] : undefined,
        favoriteOnly: a.favoriteOnly,
        usedOnly: a.usedOnly,
        localState: a.downloaded === undefined ? undefined : a.downloaded ? 'have' : 'none',
        playlistId: a.playlistId ?? null,
        sortKey: (a.sort ?? 'purchased') as SortKey,
        sortDir: a.order ?? 'desc',
        limit: a.limit ?? 20,
        offset: a.offset ?? 0
      };
      const page = repo.queryLibrary(q);
      return json({ total: page.total, offset: q.offset, items: page.items.map((p) => summary(p, isTag)) });
    }
  );

  server.registerTool(
    'get_work',
    {
      title: 'Get a work',
      description: 'Details of one work: description, staff and cast, all tags, playlists it belongs to, and local files (names and sizes only).',
      inputSchema: { work: workRef },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ work }) => {
      const p = findWork(work);
      if (!p) return fail(`work not found: ${work}`);
      return json({
        ...summary(p, isTag),
        allTags: p.tags,
        description: p.description,
        people: p.creators.map((c) => ({ role: c.role, name: c.name })),
        price: p.priceText,
        size: p.fileSizeText,
        playlists: repo.playlistsOf(p.id).map((pl) => ({ id: pl.id, name: pl.name })),
        // 手元のファイルは名前と大きさだけ（場所は返さない）
        localFiles: repo
          .localFiles(p.id)
          .filter((f) => !f.missingAt)
          .map((f) => ({ name: path.basename(f.path), kind: f.kind, bytes: f.sizeBytes }))
      });
    }
  );

  server.registerTool(
    'list_tags',
    {
      title: 'List tags',
      description: 'Tags in the library with the number of works. By default only attribute tags (no sale / old release / OS support tags).',
      inputSchema: {
        category: z.enum(CATEGORIES).optional(),
        includeNonAttribute: z.boolean().optional(),
        limit: z.number().int().min(1).max(1000).optional().describe('Default 200')
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (a) => {
      const rows = repo.tags({ categories: a.category ? [a.category as Category] : undefined });
      const shown = a.includeNonAttribute ? rows : rows.filter((r) => isAttributeTag(r.tag, { siteId: '' }, rules, dictionary, blurbs));
      return json(shown.slice(0, a.limit ?? 200));
    }
  );

  server.registerTool(
    'list_brands',
    {
      title: 'List brands / circles',
      description: 'Brands and circles in the library with the number of works.',
      inputSchema: { category: z.enum(CATEGORIES).optional(), limit: z.number().int().min(1).max(1000).optional().describe('Default 200') },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (a) => json(repo.makers({ categories: a.category ? [a.category as Category] : undefined }).slice(0, a.limit ?? 200))
  );

  server.registerTool(
    'list_people',
    {
      title: 'List people',
      description: 'Voice actors, authors, illustrators, series and so on, with their role and the number of works. Only works whose details have been fetched are counted.',
      inputSchema: {
        role: z.string().optional().describe('Filter by role as stored, e.g. 声優, 作者, イラスト, シナリオ, シリーズ'),
        category: z.enum(CATEGORIES).optional(),
        limit: z.number().int().min(1).max(1000).optional().describe('Default 200')
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (a) => {
      const rows = repo.creatorCounts({ categories: a.category ? [a.category as Category] : undefined });
      return json((a.role ? rows.filter((r) => r.role === a.role) : rows).slice(0, a.limit ?? 200));
    }
  );

  server.registerTool(
    'list_playlists',
    {
      title: 'List playlists',
      description: 'Playlists the user made, with the number of works. Use search_works with playlistId to see their contents (sort "purchased" or any other).',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => json(repo.listPlaylists().map((p) => ({ id: p.id, name: p.name, count: p.count })))
  );

  server.registerTool(
    'purchase_stats',
    {
      title: 'Purchase statistics',
      description:
        'Summary of purchases: totals by site and work type, monthly counts, and top tags, brands, voice actors and authors. ' +
        'Narrow the period with from / to (a month or a day) or with days (the last N days including today, in the local time zone of this PC). ' +
        'risingTags (tags whose share grew in the last 12 months of the period compared with the 12 months before) is included only when the period has purchases in both spans.',
      inputSchema: {
        from: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).optional().describe('YYYY-MM or YYYY-MM-DD, inclusive'),
        to: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).optional().describe('YYYY-MM or YYYY-MM-DD, inclusive'),
        days: z.number().int().min(1).max(3660).optional().describe('The last N days including today. Overrides from / to'),
        site: z.enum(['dmm', 'dlsite']).optional(),
        top: z.number().int().min(1).max(100).optional().describe('How many entries of each ranking. Default 20')
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (a) => {
      const period = statsPeriod(a);
      const filter: StatsFilter = { from: period.from?.slice(0, 7) ?? null, to: period.to?.slice(0, 7) ?? null, siteIds: a.site ? [a.site] : [] };
      let rows = repo.statsRows();
      if (period.daily) {
        const day = (r: { purchasedAt: string | null }): string | null => r.purchasedAt?.slice(0, 10) ?? null;
        rows = rows.filter((r) => {
          const d = day(r);
          return !!d && (!period.from || d >= period.from) && (!period.to || d <= period.to);
        });
      }
      const s = buildPurchaseStats(rows, filter, rules);
      const top = a.top ?? 20;
      return json({
        period: { from: period.from, to: period.to },
        total: s.total,
        firstMonth: s.firstMonth,
        lastMonth: s.lastMonth,
        bySite: s.bySite,
        byWorkType: s.byWorkType.map((w) => ({ workType: w.label, count: w.count })),
        monthly: s.monthly.map((m) => ({ month: m.month, total: m.total })),
        tags: s.tags.slice(0, top).map((r) => ({ name: r.label, count: r.count })),
        // 比べる相手の期間に作品が無いとき（短い期間など）は返さない
        ...(s.risingTags.length > 0
          ? { risingTags: s.risingTags.slice(0, top).map((r) => ({ name: r.label, count: r.count, previous: r.previous })) }
          : {}),
        brands: s.makers.slice(0, top).map((r) => ({ name: r.label, count: r.count })),
        voiceActors: s.voices.slice(0, top).map((r) => ({ name: r.label, count: r.count })),
        authors: s.authors.slice(0, top).map((r) => ({ name: r.label, count: r.count })),
        coverage: s.coverage
      });
    }
  );

  server.registerTool(
    'get_status',
    {
      title: 'App status',
      description: 'What Simaeru is doing now: whether a purchase-history sync is running, the download queue, and background detail fetching.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => {
      const rows = await Promise.resolve(deps.downloads.list());
      const count = (state: string): number => rows.filter((r) => r.state === state).length;
      const meta = deps.metaStatus();
      return json({
        syncRunning: deps.isSyncRunning(),
        downloads: {
          running: rows.filter((r) => r.state === 'running').map((r) => ({ title: r.title, label: r.label, receivedBytes: r.receivedBytes, totalBytes: r.totalBytes })),
          queued: count('queued'),
          paused: count('paused'),
          failed: count('error'),
          done: count('done')
        },
        detailFetching: { enabled: meta.enabled, running: meta.running, pending: meta.pending, pausedReason: meta.pausedReason }
      });
    }
  );

  // ── 操作（ライブラリの中だけ） ──
  server.registerTool(
    'set_favorite',
    {
      title: 'Set favorite',
      description: 'Mark or unmark a work as a favorite (★).',
      inputSchema: { work: workRef, favorite: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ work, favorite }) => {
      const p = findWork(work);
      if (!p) return fail(`work not found: ${work}`);
      repo.setFavorite(p.id, favorite);
      notify(p.id);
      return json({ id: p.id, title: p.title, favorite });
    }
  );

  server.registerTool(
    'set_used',
    {
      title: 'Set used',
      description: 'Mark or unmark a work as used (♥, read / listened / played). Marking records the current time as the last used date.',
      inputSchema: { work: workRef, used: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ work, used }) => {
      const p = findWork(work);
      if (!p) return fail(`work not found: ${work}`);
      repo.setUsed(p.id, used);
      notify(p.id);
      return json({ id: p.id, title: p.title, used });
    }
  );

  server.registerTool(
    'add_to_playlist',
    {
      title: 'Add to playlist',
      description: 'Add works to the end of a playlist. Give playlistId, or playlistName (an existing name, or a new playlist is created with that name).',
      inputSchema: {
        works: z.array(workRef).min(1).max(500),
        playlistId: z.number().int().optional(),
        playlistName: z.string().min(1).max(100).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (a) => {
      let playlist = a.playlistId !== undefined ? repo.getPlaylist(a.playlistId) : null;
      if (!playlist && a.playlistName) {
        playlist = repo.listPlaylists().find((p) => p.name === a.playlistName) ?? repo.createPlaylist(a.playlistName);
      }
      if (!playlist) return fail('playlist not found: give an existing playlistId or a playlistName');
      const found = a.works.map((w) => findWork(w));
      const missing = a.works.filter((_, i) => !found[i]);
      const added = repo.addToPlaylist(playlist.id, found.filter((p): p is Product => !!p).map((p) => p.id));
      deps.send('playlists:changed', { playlists: repo.listPlaylists() });
      return json({ playlist: { id: playlist.id, name: playlist.name }, added, notFound: missing });
    }
  );

  server.registerTool(
    'show_work',
    {
      title: 'Show a work in the app',
      description: 'Open the details of a work in the Simaeru window and bring the window to the front.',
      inputSchema: { work: workRef },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ work }) => {
      const p = findWork(work);
      if (!p) return fail(`work not found: ${work}`);
      if (!deps.hasWindow()) return fail('the Simaeru window is not open');
      deps.send('mcp:showWork', { productRef: p.id });
      deps.focusWindow();
      return json({ shown: { id: p.id, title: p.title } });
    }
  );

  // ── 操作（サイトへの通信が起きる） ──
  server.registerTool(
    'download_works',
    {
      title: 'Download works',
      description:
        'Add works to the download queue (they are downloaded from the store in the background, like the app\'s Download button). ' +
        'Works that are already downloaded are skipped. Returns how many downloads were queued; check progress with get_status.',
      inputSchema: { works: z.array(workRef).min(1).max(200) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ works }) => {
      const found = works.map((w) => findWork(w));
      const missing = works.filter((_, i) => !found[i]);
      const ids = found.filter((p): p is Product => !!p).map((p) => p.id);
      const queued = ids.length ? await deps.downloads.enqueue(ids) : 0;
      return json({ queued, requested: ids.length, notFound: missing, note: queued < ids.length ? 'works already downloaded or already queued are not queued again' : undefined });
    }
  );

  server.registerTool(
    'start_sync',
    {
      title: 'Sync purchase history',
      description:
        'Start syncing the purchase history from the stores the user is signed in to (like the app\'s "Sync purchase history" button). ' +
        'By default only new purchases are fetched; full: true re-reads everything (slow). Runs in the app window; check get_status for progress.',
      inputSchema: { full: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async ({ full }) => {
      if (deps.isSyncRunning()) return fail('a sync is already running');
      if (!deps.hasWindow()) return fail('the Simaeru window is not open');
      deps.send('mcp:startSync', { full: !!full });
      return json({ started: true, full: !!full });
    }
  );

  return server;
}
