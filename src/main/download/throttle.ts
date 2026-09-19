/**
 * ダウンロードの帯域制限。
 *
 * Electron の DownloadItem には速度の上限を付ける API が無く、DevTools のネットワーク制限も
 * ダウンロードマネージャ経由の転送には効かない。そこで**合計の受信量を見ながら一時停止と再開を繰り返す**
 * （トークンバケット）。細かい波は出るが、数秒単位の平均は上限に収まる。
 *
 * ユーザーが止めたものは触らない。このクラスが止めたものだけを再開する。
 */

export interface ThrottleItem {
  getReceivedBytes(): number;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
}

export class BandwidthThrottle {
  private items = new Map<number, { item: ThrottleItem; last: number }>();
  /** このクラスが止めたもの */
  private held = new Set<number>();
  private tokens = 0;
  private lastTick: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private limit: () => number,
    private now: () => number = Date.now
  ) {
    this.lastTick = now();
  }

  start(intervalMs = 200): void {
    if (this.timer) return;
    this.lastTick = this.now();
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.releaseAll();
  }

  add(id: number, item: ThrottleItem): void {
    this.items.set(id, { item, last: item.getReceivedBytes() });
  }

  remove(id: number): void {
    this.items.delete(id);
    this.held.delete(id);
  }

  /** ユーザーが一時停止したとき。以後このクラスは再開しない */
  release(id: number): void {
    this.held.delete(id);
  }

  /** いまこのクラスが止めているか（DB の状態を「一時停止」にしないため） */
  isHeld(id: number): boolean {
    return this.held.has(id);
  }

  tick(): void {
    const now = this.now();
    const dt = Math.max(0, (now - this.lastTick) / 1000);
    this.lastTick = now;
    const limit = this.limit();

    let consumed = 0;
    for (const entry of this.items.values()) {
      const received = entry.item.getReceivedBytes();
      consumed += Math.max(0, received - entry.last);
      entry.last = received;
    }

    if (limit <= 0) {
      this.tokens = 0;
      this.releaseAll();
      return;
    }

    // 1秒ぶんまで貯められる。貯めすぎると再開直後に一気に流れて上限を超える
    this.tokens = Math.min(limit, this.tokens + limit * dt) - consumed;

    if (this.tokens < 0) {
      for (const [id, { item }] of this.items) {
        if (!item.isPaused()) {
          item.pause();
          this.held.add(id);
        }
      }
    } else if (this.held.size > 0) {
      this.releaseAll();
    }
  }

  private releaseAll(): void {
    for (const id of [...this.held]) {
      const entry = this.items.get(id);
      if (entry && entry.item.isPaused()) entry.item.resume();
      this.held.delete(id);
    }
  }
}
