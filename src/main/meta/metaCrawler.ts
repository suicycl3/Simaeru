import type { Repo } from '../db/repo';
import { t } from '@shared/i18n';
import { DmmAgeCheckError, DmmAuthError } from '../sites/dmm/client';
import { DlsiteAuthError } from '../sites/dlsite/client';

/**
 * 作品メタ（説明文・スタッフ・ダウンロード導線）を、裏で集める常駐処理。
 *
 * ユーザーが作品を開いたときの取得（library:detail）と同じ関数を呼ぶので、
 * 結果の書き戻し方はUI経由とまったく同じになる。
 *
 * 速度は「1件ごとの待ち時間」と「並列数」の2つで決める。
 * 直列1件ずつだと3000件で数時間かかって実用にならないため、既定は 0.5秒 × 2並列。
 * サイトに負荷をかけたくないときは速度を落とせる。
 *
 * 止める条件:
 *   - 設定でオフ
 *   - 同期実行中（同じサイトへの通信が重なるのを避ける）
 *   - ログイン済みのサイトが無い（取りに行っても失敗するだけ）
 * 失敗した作品は試行回数を進め、3回で打ち切る（販売終了などで永遠に取れない作品があるため）。
 */

export interface MetaCrawlerOptions {
  repo: Repo;
  /** library:detail と同じ取得処理 */
  fetchDetail: (id: number, opts?: { force?: boolean }) => Promise<unknown>;
  /** 同期中は待つ */
  isSyncRunning: () => boolean;
  /** いまログインできているサイトID。ここに無いサイトの作品は選ばない */
  loggedInSites: () => string[];
  /** 進捗の通知先 */
  onProgress: (status: MetaCrawlerStatus) => void;
}

export interface MetaCrawlerStatus {
  enabled: boolean;
  /** 1件取り終えてから次に取りかかるまでの待ち時間（ミリ秒） */
  intervalMs: number;
  /** 同時に取りに行く本数 */
  concurrency: number;
  /** 未取得のうち、いま取りに行ける件数（ログイン済みサイトぶん） */
  pending: number;
  /** 未ログインのサイトにあって、いまは取りに行けない件数 */
  blocked: number;
  /** 直近に取得した作品名。待機中は null */
  lastTitle: string | null;
  /** いま動いているか（オフ・同期中・未ログインなら false） */
  running: boolean;
  /** 止まっている理由。動いていれば null */
  pausedReason: string | null;
  /** 残りを取り切るまでのおよその秒数。実測の処理速度から出す */
  etaSeconds: number | null;
}

const SETTING_ENABLED = 'meta.auto.enabled';
const SETTING_INTERVAL_MS = 'meta.auto.intervalMs';
const SETTING_CONCURRENCY = 'meta.auto.concurrency';
/** 旧設定（秒単位・直列）。残っていれば引き継ぐ */
const SETTING_INTERVAL_SEC_LEGACY = 'meta.auto.intervalSec';

const DEFAULT_INTERVAL_MS = 500;
const MIN_INTERVAL_MS = 100;
const MAX_INTERVAL_MS = 600_000;
const DEFAULT_CONCURRENCY = 2;
/**
 * 並列数の上限。1件あたり1〜3リクエスト（DMMの電子書籍が最多）かかるので、
 * 速度を決めるのは待ち時間より並列数のほう。実測で
 * 2並列=毎秒0.7件、6並列=その3倍程度。
 */
const MAX_CONCURRENCY = 6;
/** 失敗を繰り返す作品で止まらないための上限 */
const MAX_ATTEMPTS = 3;
/** ログイン切れ・年齢確認で止まったときの待ち時間 */
const AUTH_BACKOFF_MS = 30_000;
/** ログイン切れ・年齢確認で断られた作品を後回しにする時間（その間はほかの作品から取る） */
const AUTH_DEFER_MS = 10 * 60_000;
/** 速度の実測に使う直近の処理件数 */
const RATE_WINDOW = 20;

export class MetaCrawler {
  private workers = 0;
  private stopped = true;
  private lastTitle: string | null = null;
  private pausedReason: string | null = null;
  /** ログイン切れ・年齢確認で止まったとき、全走者がこの時刻まで待つ（同じ作品を間を置かずに叩き続けない） */
  private authBlocked: { until: number; reason: string } | null = null;
  /**
   * ログイン切れ・年齢確認で断られた作品（いつまで後回しにするか・いつ断られたか）。
   * 同じ作品だけが断られ続けると、新しい順に選ぶので毎回その作品に戻り、ほかの作品が取れなくなるため。
   */
  private authDeferred = new Map<number, { until: number; at: number }>();
  /** 最後に作品を取れた時刻。断られたのがログインのせいか作品のせいかの見分けに使う */
  private lastSuccessAt = 0;
  /** いま取りに行っている作品。並列でも同じ作品を二重に取らないため */
  private inFlight = new Set<number>();
  /** 直近の処理完了時刻。残り時間の見積もりに使う */
  private recentDoneAt: number[] = [];
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: MetaCrawlerOptions) {}

  get enabled(): boolean {
    // 既定はオン。明示的に '0' が入っているときだけオフ。
    return this.opts.repo.getSetting(SETTING_ENABLED) !== '0';
  }

  get intervalMs(): number {
    const raw = Number(this.opts.repo.getSetting(SETTING_INTERVAL_MS));
    if (Number.isFinite(raw) && raw > 0) return clamp(raw, MIN_INTERVAL_MS, MAX_INTERVAL_MS);
    // 旧設定（秒）が残っていれば引き継ぐ
    const legacy = Number(this.opts.repo.getSetting(SETTING_INTERVAL_SEC_LEGACY));
    if (Number.isFinite(legacy) && legacy > 0) {
      return clamp(legacy * 1000, MIN_INTERVAL_MS, MAX_INTERVAL_MS);
    }
    return DEFAULT_INTERVAL_MS;
  }

  get concurrency(): number {
    const raw = Number(this.opts.repo.getSetting(SETTING_CONCURRENCY));
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CONCURRENCY;
    return clamp(Math.round(raw), 1, MAX_CONCURRENCY);
  }

  status(): MetaCrawlerStatus {
    // 残り時間の母数は「いま取りに行けるぶん」。未ログインのサイトを混ぜると実態とズレる。
    const sites = this.opts.loggedInSites();
    const pending = this.opts.repo.metaPendingCount(MAX_ATTEMPTS, sites);
    const blocked = this.opts.repo.metaPendingCount(MAX_ATTEMPTS) - pending;
    return {
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      concurrency: this.concurrency,
      pending,
      blocked,
      lastTitle: this.lastTitle,
      running: this.workers > 0 && this.pausedReason === null,
      pausedReason: this.enabled ? this.pausedReason : t('停止中'),
      etaSeconds: this.estimateEta(pending)
    };
  }

  /**
   * 残り時間の見積もり。動き出していれば実測の処理速度（直近の完了間隔）から、
   * まだなら設定値から出す。1件あたり1〜3リクエストで時間がぶれるので、
   * 設定値だけで出すと実態と合わない。
   */
  private estimateEta(pending: number): number | null {
    if (pending === 0) return 0;
    const perItemMs = this.measuredPerItemMs() ?? this.intervalMs / this.concurrency;
    if (!perItemMs) return null;
    return Math.round((pending * perItemMs) / 1000);
  }

  private measuredPerItemMs(): number | null {
    if (this.recentDoneAt.length < 3) return null;
    const span = this.recentDoneAt[this.recentDoneAt.length - 1] - this.recentDoneAt[0];
    return span > 0 ? span / (this.recentDoneAt.length - 1) : null;
  }

  setEnabled(enabled: boolean): MetaCrawlerStatus {
    this.opts.repo.setSetting(SETTING_ENABLED, enabled ? '1' : '0');
    if (enabled) this.ensureWorkers();
    else this.stopped = true;
    return this.notify();
  }

  /** 速度の変更。次に取りかかるぶんから効く */
  setSpeed(intervalMs: number, concurrency: number): MetaCrawlerStatus {
    this.opts.repo.setSetting(
      SETTING_INTERVAL_MS,
      String(clamp(Math.round(intervalMs), MIN_INTERVAL_MS, MAX_INTERVAL_MS))
    );
    this.opts.repo.setSetting(
      SETTING_CONCURRENCY,
      String(clamp(Math.round(concurrency), 1, MAX_CONCURRENCY))
    );
    this.recentDoneAt = [];
    if (this.enabled) this.ensureWorkers();
    return this.notify();
  }

  /** 「残りを取得」ボタン用。オフでも動かし、待たずに取りかかる */
  runNow(): MetaCrawlerStatus {
    this.opts.repo.setSetting(SETTING_ENABLED, '1');
    this.pausedReason = null;
    this.authBlocked = null;
    this.authDeferred.clear();
    this.recentDoneAt = [];
    this.ensureWorkers();
    return this.notify();
  }

  /** アプリ起動時に呼ぶ。起動直後の重なりを避けるため少し待ってから */
  start(): void {
    setTimeout(() => {
      if (this.enabled) this.ensureWorkers();
    }, 10_000);
  }

  stop(): void {
    this.stopped = true;
  }

  private notify(): MetaCrawlerStatus {
    const status = this.status();
    this.opts.onProgress(status);
    return status;
  }

  /** 件数の通知が毎件飛ぶとUIが忙しいので、1秒に1回へ間引く */
  private notifyThrottled(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.opts.onProgress(this.status());
    }, 1000);
  }

  /** 設定した並列数まで走者を増やす */
  private ensureWorkers(): void {
    this.stopped = false;
    const want = this.concurrency;
    while (this.workers < want) {
      this.workers++;
      void this.loop();
    }
  }

  private async loop(): Promise<void> {
    try {
      for (;;) {
        if (this.stopped || !this.enabled) return;
        // 並列数を下げたときは、余った走者から順に抜ける
        if (this.workers > this.concurrency) return;

        const blocked = this.blockedReason();
        if (blocked) {
          this.pausedReason = blocked;
          this.notifyThrottled();
          await sleep(5000);
          continue;
        }

        const target = this.claimTarget();
        if (!target) {
          // 残りがログイン切れ・年齢確認で後回しにした作品だけなら、取得済みではなくその理由を出す
          const deferred = [...this.authDeferred.values()].some((d) => d.until > Date.now());
          this.pausedReason = deferred ? (this.authBlocked?.reason ?? t('ログインが切れています')) : t('取得できるぶんは取得済み');
          this.notifyThrottled();
          await sleep(10_000);
          continue;
        }

        this.pausedReason = null;
        try {
          const result = (await this.opts.fetchDetail(target.id)) as { supported?: boolean } | null;
          // 対応していないフロア（＝これ以上取れない）は取得済みにならないので、
          // 試行回数で自然に打ち切られるようにする。
          if (!result?.supported) this.opts.repo.bumpMetaAttempt(target.id);
          this.lastTitle = target.title;
          this.lastSuccessAt = Date.now();
          this.authDeferred.delete(target.id);
        } catch (err) {
          // ログイン切れは作品側の問題ではないので回数を進めない（戻ってきたら取れる）
          if (err instanceof DmmAuthError || err instanceof DlsiteAuthError) {
            const now = Date.now();
            const prev = this.authDeferred.get(target.id);
            if (prev && this.lastSuccessAt > prev.at) {
              // 前に断られてから、ほかの作品は取れている＝ログインではなくこの作品の問題。回数を進めて、いずれ打ち切る
              this.opts.repo.bumpMetaAttempt(target.id);
            } else {
              // しばらく全走者を止める（ログインし直せば待ち明けの巡回で取り直す）
              const reason = err instanceof DmmAgeCheckError ? t('年齢確認を通れないため待機') : t('ログインが切れています');
              this.authBlocked = { until: now + AUTH_BACKOFF_MS, reason };
              this.pausedReason = reason;
            }
            this.authDeferred.set(target.id, { until: now + AUTH_DEFER_MS, at: now });
          } else this.opts.repo.bumpMetaAttempt(target.id);
        } finally {
          this.inFlight.delete(target.id);
          this.recentDoneAt.push(Date.now());
          if (this.recentDoneAt.length > RATE_WINDOW) this.recentDoneAt.shift();
        }

        this.notifyThrottled();
        await sleep(this.intervalMs);
      }
    } finally {
      this.workers--;
    }
  }

  private blockedReason(): string | null {
    if (this.opts.isSyncRunning()) return t('同期中は待機');
    if (this.opts.loggedInSites().length === 0) return t('未ログインのため待機');
    if (this.authBlocked && Date.now() < this.authBlocked.until) return this.authBlocked.reason;
    return null;
  }

  /** 他の走者が取りかかっていない作品を1件押さえる */
  private claimTarget(): { id: number; title: string } | null {
    const sites = this.opts.loggedInSites();
    const now = Date.now();
    const deferred = new Set([...this.authDeferred].filter(([, d]) => d.until > now).map(([id]) => id));
    const candidates = this.opts.repo.nextMetaTargets(MAX_ATTEMPTS, sites, this.inFlight.size + deferred.size + 1);
    for (const c of candidates) {
      if (this.inFlight.has(c.id) || deferred.has(c.id)) continue;
      this.inFlight.add(c.id);
      return c;
    }
    return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
