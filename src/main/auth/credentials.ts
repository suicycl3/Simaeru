import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { DB } from '../db/database';
import { t } from '@shared/i18n';

/**
 * サイトのログイン情報の保管。
 *
 * **平文では絶対に保存しない。** 暗号化できない環境では保存自体を断る。
 *
 * 「保存したはずのID/PWが消えた」ことが2度あったので、1か所に頼らない二重持ちにしている:
 *
 *   1. SQLite の credentials 表（Electron の safeStorage で暗号化）
 *   2. userData 直下の `credentials.dpapi`（**Windows の DPAPI で直接**暗号化した控え）
 *
 * - 2 は Chromium の暗号鍵（userData の Local State）にも SQLite にも依存しない。
 *   DPAPI は Windows のユーザーアカウントに紐づくので、アプリのデータが壊れても復号できる。
 * - 読むときは 1 を見て、無い・復号できないときは 2 から戻して 1 を直す。
 * - 保存したら**両方を読み戻して復号できることを確かめる**。確かめられなければ失敗として返す
 *   （黙って「保存しました」と出さない）。
 * - 書いたらすぐ WAL をチェックポイントして、本体ファイルに確定させる。
 *
 * ログインそのものはサイトのログイン画面で行う。ここの値は自動入力とコピーにだけ使い、
 * 送信ボタンは押さない。
 */

export interface CredentialSummary {
  siteId: string;
  loginId: string | null;
  hasPassword: boolean;
  updatedAt: number | null;
  /** 保存はされているが復号できなかった（再入力が必要） */
  unreadable?: boolean;
}

export function isSecureStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

// ── 1. safeStorage（DB側） ─────────────────────────────────
function encrypt(value: string): Buffer {
  return safeStorage.encryptString(value);
}

function decrypt(buf: Buffer | Uint8Array | null): string | null {
  if (!buf || buf.length === 0) return null;
  try {
    return safeStorage.decryptString(Buffer.from(buf));
  } catch {
    return null;
  }
}

// ── 2. DPAPI（控えファイル） ───────────────────────────────
/**
 * PowerShell 経由で Windows DPAPI（CurrentUser）を呼ぶ。ネイティブモジュールは使わない。
 * 秘密をコマンドラインに載せるとプロセス一覧から見えるので、**標準入力で渡す**。
 * 文字化けを避けるため、行き来はすべて Base64（ASCII）にする。
 */
function dpapi(mode: 'protect' | 'unprotect', values: string[]): Array<string | null> | null {
  if (process.platform !== 'win32' || values.length === 0) return null;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$items = [Console]::In.ReadToEnd() | ConvertFrom-Json',
    '$out = @()',
    'foreach ($b64 in $items) {',
    '  try {',
    '    $bytes = [Convert]::FromBase64String($b64)',
    mode === 'protect'
      ? "    $res = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')"
      : "    $res = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')",
    '    $out += [Convert]::ToBase64String($res)',
    '  } catch { $out += $null }',
    '}',
    'ConvertTo-Json -Compress -InputObject @($out)'
  ].join('\n');

  // 平文は UTF-8 → Base64 にしてから渡す（protect のとき）
  const input =
    mode === 'protect'
      ? values.map((v) => Buffer.from(v, 'utf8').toString('base64'))
      : values;

  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 20_000 }
  );
  if (res.status !== 0 || !res.stdout) {
    console.warn(
      `[credentials] PowerShell(DPAPI) 失敗: status=${res.status} err=${res.error?.message ?? ''} stderr=${(res.stderr || '').slice(0, 200)}`
    );
    return null;
  }
  try {
    const parsed = JSON.parse(res.stdout.trim()) as Array<string | null> | string | null;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return mode === 'protect'
      ? list
      : list.map((b64) => (b64 ? Buffer.from(b64, 'base64').toString('utf8') : null));
  } catch {
    return null;
  }
}

interface BackupItem {
  loginId: string;
  secret: string;
  updatedAt: number;
}

interface BackupFile {
  version: 1;
  items: Record<string, BackupItem>;
}

// ── 本体 ──────────────────────────────────────────────────
interface CredentialRow {
  site_id: string;
  login_id: Uint8Array | null;
  secret: Uint8Array | null;
  updated_at: number;
}

export class CredentialStore {
  private backupPath: string;
  private cache = new Map<
    string,
    { loginId: string; password: string; updatedAt: number } | { unreadable: true } | null
  >();

  constructor(
    private db: DB,
    userDataDir: string
  ) {
    this.backupPath = path.join(userDataDir, 'credentials.dpapi');
  }

  // ── 控えファイル ──
  private readBackup(): BackupFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.backupPath, 'utf8')) as BackupFile;
      if (raw && raw.version === 1 && raw.items) return raw;
    } catch {
      /* 無い・壊れている */
    }
    return { version: 1, items: {} };
  }

  /** 一時ファイルに書いてから置き換える。途中で落ちても前の控えは壊れない */
  private writeBackup(data: BackupFile): void {
    const tmp = `${this.backupPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(tmp, this.backupPath);
  }

  private readBackupItem(siteId: string): { loginId: string; password: string; updatedAt: number } | null {
    const item = this.readBackup().items[siteId];
    if (!item) return null;
    const plain = dpapi('unprotect', [item.loginId, item.secret]);
    if (!plain || !plain[0] || !plain[1]) return null;
    return { loginId: plain[0], password: plain[1], updatedAt: item.updatedAt };
  }

  // ── DB ──
  private readRow(siteId: string): CredentialRow | undefined {
    return this.db
      .prepare('SELECT site_id, login_id, secret, updated_at FROM credentials WHERE site_id = ?')
      .get(siteId) as CredentialRow | undefined;
  }

  private writeRow(siteId: string, loginId: string, password: string, updatedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO credentials (site_id, login_id, secret, updated_at)
         VALUES (@site_id, @login_id, @secret, @updated_at)
         ON CONFLICT(site_id) DO UPDATE SET
           login_id=@login_id, secret=@secret, updated_at=@updated_at`
      )
      .run({
        site_id: siteId,
        login_id: encrypt(loginId),
        secret: encrypt(password),
        updated_at: updatedAt
      });
    // WAL に置いたままにせず、すぐ本体ファイルへ確定させる
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* 他の読み手がいると畳めないことがある。次の機会に畳まれる */
    }
  }

  /**
   * DB と控えの両方を見て、読める方を返す。
   * DB が欠けていた・読めなかったときは、控えから DB を直す。
   */
  private resolve(
    siteId: string
  ): { loginId: string; password: string; updatedAt: number } | { unreadable: true } | null {
    // PowerShell を毎回起こすと重いので、このプロセスの間は一度読んだ結果を使い回す
    const cached = this.cache.get(siteId);
    if (cached !== undefined) return cached;
    const r = this.resolveUncached(siteId);
    this.cache.set(siteId, r);
    return r;
  }

  private resolveUncached(
    siteId: string
  ): { loginId: string; password: string; updatedAt: number } | { unreadable: true } | null {
    // **DPAPI の控えを正とする。** safeStorage の鍵は userData の Local State に置かれ、
    // 起動のされ方や終了のしかたしだいで鍵が変わる・失われることがある
    // （実際に、保存したはずの値がどの鍵でも復号できなくなった）。
    // DPAPI は Windows のユーザーに紐づくので、その影響を受けない。
    const row = this.readRow(siteId);
    const rowPlain = row ? { loginId: decrypt(row.login_id), password: decrypt(row.secret) } : null;
    const rowOk = !!rowPlain?.loginId && !!rowPlain?.password;

    const backup = this.readBackupItem(siteId);
    if (backup && !(rowOk && row!.updated_at > backup.updatedAt)) {
      // DB が欠けていた・読めなかったときは控えから直しておく（DB側は副）
      if (!rowOk && isSecureStorageAvailable()) {
        try {
          this.writeRow(siteId, backup.loginId, backup.password, backup.updatedAt);
        } catch {
          /* 控えが読めているので致命的ではない */
        }
      }
      return backup;
    }

    if (row && rowOk) {
      // DB の方が新しい、または DB にしか無い（前の版で保存した）。控えを作り直す
      const v = { loginId: rowPlain!.loginId!, password: rowPlain!.password!, updatedAt: row.updated_at };
      if (process.platform === 'win32') this.writeBackupItem(siteId, v.loginId, v.password, v.updatedAt);
      return v;
    }
    // 行はあるのにどの鍵でも読めない。再入力してもらうしかない
    if (row) return { unreadable: true };
    return null;
  }

  /** 控えに1件書く。成功したかを返す */
  private writeBackupItem(siteId: string, loginId: string, password: string, updatedAt: number): boolean {
    const enc = dpapi('protect', [loginId, password]);
    if (!enc || !enc[0] || !enc[1]) return false;
    const data = this.readBackup();
    data.items[siteId] = { loginId: enc[0], secret: enc[1], updatedAt };
    this.writeBackup(data);
    return true;
  }

  /**
   * 控えの全件を PowerShell 1回でまとめて復号し、キャッシュに入れる。
   * サイトごとに PowerShell を起こすと起動や一覧表示が待たされるため。
   */
  private warmUp(): void {
    const items = Object.entries(this.readBackup().items).filter(([id]) => !this.cache.has(id));
    if (items.length === 0) return;
    const plain = dpapi(
      'unprotect',
      items.flatMap(([, it]) => [it.loginId, it.secret])
    );
    if (!plain) return;
    items.forEach(([siteId, it], i) => {
      const loginId = plain[i * 2];
      const password = plain[i * 2 + 1];
      if (!loginId || !password) return; // 読めなかったものは通常の経路で判断させる
      const row = this.readRow(siteId);
      // DB の方が新しい可能性があるときは通常の経路に任せる
      if (row && row.updated_at > it.updatedAt) return;
      const rowOk = !!row && !!decrypt(row.login_id) && !!decrypt(row.secret);
      if (!rowOk && isSecureStorageAvailable()) {
        try {
          this.writeRow(siteId, loginId, password, it.updatedAt);
        } catch {
          /* 控えが読めているので致命的ではない */
        }
      }
      this.cache.set(siteId, { loginId, password, updatedAt: it.updatedAt });
    });
  }

  private siteIds(): string[] {
    const fromDb = (this.db.prepare('SELECT site_id FROM credentials').all() as Array<{ site_id: string }>).map(
      (r) => r.site_id
    );
    const fromBackup = Object.keys(this.readBackup().items);
    return [...new Set([...fromDb, ...fromBackup])];
  }

  // ── 公開API ──
  /** 一覧（パスワードは含めない） */
  list(): CredentialSummary[] {
    if (process.platform === 'win32') this.warmUp();
    return this.siteIds().map((siteId) => this.get(siteId));
  }

  get(siteId: string): CredentialSummary {
    const r = this.resolve(siteId);
    if (!r) return { siteId, loginId: null, hasPassword: false, updatedAt: null };
    if ('unreadable' in r) {
      return { siteId, loginId: null, hasPassword: false, updatedAt: null, unreadable: true };
    }
    return { siteId, loginId: r.loginId, hasPassword: true, updatedAt: r.updatedAt };
  }

  /** 中身をそのまま取り出す。自動入力とコピーのときだけ使う */
  reveal(siteId: string): { loginId: string | null; password: string | null } {
    const r = this.resolve(siteId);
    if (!r || 'unreadable' in r) return { loginId: null, password: null };
    return { loginId: r.loginId, password: r.password };
  }

  /**
   * 保存する。DB と控えの両方に書き、**読み戻して復号できることを確かめる**。
   * 確かめられなければ例外にする（UIに「保存できませんでした」を出させる）。
   */
  save(siteId: string, loginId: string, password: string): void {
    if (!isSecureStorageAvailable()) {
      throw new Error(
        t('この環境では暗号化して保存できないため、ログイン情報は保存しません（平文では保存しない方針です）。')
      );
    }
    const updatedAt = Date.now();
    this.cache.delete(siteId);

    // 正となるのは DPAPI の控え。Windows ではこれが書けて読み戻せないと保存失敗にする
    if (process.platform === 'win32') {
      const wrote = this.writeBackupItem(siteId, loginId, password, updatedAt);
      const back = wrote ? this.readBackupItem(siteId) : null;
      if (!back || back.loginId !== loginId || back.password !== password) {
        throw new Error(
          t('ログイン情報を保存できませんでした（Windows の暗号化で書き込み・読み戻しに失敗しました）。')
        );
      }
    }

    // DB 側は副（UI の一覧やほかの環境のため）。失敗しても控えがあるので保存は成立する
    try {
      this.writeRow(siteId, loginId, password, updatedAt);
    } catch {
      if (process.platform !== 'win32') {
        throw new Error(t('ログイン情報を保存できませんでした。'));
      }
    }
    if (process.platform !== 'win32') {
      const row = this.readRow(siteId);
      const ok = !!row && decrypt(row.login_id) === loginId && decrypt(row.secret) === password;
      if (!ok) throw new Error(t('ログイン情報を保存できませんでした（読み戻しで一致しませんでした）。'));
    }
    this.cache.set(siteId, { loginId, password, updatedAt });
  }

  /**
   * 起動時に呼ぶ。DB にだけあって控えが無い（前の版で保存した）ものに控えを作る。
   * 逆に控えにだけあるものは resolve() が読むときに DB へ戻す。
   * @returns 控えを作った件数
   */
  ensureBackups(): number {
    if (process.platform !== 'win32') return 0;
    this.warmUp();
    const data = this.readBackup();
    let created = 0;
    const rows = this.db
      .prepare('SELECT site_id, login_id, secret, updated_at FROM credentials')
      .all() as CredentialRow[];
    for (const row of rows) {
      if (data.items[row.site_id]) continue;
      const loginId = decrypt(row.login_id);
      const password = decrypt(row.secret);
      if (!loginId || !password) {
        console.warn(`[credentials] ${row.site_id}: DBの値を復号できないため控えを作れません`);
        continue;
      }
      const enc = dpapi('protect', [loginId, password]);
      if (!enc || !enc[0] || !enc[1]) {
        console.warn(`[credentials] ${row.site_id}: DPAPIでの暗号化に失敗しました`);
        continue;
      }
      data.items[row.site_id] = { loginId: enc[0], secret: enc[1], updatedAt: row.updated_at };
      created++;
    }
    if (created > 0) this.writeBackup(data);
    return created;
  }

  clear(siteId: string): void {
    this.cache.delete(siteId);
    this.db.prepare('DELETE FROM credentials WHERE site_id = ?').run(siteId);
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* 次の機会に畳まれる */
    }
    const data = this.readBackup();
    if (data.items[siteId]) {
      delete data.items[siteId];
      this.writeBackup(data);
    }
  }
}
