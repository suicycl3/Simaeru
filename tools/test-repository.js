// Disposable SQLite database: no user library or real file moves.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mylibrary-repository-'));
app.setPath('userData', work);
app.whenReady().then(async () => {
  let close;
  try {
    const outfile = path.join(root, 'out/test/repository-contract.cjs');
    buildSync({ stdin: { contents: "export * from './src/main/db/database'; export { Repo } from './src/main/db/repo'; export { MIGRATIONS } from './src/main/db/schema';", resolveDir: root, loader: 'ts' }, outfile,
      bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'], alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'error' });
    const { openDatabase, closeDatabase, Repo, MIGRATIONS } = require(outfile);
    close = closeDatabase;
    const { db } = openDatabase(work);
    const repo = new Repo(db);
    for (const [id, site, title, maker, date, tags] of [
      ['a', 'dmm', 'Alpha One', 'Maker A', '2026-01-01', ['tag1', 'tag2']],
      ['b', 'dlsite', 'Alpha Two', 'Maker B', '2026-02-01', ['tag1']],
      ['c', 'dmm', 'Gamma', 'Maker A', null, []]
    ]) repo.upsertProduct({ siteId: site, floorId: 'doujin', productId: id, title, maker, purchasedAt: date, tags,
      description: `description-${id}`, creators: [{ role: 'author', name: `creator-${id}`, id: null }] });
    const ids = Object.fromEntries(repo.queryLibrary({}).items.map(p => [p.productId, p.id]));
    const keys = q => repo.queryLibrary(q).items.map(p => p.productId);
    assert.deepEqual(keys({ search: 'Alpha', sortKey: 'title', sortDir: 'asc' }), ['a', 'b']);
    assert.deepEqual(keys({ search: 'description-c', searchFields: ['description'] }), ['c']);
    assert.deepEqual(keys({ floors: ['dmm:doujin'], makers: ['Maker A'], tags: ['tag1', 'tag2'], creators: ['creator-a'] }), ['a']);
    assert.deepEqual(keys({ siteIds: ['dlsite'] }), ['b']);
    assert.deepEqual(keys({ sortKey: 'purchased', sortDir: 'asc' }), ['a', 'b', 'c']);
    assert.deepEqual(keys({ sortKey: 'purchased', sortDir: 'desc' }), ['b', 'a', 'c']);
    const page = repo.queryLibrary({ search: 'Alpha', sortKey: 'title', sortDir: 'asc', limit: 1, offset: 1 });
    assert.equal(page.total, 2); assert.equal(page.items[0].productId, 'b');
    assert.deepEqual(repo.queryLibraryIds({ search: 'Alpha', sortKey: 'title', sortDir: 'asc', limit: 1, offset: 1 }), [ids.a, ids.b]);
    const invalid = repo.queryLibrary({ search: '[', useRegex: true });
    assert.equal(invalid.total, 0); assert(invalid.regexError);
    repo.setFavorite(ids.b, true);
    assert.deepEqual(keys({ favoriteOnly: true }), ['b']);
    assert.equal(repo.getProduct(ids.a).creators[0].name, 'creator-a');
    console.log('PASS query: FTS, fields, combined filters, null ordering, pagination, all IDs and invalid regex');

    const from = 'C:\\fixture\\original', to = 'C:\\fixture\\moved';
    repo.addLocalFile({ productRef: ids.a, path: from, sizeBytes: 100, kind: 'folder', source: 'import' });
    repo.addLocalFile({ productRef: ids.a, path: 'C:\\fixture\\derived', sizeBytes: 20, kind: 'folder', source: 'extract', derivedFrom: from });
    assert.deepEqual(keys({ localState: 'have' }), ['a']);
    const signature = repo.localFileSignature(ids.a);
    repo.updateLocalFileSize(from, 101);
    assert.notEqual(repo.localFileSignature(ids.a), signature);
    repo.setContentCache(ids.a, 'signature', '{}', '{}');
    assert.equal(repo.getContentCache(ids.a).signature, 'signature');
    assert.equal(await repo.markMissingFilesAsync(async () => false), 2);
    assert.deepEqual(repo.allLocalPaths(), []);
    assert.deepEqual(keys({ localState: 'have' }), []);
    assert.equal(repo.markMissingFiles(() => true), 2);
    repo.upsertInstallation({ productRef: ids.a, kind: 'folder', installPath: from, executablePath: from + '\\run.exe', state: 'installed' });
    db.exec("CREATE TRIGGER fail_relocation BEFORE UPDATE ON installations BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    assert.throws(() => repo.relocatePath(from, to), /fixture failure/);
    assert(repo.allLocalPaths().includes(from));
    assert.equal(repo.extractedFrom(from).path, 'C:\\fixture\\derived');
    assert.equal(repo.getProduct(ids.a).installation.executablePath, from + '\\run.exe');
    db.exec('DROP TRIGGER fail_relocation');
    repo.relocatePath(from, to);
    assert(!repo.allLocalPaths().includes(from)); assert(repo.allLocalPaths().includes(to));
    assert.equal(repo.extractedFrom(to).path, 'C:\\fixture\\derived');
    assert.equal(repo.getProduct(ids.a).installation.executablePath, to + '\\run.exe');
    repo.deleteContentCache(ids.a); assert.equal(repo.getContentCache(ids.a), null);
    console.log('PASS local files: signatures, cache, missing/restored state, atomic relocation rollback and references');
    // ♡「使った」とプレイリスト
    repo.setUsed(ids.a, true, 1700000000000);
    assert.equal(repo.getProduct(ids.a).viewedAt, 1700000000000);
    // 閲覧の印は設定で切れる。既定はオン
    assert.equal(repo.autoUsed(), true);
    repo.markViewed(ids.c);
    assert.notEqual(repo.getProduct(ids.c).viewedAt, null);
    repo.setUsed(ids.c, false);
    repo.setAutoUsed(false);
    repo.markViewed(ids.c);
    assert.equal(repo.getProduct(ids.c).viewedAt, null); // オフなら閲覧では付かない
    repo.setUsed(ids.c, true); // 手で押すぶんは、設定に関係なく付く
    assert.notEqual(repo.getProduct(ids.c).viewedAt, null);
    repo.setUsed(ids.c, false);
    repo.setAutoUsed(true);
    assert.equal(repo.usedCount(), 1);
    assert.deepEqual(keys({ usedOnly: true }), ['a']); // サイドバーの「使った」
    repo.setUsed(ids.a, false);
    assert.equal(repo.getProduct(ids.a).viewedAt, null);
    assert.equal(repo.usedCount(), 0);
    assert.deepEqual(keys({ usedOnly: true }), []);
    const list = repo.createPlaylist('あとで');
    assert.equal(repo.createPlaylist('あとで').id, list.id); // 同じ名前は作り直さない
    assert.equal(repo.addToPlaylist(list.id, [ids.b, ids.a]), 2);
    assert.equal(repo.addToPlaylist(list.id, [ids.a]), 0); // 二重には入らない
    assert.equal(repo.getPlaylist(list.id).count, 2);
    assert.deepEqual(keys({ playlistId: list.id, sortKey: 'playlist', sortDir: 'asc' }), ['b', 'a']); // 入れた順
    assert.deepEqual(keys({ playlistId: list.id, sortKey: 'playlist', sortDir: 'desc' }), ['a', 'b']);
    assert.deepEqual(repo.playlistsOf(ids.a).map(x => x.id), [list.id]);
    repo.renamePlaylist(list.id, 'あとで見る');
    assert.equal(repo.listPlaylists()[0].name, 'あとで見る');
    assert.equal(repo.removeFromPlaylist(list.id, [ids.b]), 1);
    assert.deepEqual(keys({ playlistId: list.id }), ['a']);
    const other = repo.createPlaylist('別の一覧');
    repo.addToPlaylist(other.id, [ids.a]);
    repo.deletePlaylist(other.id);
    assert.deepEqual(repo.listPlaylists().map(x => x.id), [list.id]); // 消すと中身も一緒に消える
    assert.deepEqual(repo.playlistsOf(ids.a).map(x => x.id), [list.id]);
    console.log('PASS playlists: 使った印、重複しない追加、並び順、名前変更、削除の連鎖');
    // v29: 項目表を読めないまま取得済みになった PC ゲーム・同人だけを取り直させる
    for (const [id, floor, tags] of [
      ['g-empty', 'dlsoft', []], ['g-api', 'dlsoft', ['ブラウザ対応']], ['g-full', 'dlsoft', ['ADV', '学園', '恋愛']],
      ['d-empty', 'doujin', []], ['b-empty', 'book', []]
    ]) repo.upsertProduct({ siteId: 'dmm', floorId: floor, productId: id, title: id, tags });
    const refOf = (pid) => db.prepare('SELECT id FROM products WHERE product_id = ?').get(pid).id;
    for (const pid of ['g-empty', 'g-api', 'g-full', 'd-empty', 'b-empty']) repo.markMetaFetched(refOf(pid), 1);
    db.exec(MIGRATIONS[28]);
    const refetch = db.prepare("SELECT product_id FROM products WHERE product_id IN ('g-empty','g-api','g-full','d-empty','b-empty') AND meta_fetched_at IS NULL ORDER BY product_id").all().map(r => r.product_id);
    assert.deepEqual(refetch, ['d-empty', 'g-api', 'g-empty']);
    console.log('PASS migration v29: 項目表を読めていない PC ゲーム・同人だけ取り直す（電子書籍・タグの揃った作品はそのまま）');

    // 同期が詳細のジャンル・スタッフを消さない（同期が書いたぶんだけ差し替える）
    const circle = { role: 'サークル', name: 'サークルA', id: null };
    const sync = (tags, creators = [circle]) => repo.upsertMany([{ siteId: 'dmm', floorId: 'doujin', productId: 'sync-1', title: 'sync-1', tags, creators }]);
    const row = () => repo.getProduct(refOf('sync-1'));
    sync(['DLゲーム']);
    // 詳細の取得（店舗ページ）: 同期のタグに足し、スタッフも足す
    repo.upsertProduct({ siteId: 'dmm', floorId: 'doujin', productId: 'sync-1', title: 'sync-1',
      tags: ['DLゲーム', '巨乳', '制服'], creators: [{ ...circle, id: '28593' }, { role: '作者', name: '作者B', id: null }] });
    sync(['DLゲーム', 'クラウドゲーム']);
    assert.deepEqual(row().tags, ['DLゲーム', 'クラウドゲーム', '巨乳', '制服']);
    assert.deepEqual(row().creators.map(c => `${c.role}:${c.name}:${c.id}`), ['サークル:サークルA:28593', '作者:作者B:null']);
    // 同期の一覧から消えたタグは消える（詳細のタグは残る）
    sync([]);
    assert.deepEqual(row().tags, ['巨乳', '制服']);
    // この仕組みより前に書いた行（同期のぶんが分からない）は、今あるタグを全部残す
    repo.upsertProduct({ siteId: 'dmm', floorId: 'doujin', productId: 'legacy-1', title: 'legacy-1', tags: ['旧', 'タグ'] });
    repo.upsertMany([{ siteId: 'dmm', floorId: 'doujin', productId: 'legacy-1', title: 'legacy-1', tags: ['DLゲーム'] }]);
    assert.deepEqual(repo.getProduct(refOf('legacy-1')).tags, ['DLゲーム', '旧', 'タグ']);
    console.log('PASS sync merge: 同期は同期が書いたタグ・作者だけを差し替え、詳細のジャンル・スタッフは残す');

    // v30: 取得のあとに同期されてタグが 2 件以下に減った作品を取り直させる（列の追加は済んでいるので UPDATE だけ流す）
    for (const pid of ['w-wiped', 'w-full', 'w-before']) repo.upsertProduct({ siteId: 'dmm', floorId: 'dlsoft', productId: pid, title: pid,
      tags: pid === 'w-full' ? ['ADV', '学園', '恋愛'] : ['ブラウザ対応'] });
    db.prepare("UPDATE products SET meta_fetched_at = 1000, last_synced_at = 5000 WHERE product_id IN ('w-wiped', 'w-full')").run();
    db.prepare("UPDATE products SET meta_fetched_at = 5000, last_synced_at = 5000 WHERE product_id = 'w-before'").run();
    db.exec(MIGRATIONS[29].slice(MIGRATIONS[29].indexOf('UPDATE')));
    assert.deepEqual(db.prepare("SELECT product_id FROM products WHERE product_id LIKE 'w-%' AND meta_fetched_at IS NULL").all().map(r => r.product_id), ['w-wiped']);
    console.log('PASS migration v30: 同期でタグが減った作品だけ取り直す');

    // 同期と詳細の両方にあったタグ・作者は、同期の一覧から消えても詳細のぶんとして残す
    const both = (tags, creators) => repo.upsertMany([{ siteId: 'dmm', floorId: 'doujin', productId: 'both-1', title: 'both-1', tags, creators }]);
    const bothRow = () => repo.getProduct(refOf('both-1'));
    both(['ブラウザ対応'], [circle]);
    const detailCreators = [{ ...circle, id: '28593' }];
    repo.upsertProduct({ siteId: 'dmm', floorId: 'doujin', productId: 'both-1', title: 'both-1',
      tags: ['ブラウザ対応', '学園'], creators: detailCreators, detailTags: ['ブラウザ対応', '学園'], detailCreators });
    both([], []);
    assert.deepEqual(bothRow().tags, ['ブラウザ対応', '学園']);
    assert.deepEqual(bothRow().creators.map(c => `${c.role}:${c.name}:${c.id}`), ['サークル:サークルA:28593']);
    // 詳細を取れなかった書き込み（detailTags を渡さない）は、前に覚えた詳細のぶんを消さない
    repo.upsertProduct({ siteId: 'dmm', floorId: 'doujin', productId: 'both-1', title: 'both-1', tags: ['ブラウザ対応', '学園'] });
    both([], []);
    assert.deepEqual(bothRow().tags, ['ブラウザ対応', '学園']);
    console.log('PASS sync merge: 同期と詳細の両方にあったタグ・作者は、同期から消えても残す');

    // v31: 試行回数を使い切った PC ゲーム・同人（店舗ページ 404 など）を一度だけ取り直させる
    for (const [pid, floor, attempts, fetched] of [
      ['x-gone', 'dlsoft', 3, null], ['x-fresh', 'doujin', 1, null], ['x-done', 'dlsoft', 3, 1000], ['x-book', 'book', 3, null]
    ]) {
      repo.upsertProduct({ siteId: 'dmm', floorId: floor, productId: pid, title: pid });
      db.prepare('UPDATE products SET meta_attempts = ?, meta_fetched_at = ? WHERE product_id = ?').run(attempts, fetched, pid);
    }
    db.exec(MIGRATIONS[30].slice(MIGRATIONS[30].indexOf('UPDATE')));
    assert.deepEqual(db.prepare("SELECT product_id, meta_attempts FROM products WHERE product_id LIKE 'x-%' ORDER BY product_id").all().map(r => `${r.product_id}:${r.meta_attempts}`),
      ['x-book:3', 'x-done:3', 'x-fresh:1', 'x-gone:0']);
    console.log('PASS migration v31: 試行回数を使い切った PC ゲーム・同人だけ取り直す');
    close(); close = null;
    // 動いている Electron が userData（この一時フォルダの中）を掴んでいて消せないことがある。後片付けの失敗で終われなくならないようにする
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 一時フォルダは OS が片付ける */ }
    app.exit(0);
  } catch (error) { console.error(error); close?.(); app.exit(1); }
});
