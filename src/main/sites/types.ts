import type { AuthResult } from '@shared/auth';
import type { ProductInput } from '../db/repo';

/** 同期の進捗をUIへ流すためのコールバック */
export interface FloorSyncContext {
  /** 途中経過。total が不明なら null */
  onProgress(fetched: number, total: number | null, message?: string): void;
  /** 中断要求。true を返したらアダプタは速やかに抜ける */
  isCancelled(): boolean;

  /**
   * 差分同期モード。一覧APIは購入日の新しい順に並ぶので、
   * 「このページが全部既知」になった時点でそれ以降は既知とみなして打ち切ってよい。
   * false のときは全件を取り直す（取りこぼしの修復用）。
   */
  incremental: boolean;
  /** すでにDBにある作品か */
  isKnown(productId: string): boolean;
  /** 既知で、かつ操作リンク（ダウンロード導線）まで入っているか */
  isComplete(productId: string): boolean;
  /** ライセンスキーを取得済みか（取得済みならページを開き直さない） */
  hasSerial(productId: string): boolean;
  /**
   * 1ページぶんの作品IDを渡して、ここで打ち切ってよいかを判定する。
   * 差分モードで、ページ内が全部「完了済み」のときだけ true。
   */
  canStopAfterPage(productIds: string[]): boolean;
}

export interface FloorAdapter {
  floorId: string;
  label: string;
  /** 1フロア分の購入済み一覧を取り切って返す */
  fetchAll(ctx: FloorSyncContext): Promise<ProductInput[]>;
}

export interface SiteAdapter {
  siteId: string;
  label: string;
  /** 認証Cookieを保持する Electron セッションのパーティション名 */
  partition: string;
  /** ログイン画面のURL */
  loginUrl: string;
  /** ログイン完了とみなせるURLか */
  isLoggedInUrl(url: string): boolean;
  /** 現在ログイン済みかを実際に問い合わせる */
  probeLogin(): Promise<AuthResult>;
  floors: FloorAdapter[];
}
