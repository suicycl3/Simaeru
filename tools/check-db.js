/**
 * library.db の健全性を確認する（読み取り専用）。
 *   npx electron tools/check-db.js
 * ※ アプリを終了してから実行すること
 *
 * 同梱の sqlite3.exe は FTS5 を持たないので integrity_check が途中で落ちる。
 * アプリと同じ better-sqlite3（FTS5入り）で見る必要がある。
 */
const path = require('node:path');
const { userDataDir } = require('./app-paths.cjs');
const fs = require('node:fs');
const { app } = require('electron');

app.setPath('userData', userDataDir(app.getPath('appData')));

app.whenReady().then(() => {
  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const file = path.join(app.getPath('userData'), 'library.db');
  console.log('対象:', file, `${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB`);

  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const t0 = Date.now();
    const integrity = db.pragma('integrity_check');
    console.log(`\nintegrity_check (${Date.now() - t0}ms):`, JSON.stringify(integrity));
    console.log('quick_check      :', JSON.stringify(db.pragma('quick_check')));
    console.log('foreign_key_check:', JSON.stringify(db.pragma('foreign_key_check')));
    console.log('user_version     :', JSON.stringify(db.pragma('user_version')));
    console.log('journal_mode     :', JSON.stringify(db.pragma('journal_mode')));
    console.log('page_count/size  :', JSON.stringify(db.pragma('page_count')), JSON.stringify(db.pragma('page_size')));

    const one = (sql) => Object.values(db.prepare(sql).get())[0];
    console.log('\n件数:');
    console.log('  products      :', one('SELECT count(*) FROM products'));
    console.log('  products_fts  :', one('SELECT count(*) FROM products_fts'));
    console.log('  credentials   :', one('SELECT count(*) FROM credentials'));
    console.log('  installations :', one('SELECT count(*) FROM installations'));
    console.log('  settings      :', one('SELECT count(*) FROM settings'));
    console.log('  sync_runs     :', one('SELECT count(*) FROM sync_runs'));

    // 全文検索の索引が本体とずれていないか（独立FTS方式なので件数で見る）
    const orphan = one(
      'SELECT count(*) FROM products_fts f WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = f.rowid)'
    );
    const missing = one(
      'SELECT count(*) FROM products p WHERE NOT EXISTS (SELECT 1 FROM products_fts f WHERE f.rowid = p.id)'
    );
    console.log('\nFTS索引のずれ: 余分', orphan, '/ 欠け', missing);

    // 実際に検索が通るか
    const hit = db.prepare("SELECT count(*) AS c FROM products_fts WHERE products_fts MATCH ?").get('"同人"');
    console.log('FTS検索テスト:', JSON.stringify(hit));

    console.log('\n設定:');
    for (const row of db.prepare('SELECT key, value FROM settings ORDER BY key').all()) {
      console.log(`  ${row.key} = ${row.value}`);
    }
  } catch (err) {
    console.error('CHECK_ERROR', err && err.stack ? err.stack : err);
  } finally {
    db.close();
    app.quit();
  }
});
