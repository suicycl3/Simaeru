/**
 * どの userData（= どの Local State の暗号鍵）で暗号化されたかを確かめる。
 *   npx electron tools/probe-oscrypt-dir.js <userDataに使うフォルダ名>
 * ※ アプリを終了してから実行すること。DB は読み取り専用で開く。
 */
const path = require('node:path');
const { userDataDir } = require('./app-paths.cjs');
const { app, safeStorage } = require('electron');

// 引数でフォルダ名を指定できる（指定が無ければ、いま使われている置き場所）
const dirName = process.argv[2];
app.setPath('userData', dirName ? path.join(app.getPath('appData'), dirName) : userDataDir(app.getPath('appData')));

app.whenReady().then(() => {
  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(path.join(userDataDir(app.getPath('appData')), 'library.db'), {
    readonly: true
  });
  const rows = db.prepare('SELECT site_id, login_id FROM credentials').all();
  const results = rows.map((r) => {
    try {
      safeStorage.decryptString(Buffer.from(r.login_id));
      return `${r.site_id}=復号OK`;
    } catch {
      return `${r.site_id}=NG`;
    }
  });
  console.log(`[${dirName}] ${results.join(' / ')}`);
  db.close();
  app.quit();
});
