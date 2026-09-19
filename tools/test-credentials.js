/**
 * ログイン情報の保存が消えないことを確かめる。
 *   npx electron tools/test-credentials.js
 *
 * **本物の userData は使わない。** 使い捨てフォルダに DB と控えファイルを作って試す。
 * （ユーザーの保存済みID/PWに触れないため。アプリ起動中でも実行できる）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const esbuild = require('esbuild');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-test-'));
app.setPath('userData', dir);

const out = path.join(os.tmpdir(), 'credentials.test.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'main', 'auth', 'credentials.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  alias: { '@shared': path.join(__dirname, '..', 'src', 'shared') },
  logLevel: 'error'
});

const failures = [];
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok ' : '  NG '} ${label}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures.push(label);
};

app.whenReady().then(() => {
  try {
    const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
    const { CredentialStore } = require(out);
    const dbPath = path.join(dir, 'library.db');
    let db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE credentials (site_id TEXT PRIMARY KEY, login_id BLOB, secret BLOB, updated_at INTEGER NOT NULL)`);

    let store = new CredentialStore(db, dir);
    const ID = 'tester@example.com';
    const PW = 'パスワード-テスト-123';

    console.log('== 保存と読み戻し ==');
    store.save('dmm', ID, PW);
    const r1 = store.reveal('dmm');
    check('保存した値がそのまま読める', r1.loginId === ID && r1.password === PW);
    check('控えファイルができている', fs.existsSync(path.join(dir, 'credentials.dpapi')));
    const backupText = fs.readFileSync(path.join(dir, 'credentials.dpapi'), 'utf8');
    check('控えファイルに平文が入っていない', !backupText.includes(ID) && !backupText.includes('テスト'));
    const row = db.prepare('SELECT login_id, secret FROM credentials WHERE site_id = ?').get('dmm');
    check('DBに平文が入っていない', !Buffer.from(row.login_id).toString('utf8').includes(ID));

    console.log('\n== DBの行が消えても戻る ==');
    db.prepare('DELETE FROM credentials').run();
    store = new CredentialStore(db, dir); // 起動し直し相当（読み取り結果はプロセス内でキャッシュされる）
    const r2 = store.reveal('dmm');
    check('控えから読める', r2.loginId === ID && r2.password === PW);
    const restored = db.prepare('SELECT count(*) AS c FROM credentials').get().c;
    check('DBの行が直っている', restored === 1);

    console.log('\n== DBの中身が壊れても戻る ==');
    db.prepare("UPDATE credentials SET login_id = X'00', secret = X'00'").run();
    store = new CredentialStore(db, dir);
    const r3 = store.reveal('dmm');
    check('復号できない行でも控えから読める', r3.loginId === ID && r3.password === PW);

    console.log('\n== 控えファイルが消えても DB から作り直す ==');
    fs.rmSync(path.join(dir, 'credentials.dpapi'));
    store = new CredentialStore(db, dir);
    const r3b = store.reveal('dmm');
    check('DBから読める', r3b.loginId === ID && r3b.password === PW);
    check('控えが作り直されている', fs.existsSync(path.join(dir, 'credentials.dpapi')));

    console.log('\n== 上書き保存 ==');
    const PW2 = 'new-pass-456';
    store.save('dmm', ID, PW2);
    check('同じインスタンスで新しい値', store.reveal('dmm').password === PW2);
    store = new CredentialStore(db, dir);
    check('開き直しても新しい値', store.reveal('dmm').password === PW2);
    store.save('dmm', ID, PW);

    console.log('\n== アプリを落として開き直しても残る ==');
    db.close();
    db = new Database(dbPath);
    store = new CredentialStore(db, dir);
    const r4 = store.reveal('dmm');
    check('再オープン後も読める', r4.loginId === ID && r4.password === PW);

    console.log('\n== DBファイルごと消えても控えから戻る ==');
    db.close();
    for (const f of ['library.db', 'library.db-wal', 'library.db-shm']) {
      fs.rmSync(path.join(dir, f), { force: true });
    }
    db = new Database(dbPath);
    db.exec(`CREATE TABLE credentials (site_id TEXT PRIMARY KEY, login_id BLOB, secret BLOB, updated_at INTEGER NOT NULL)`);
    store = new CredentialStore(db, dir);
    const summary = store.list();
    check('一覧に出る', summary.some((s) => s.siteId === 'dmm' && s.hasPassword));
    const r5 = store.reveal('dmm');
    check('中身も一致する', r5.loginId === ID && r5.password === PW);

    console.log('\n== 削除 ==');
    store.clear('dmm');
    check('削除後は読めない', store.reveal('dmm').password === null);
    check('開き直しても読めない', new CredentialStore(db, dir).reveal('dmm').password === null);
    check('控えからも消えている', !JSON.parse(fs.readFileSync(path.join(dir, 'credentials.dpapi'), 'utf8')).items.dmm);

    db.close();
  } catch (err) {
    console.error('TEST_ERROR', err && err.stack ? err.stack : err);
    failures.push('例外');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (failures.length) {
      console.error(`\nNG: ${failures.length} 件失敗`);
      app.exit(1);
    } else {
      console.log('\nOK');
      app.exit(0);
    }
  }
});
