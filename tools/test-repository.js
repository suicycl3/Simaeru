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
    buildSync({ stdin: { contents: "export * from './src/main/db/database'; export { Repo } from './src/main/db/repo';", resolveDir: root, loader: 'ts' }, outfile,
      bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'], alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'error' });
    const { openDatabase, closeDatabase, Repo } = require(outfile);
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
    close(); close = null;
    fs.rmSync(work, { recursive: true, force: true });
    app.exit(0);
  } catch (error) { console.error(error); close?.(); app.exit(1); }
});
