/**
 * 保存済みのログイン情報が復号できるかを確認する（中身は伏せて長さだけ出す）。
 *   npx electron tools/check-credentials.js
 * ※ アプリを終了してから実行すること
 */
const path = require('node:path');
const { userDataDir } = require('./app-paths.cjs');
const { app, safeStorage } = require('electron');

app.setPath('userData', userDataDir(app.getPath('appData')));

app.whenReady().then(() => {
  console.log('safeStorage 利用可否:', safeStorage.isEncryptionAvailable());
  try {
    console.log('バックエンド:', safeStorage.getSelectedStorageBackend?.() ?? '(Windowsでは取得不可)');
  } catch {}

  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(path.join(app.getPath('userData'), 'library.db'), { readonly: true });
  for (const row of db.prepare('SELECT site_id, login_id, secret, updated_at FROM credentials').all()) {
    const tryDecrypt = (buf) => {
      if (!buf || buf.length === 0) return '(空)';
      try {
        const v = safeStorage.decryptString(Buffer.from(buf));
        return `復号OK (${v.length}文字)`;
      } catch (err) {
        return `復号NG: ${err.message}`;
      }
    };
    console.log(
      `\n[${row.site_id}] 更新 ${new Date(row.updated_at).toLocaleString('ja-JP')}`,
      `\n  login_id: ${row.login_id ? row.login_id.length : 0} bytes ->`, tryDecrypt(row.login_id),
      `\n  secret  : ${row.secret ? row.secret.length : 0} bytes ->`, tryDecrypt(row.secret)
    );
  }
  db.close();

  // 暗号化→復号がこのプロセスで往復するかも見る
  const round = safeStorage.decryptString(safeStorage.encryptString('round-trip-test'));
  console.log('\nこのプロセスでの往復:', round === 'round-trip-test' ? 'OK' : 'NG');
  app.quit();
});
