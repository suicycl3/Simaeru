import { APP_NAME } from '@shared/appInfo';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { app, dialog, ipcMain } from 'electron';
import { getDatabase } from './database';
import { MIGRATIONS } from './schema';
import { t } from '@shared/i18n';

const PENDING = 'library.restore-pending.db';

/** 復元はDBを開く前だけ行う。旧DBとWALは同じ名前の組で保持する。 */
export function applyPendingRestore(dir: string): void {
  const pending = path.join(dir, PENDING);
  if (!fs.existsSync(pending)) return;
  const target = path.join(dir, 'library.db');
  const backup = `${target}.before-restore-${Date.now()}`;
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(target + suffix)) fs.renameSync(target + suffix, backup + suffix);
  }
  fs.renameSync(pending, target);
}

function validate(db: Database.Database): void {
  if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Invalid database');
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version !== MIGRATIONS.length) throw new Error('Backup schema version differs from this app');
  for (const table of ['products', 'settings', 'local_files', 'installations', 'credentials']) db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
}

/** 作品台帳・設定のSQLiteスナップショット。アカウントの秘密情報は含めない。 */
export async function exportLibrary(file: string): Promise<void> {
  const temporary = `${file}.writing-${Date.now()}`;
  await getDatabase().backup(temporary);
  const copy = new Database(temporary);
  try {
    copy.pragma('journal_mode = DELETE');
    copy.exec('DELETE FROM credentials; VACUUM;');
    validate(copy);
  } finally { copy.close(); }
  fs.renameSync(temporary, file);
}

export async function stageLibraryRestore(file: string, dir: string): Promise<void> {
  const source = new Database(file, { readonly: true, fileMustExist: true });
  const pending = path.join(dir, PENDING);
  const temporary = `${pending}.preparing`;
  try { validate(source); await source.backup(temporary); }
  finally { source.close(); }
  const staged = new Database(temporary);
  try {
    staged.pragma('journal_mode = DELETE');
    // 現在の端末の資格情報は復元によって巻き戻さない。
    staged.exec('DELETE FROM credentials');
    const insert = staged.prepare('INSERT INTO credentials(site_id,login_id,secret,updated_at) VALUES(@site_id,@login_id,@secret,@updated_at)');
    const creds = getDatabase().prepare('SELECT * FROM credentials').all();
    staged.transaction(() => { for (const row of creds) insert.run(row); })();
    // 古い実行中キューを再起動直後に再実行しない。
    staged.exec("UPDATE downloads SET state='paused' WHERE state IN ('running','queued'); UPDATE jobs SET state='canceled' WHERE state IN ('running','queued');");
    validate(staged);
  } finally { staged.close(); }
  fs.renameSync(temporary, pending);
}

export function registerBackupIpc(isBusy: () => boolean): void {
  let active = false;
  ipcMain.handle('library:backup', async () => {
    if (active) throw new Error(t('処理中です'));
    active = true;
    try {
      const choice = await dialog.showSaveDialog({ defaultPath: `${APP_NAME}-${new Date().toISOString().slice(0, 10)}.db`, filters: [{ name: APP_NAME, extensions: ['db'] }] });
      if (choice.canceled || !choice.filePath) return null;
      if (path.resolve(choice.filePath).toLowerCase() === path.resolve(getDatabase().name).toLowerCase()) throw new Error('Cannot overwrite the active database');
      await exportLibrary(choice.filePath);
      return choice.filePath;
    } finally { active = false; }
  });
  ipcMain.handle('library:restore', async () => {
    if (active || isBusy()) throw new Error(t('同期・ダウンロード・変換が終わってから復元してください。'));
    active = true;
    try {
      const choice = await dialog.showOpenDialog({ filters: [{ name: APP_NAME, extensions: ['db'] }], properties: ['openFile'] });
      if (choice.canceled || !choice.filePaths[0]) return false;
      const answer = await dialog.showMessageBox({ type: 'warning', message: t('台帳と設定をバックアップ時点へ戻して再起動します。現在の台帳は退避します。'), buttons: [t('やめる'), t('復元して再起動')], defaultId: 0, cancelId: 0 });
      if (answer.response !== 1) return false;
      if (isBusy()) throw new Error(t('同期・ダウンロード・変換が終わってから復元してください。'));
      await stageLibraryRestore(choice.filePaths[0], app.getPath('userData'));
      app.relaunch(); app.quit(); return true;
    } finally { active = false; }
  });
}
