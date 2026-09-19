/**
 * 手元のファイルまわりの確認: 未インストールの判定・中身の作り置き・保存先を変えたときの移動。
 *   npx electron tools/test-library-local.js
 *
 * **本物の userData やライブラリには書かない。** 使い捨てフォルダで試す。
 * 別ドライブへの移動は、D: があれば D:\mylib-test-* を作って試し、終わったら消す。
 * 結果は %TEMP%\test-library-local-result.txt にも出る。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { app, protocol, BrowserWindow } = require('electron');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'out', 'test');
fs.mkdirSync(outDir, { recursive: true });
const build = (entry, name) => {
  const outfile = path.join(outDir, name);
  esbuild.buildSync({
    entryPoints: [path.join(root, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'better-sqlite3'],
    alias: { '@shared': path.join(root, 'src', 'shared') },
    logLevel: 'error'
  });
  return require(outfile);
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'library-local-test-'));
const otherDrive = fs.existsSync('D:\\') ? fs.mkdtempSync('D:\\mylib-test-') : null;
app.setPath('userData', path.join(work, 'userData'));
app.on('window-all-closed', () => undefined);
protocol.registerSchemesAsPrivileged([{ scheme: 'mylib', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const failures = [];
const lines = [];
const resultFile = path.join(os.tmpdir(), 'test-library-local-result.txt');
const log = (line) => {
  console.log(line);
  lines.push(line);
};
const check = (label, ok, detail) => {
  log(`${ok ? '  ok ' : '  NG '} ${label}${ok || detail === undefined ? '' : `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})`}`);
  if (!ok) failures.push(label);
};

function storedZip(file, entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(data) >>> 0 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    chunks.push(local, n, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x800, 8);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(n.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([...chunks, cd, end]));
}

app.whenReady().then(async () => {
  try {
    const { openDatabase, closeDatabase } = build('src/main/db/database.ts', 'database.local.cjs');
    const { Repo } = build('src/main/db/repo.ts', 'repo.local.cjs');
    const { ContentCache } = build('src/main/content/contentCache.ts', 'contentCache.local.cjs');
    const { planRelocation, moveItem } = build('src/main/download/relocate.ts', 'relocate.local.cjs');
    const { productFolder, DEFAULT_TEMPLATE, LEGACY_DEFAULT_TEMPLATE } = build('src/main/download/paths.ts', 'paths.local.cjs');

    const { db } = openDatabase(path.join(work, 'userData'));
    const repo = new Repo(db);
    const now = Date.now();
    const addProduct = (productId, workType, category, maker = 'サークルA') =>
      Number(
        db
          .prepare(
            `INSERT INTO products (site_id, floor_id, product_id, title, maker, first_seen_at, last_synced_at, category, work_type)
             VALUES ('dlsite', 'library', ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(productId, `作品 ${productId}`, maker, now, now, category, workType).lastInsertRowid
      );

    // ── 未インストール ──
    log('== ダウンロード済み・未インストール ==');
    const oldRoot = path.join(work, 'OldRoot');
    const game = addProduct('RJGAME1', 'game', 'doujin');
    const vjGame = addProduct('VJGAME1', null, 'game');
    const voice = addProduct('VJVOICE1', 'voice', 'game');
    const noFiles = addProduct('RJGAME2', 'game', 'doujin');
    const gameZip = path.join(oldRoot, 'DLsite', '同人', 'サークルA', '[サークルA] 作品 RJGAME1', 'RJGAME1.zip');
    storedZip(gameZip, [{ name: 'Game/Game.exe', data: Buffer.from('exe') }, { name: 'Game/data.pak', data: Buffer.alloc(100) }]);
    repo.addLocalFile({ productRef: game, path: gameZip, sizeBytes: fs.statSync(gameZip).size, kind: 'archive', source: 'download' });
    const vjZip = path.join(oldRoot, 'DLsite', 'PCゲーム', 'サークルA', '[サークルA] 作品 VJGAME1', 'VJGAME1.zip');
    storedZip(vjZip, [{ name: 'setup.exe', data: Buffer.from('x') }]);
    repo.addLocalFile({ productRef: vjGame, path: vjZip, sizeBytes: 1, kind: 'archive', source: 'download' });
    const voiceZip = path.join(oldRoot, 'DLsite', 'PCゲーム', 'サークルA', '[サークルA] 作品 VJVOICE1', 'VJVOICE1.zip');
    storedZip(voiceZip, [{ name: '本編/01.mp3', data: Buffer.alloc(2000, 1) }, { name: 'jacket.jpg', data: Buffer.alloc(500, 2) }]);
    repo.addLocalFile({ productRef: voice, path: voiceZip, sizeBytes: fs.statSync(voiceZip).size, kind: 'archive', source: 'download' });

    const flag = (id) => repo.getProduct(id).needsInstall;
    check('手元にあるゲームは未インストール', flag(game) === true);
    check('PCゲーム区分で種別不明も未インストール', flag(vjGame) === true);
    check('PCゲーム区分でもボイスは対象外', flag(voice) === false);
    check('手元に無いゲームは対象外', flag(noFiles) === false);
    const list = repo.queryLibrary({ localState: 'notInstalled', limit: 50 }).items.map((p) => p.productId).sort();
    check('「未インストール」で絞り込める', JSON.stringify(list) === JSON.stringify(['RJGAME1', 'VJGAME1']), list);
    check('件数', repo.localCounts().notInstalled === 2, repo.localCounts());
    repo.upsertInstallation({ productRef: game, kind: 'managed', installPath: path.dirname(gameZip), executablePath: path.join(path.dirname(gameZip), 'RJGAME1', 'Game.exe') });
    check('起動を紐付けたら未インストールではなくなる', flag(game) === false && repo.localCounts().notInstalled === 1);
    // DMM GAMES PLAYER と紐付けたもの（起動ファイルは持たない）も「導入済み」
    repo.upsertInstallation({ productRef: vjGame, kind: 'dmm_game_player', installPath: 'D:\\DMMGames\\x', executablePath: null, uninstallKey: 'dgp:AMAIN:gp_test' });
    check('DMM GAMES PLAYER と紐付けても未インストールではなくなる', flag(vjGame) === false && repo.localCounts().notInstalled === 0);

    // 紐付けで起動できる作品は、アプリ経由のファイルが無くても「ダウンロード済み」
    const dgpOnlyGame = addProduct('sample_test', 'game', 'game');
    db.prepare('UPDATE products SET tags = ? WHERE id = ?').run(JSON.stringify(['DMM GAMES PLAYER専用']), dgpOnlyGame);
    const haveBefore = repo.localCounts().have;
    repo.upsertInstallation({ productRef: dgpOnlyGame, kind: 'dmm_game_player', installPath: 'D:\\DMMGames\\samplesoft', executablePath: null, uninstallKey: 'dgp:AMAIN:gp_waffle' });
    const haveIds = repo.queryLibrary({ localState: 'have', limit: 200 }).items.map((p) => p.productId);
    check('紐付けたものはファイルが無くても「ダウンロード済み」', repo.localCounts().have === haveBefore + 1 && haveIds.includes('sample_test'), repo.localCounts());
    check('紐付けたものは「未取得」に入らない', !repo.queryLibrary({ localState: 'none', limit: 500 }).items.some((p) => p.productId === 'sample_test'));
    const installedIds = repo.queryLibrary({ localState: 'installed', limit: 200 }).items.map((p) => p.productId).sort();
    check('「インストール済み」は紐付けが済んだもの（ファイルの有無によらない）', JSON.stringify(installedIds) === JSON.stringify(['RJGAME1', 'VJGAME1', 'sample_test'].sort()) && repo.localCounts().installed === 3, { installedIds, counts: repo.localCounts() });

    // 紐付けの候補
    {
      const { findLinkCandidates, DGP_MIN_SCORE, PROGRAM_MIN_SCORE } = build('src/main/install/linkCandidates.ts', 'linkCandidates.local.cjs');
      const dgpTarget = addProduct('samplesoft_0106', 'game', 'game');
      db.prepare("UPDATE products SET title = 'サンプル作品…… 特別版', maker = 'SampleSoft', tags = ? WHERE id = ?").run(JSON.stringify(['DMM GAMES PLAYER専用']), dgpTarget);
      const progTarget = addProduct('VJPROG1', 'game', 'game');
      db.prepare("UPDATE products SET title = 'ひだまりの向こうがわ', maker = 'サンプルソフト' WHERE id = ?").run(progTarget);
      const noneTarget = addProduct('VJNONE1', 'game', 'game');
      db.prepare("UPDATE products SET title = 'まったく別のゲーム' WHERE id = ?").run(noneTarget);
      const targets = repo.linkCandidateTargets();
      check('候補を探す対象は、まだ紐付けていないゲームと DMM GAMES PLAYER 専用の作品', targets.some((x) => x.id === dgpTarget) && targets.some((x) => x.id === progTarget) && !targets.some((x) => x.id === dgpOnlyGame) && !targets.some((x) => x.id === vjGame));
      const found = findLinkCandidates(targets, {
        dgpGames: [
          { gameType: 'AMAIN', productId: 'gp_7lwx46c8', path: 'D:\\DMMGames\\SampleSoft_koukan', exe: null },
          { gameType: 'AMAIN', productId: 'gp_sample', path: 'D:\\DMMGames\\samplesoft', exe: null }
        ],
        programs: [
          { key: 'HKLM\\...\\hidamari', displayName: 'ひだまりの向こうがわ', publisher: 'サンプルソフト', installLocation: 'C:\\Games\\hidamari', displayIcon: null, version: null },
          { key: 'HKLM\\...\\edge', displayName: 'Microsoft Edge', publisher: 'Microsoft', installLocation: null, displayIcon: null, version: null }
        ],
        linkedKeys: repo.linkedKeys()
      });
      check('DMM GAMES PLAYER 専用の作品は、DMM GAMES PLAYER のゲームから候補を選ぶ', found.get(dgpTarget)?.kind === 'dgp' && found.get(dgpTarget)?.name === 'SampleSoft_koukan' && found.get(dgpTarget).score >= DGP_MIN_SCORE, found.get(dgpTarget));
      check('ほかのゲームは、導入済みプログラムから候補を選ぶ', found.get(progTarget)?.kind === 'program' && found.get(progTarget)?.name === 'ひだまりの向こうがわ' && found.get(progTarget).score >= PROGRAM_MIN_SCORE, found.get(progTarget));
      check('似ていなければ候補にしない', found.get(noneTarget) === null, found.get(noneTarget));
      check('別の作品に紐付けている相手は候補にしない', ![...found.values()].some((c) => c && c.name === 'samplesoft'));
      repo.setLinkCandidates(found);
      // ファイルがある候補付きのゲームは、未インストールではなく「紐付け候補あり」に数える
      repo.addLocalFile({ productRef: progTarget, path: path.join(work, 'hidamari.zip'), sizeBytes: 1, kind: 'archive', source: 'download' });
      const counts = repo.localCounts();
      const linkable = repo.queryLibrary({ localState: 'linkable', limit: 50 }).items.map((p) => p.productId).sort();
      const notInstalled = repo.queryLibrary({ localState: 'notInstalled', limit: 50 }).items.map((p) => p.productId);
      check('候補のある作品は「紐付け候補あり」', JSON.stringify(linkable) === JSON.stringify(['VJPROG1', 'samplesoft_0106']) && counts.linkable === 2, { linkable, counts });
      check('候補のある作品は「未インストール」に入らない', !notInstalled.includes('VJPROG1'), notInstalled);
      check('作品の情報にも候補が載る', repo.getProduct(dgpTarget).linkCandidate?.kind === 'dgp');
      repo.upsertInstallation({ productRef: progTarget, kind: 'linked_existing', installPath: 'C:\\Games\\hidamari', executablePath: 'C:\\Games\\hidamari\\hidamari.exe', uninstallKey: 'HKLM\\...\\hidamari' });
      check('紐付けたら候補ありから外れる', !repo.queryLibrary({ localState: 'linkable', limit: 50 }).items.some((p) => p.productId === 'VJPROG1') && repo.localCounts().linkable === 1);
      for (const id of [dgpTarget, progTarget, noneTarget]) db.prepare('DELETE FROM products WHERE id = ?').run(id);
    }
    db.prepare('DELETE FROM products WHERE id = ?').run(dgpOnlyGame);

    // 利用日順: 起動した日時と中身を見た日時の新しい方（値の無いものは向きによらず後ろ）
    repo.markLaunched(vjGame);
    db.prepare('UPDATE installations SET last_launched_at = ? WHERE product_ref = ?').run(Date.now() - 60_000, vjGame);
    repo.markViewed(voice);
    const ids = (q) => repo.queryLibrary({ ...q, limit: 50 }).items.map((p) => p.productId);
    const used = ids({ sortKey: 'used', sortDir: 'desc' });
    check('利用日順: 見た作品と起動した作品を新しい順に並べる', used[0] === repo.getProduct(voice).productId && used[1] === 'VJGAME1', used);
    const usedAsc = ids({ sortKey: 'used', sortDir: 'asc' });
    check('古い順でも使っていないものは後ろ', usedAsc[0] === 'VJGAME1' && usedAsc[1] === repo.getProduct(voice).productId, usedAsc);

    // ── 中身の作り置き ──
    log('\n== 中身の作り置き ==');
    const updated = [];
    const cache = new ContentCache({ repo, sevenZip: () => null, onUpdated: (id) => updated.push(id) });
    check('最初は作り置きが無い', cache.get(voice) === null);
    const built = await cache.getOrBuild(voice);
    check('作ると中身が分かる（アーカイブのまま）', built.index.audioGroups.length === 1 && built.index.images.length === 1 && built.index.storage?.mode === 'archive', built.index.audioGroups.map((g) => g.folder));
    const again = cache.get(voice);
    check('2回目は作り置きをそのまま返す（fresh）', again && again.fresh && again.index.images.length === 1);
    const t0 = Date.now();
    for (let i = 0; i < 50; i++) cache.get(voice);
    check('作り置きを返すのは速い（50回で 200ms 未満）', Date.now() - t0 < 200, `${Date.now() - t0}ms`);

    const extra = path.join(path.dirname(voiceZip), 'おまけ.zip');
    storedZip(extra, [{ name: '特典/02.mp3', data: Buffer.alloc(1000, 3) }]);
    repo.addLocalFile({ productRef: voice, path: extra, sizeBytes: fs.statSync(extra).size, kind: 'archive', source: 'download' });
    const stale = cache.get(voice);
    check('台帳が変わったら古い作り置きを返しつつ作り直しを予約する', stale && stale.fresh === false);
    for (let i = 0; i < 50 && !updated.includes(voice); i++) await new Promise((r) => setTimeout(r, 50));
    check('作り直しが済むと知らせる', updated.includes(voice));
    check('作り直した中身に増えたファイルが入る', cache.get(voice).index.audioGroups.length === 2 && cache.get(voice).fresh);

    fs.rmSync(extra);
    const changed = await cache.verify(voice);
    check('開いたときの確認で、消えたファイルに気づく', changed === true && repo.localFiles(voice).find((f) => f.path === extra).missingAt !== null);
    repo.removeLocalFile(extra);

    // ── 保存先・フォルダ構成に合わせた移動 ──
    log('\n== 保存先を変えたときの移動 ==');
    check('既定のフォルダ構成はサークルの下を種別で分ける', DEFAULT_TEMPLATE.includes('{maker}/{workType}/'), DEFAULT_TEMPLATE);
    check('以前の既定とは別', LEGACY_DEFAULT_TEMPLATE !== DEFAULT_TEMPLATE);
    const voiceProduct = repo.getProduct(voice);
    check('種別のフォルダ名（ボイス・ASMR）', productFolder('X:\\Lib', DEFAULT_TEMPLATE, voiceProduct).includes('\\サークルA\\ボイス・ASMR\\'), productFolder('X:\\Lib', DEFAULT_TEMPLATE, voiceProduct));

    // 取り込みで紐付けた、保存先の外のファイル（ユーザーが自分で整理している）
    const outside = path.join(work, 'MyOwnFolder', 'RJGAME2.zip');
    storedZip(outside, [{ name: 'a.txt', data: Buffer.from('a') }]);
    repo.addLocalFile({ productRef: noFiles, path: outside, sizeBytes: 1, kind: 'archive', source: 'scan' });
    // 展開済みフォルダ（ゲーム）とダウンロード履歴
    const gameFolder = path.join(path.dirname(gameZip), 'RJGAME1');
    fs.mkdirSync(gameFolder, { recursive: true });
    fs.writeFileSync(path.join(gameFolder, 'Game.exe'), 'exe');
    repo.addLocalFile({ productRef: game, path: gameFolder, sizeBytes: 3, kind: 'folder', source: 'extract', derivedFrom: gameZip });
    repo.upsertDownload({ productRef: game, label: '本体', linkKind: 'main', linkIndex: 0, state: 'done' });
    db.prepare('UPDATE downloads SET save_path = ? WHERE product_ref = ?').run(gameZip, game);

    const newRoot = otherDrive ?? path.join(work, 'NewRoot');
    const plan = await planRelocation(repo, newRoot, DEFAULT_TEMPLATE, [oldRoot]);
    const froms = plan.items.map((i) => i.from).sort();
    check('保存先の中のファイルだけを移す（取り込んだ外のファイルは動かさない）', !froms.includes(outside) && froms.includes(gameZip) && froms.includes(gameFolder) && froms.includes(voiceZip), froms);
    const voiceItem = plan.items.find((i) => i.from === voiceZip);
    check('移し先は新しい保存先・種別のフォルダ', voiceItem.to.startsWith(newRoot) && voiceItem.to.includes('\\ボイス・ASMR\\'), voiceItem.to);
    check('別ドライブかどうかを見分ける', voiceItem.crossDevice === !!otherDrive, voiceItem);

    for (const item of plan.items) {
      const placed = await moveItem(item, [oldRoot, newRoot]);
      repo.relocatePath(item.from, placed);
    }
    const movedZip = plan.items.find((i) => i.from === gameZip).to;
    const movedFolder = plan.items.find((i) => i.from === gameFolder).to;
    check('ファイルが移っている', fs.existsSync(movedZip) && !fs.existsSync(gameZip) && fs.existsSync(path.join(movedFolder, 'Game.exe')), otherDrive ? '別ドライブ' : '同じドライブ');
    check('台帳のパスが付け替わる', repo.localFiles(game).map((f) => f.path).sort().join('|') === [movedFolder, movedZip].sort().join('|'));
    check('展開元の記録も付け替わる', repo.localFiles(game).find((f) => f.kind === 'folder').derivedFrom === movedZip);
    check('ダウンロード履歴の保存先も付け替わる', db.prepare('SELECT save_path FROM downloads WHERE product_ref = ?').get(game).save_path === movedZip);
    check('インストールの起動ファイル（配下の exe）も付け替わる', repo.getProduct(game).installation.executablePath === path.join(movedFolder, 'Game.exe'), repo.getProduct(game).installation);
    check('空になった古いフォルダは片付く', !fs.existsSync(path.dirname(gameZip)));
    check('取り込んだ外のファイルはそのまま', fs.existsSync(outside));
    const after = await planRelocation(repo, newRoot, DEFAULT_TEMPLATE, [oldRoot]);
    check('移したあとは移すものが無い', after.items.length === 0, after.items.map((i) => i.from));

    // ── ダウンロードし直し ──
    log('\n== ダウンロードし直し（MP3だけ残した作品を元に戻す） ==');
    {
      const { DownloadManager } = build('src/main/download/downloadManager.ts', 'downloadManager.local.cjs');
      const dm = new DownloadManager({ repo, fetchDetail: async () => null, onProgress: () => undefined });
      dm.pump = () => undefined; // 実際には落とさない（キューの状態だけを見る）
      const vid = addProduct('RJREDL', 'voice', 'doujin');
      db.prepare('UPDATE products SET links = ? WHERE id = ?').run(JSON.stringify([{ label: 'ダウンロード', url: 'https://example.invalid/x.zip', kind: 'download' }]), vid);
      const dir = path.join(work, 'redl');
      fs.mkdirSync(dir, { recursive: true });
      const pruned = path.join(dir, 'RJREDL.zip');
      const queued = await dm.enqueue([vid]);
      const row = repo.listDownloads().find((d) => d.productRef === vid);
      fs.writeFileSync(pruned, 'mp3 only');
      repo.addLocalFile({ productRef: vid, path: pruned, sizeBytes: 8, kind: 'archive', source: 'lossy' });
      check('台帳の出どころは作り直しで変わる（lossy）', repo.localFiles(vid)[0].source === 'lossy', repo.localFiles(vid)[0]);
      repo.updateDownload(row.id, { state: 'done', savePath: pruned });
      check('取得済みの作品は「アプリでダウンロード」では積まない（0 件）', (await dm.enqueue([vid])) === 0 && queued === 1);

      // 取り込みで見つけた作品（ダウンロードの行が無い）も、手元にあれば積まない
      const imported = addProduct('RJIMPORT', 'voice', 'doujin');
      db.prepare('UPDATE products SET links = ? WHERE id = ?').run(JSON.stringify([{ label: 'ダウンロード', url: 'https://example.invalid/i.zip', kind: 'download' }]), imported);
      repo.addLocalFile({ productRef: imported, path: path.join(dir, 'RJIMPORT.zip'), sizeBytes: 1, kind: 'archive', source: 'scan' });
      check('取り込み済み（行の無い）作品は、まとめてダウンロードでも積まない', (await dm.enqueue([imported])) === 0 && !repo.listDownloads().some((d) => d.productRef === imported));
      // 手元のファイルを消したあとは、「完了」の行が残っていても最初から積み直す
      repo.removeLocalFile(path.join(dir, 'RJIMPORT.zip'));
      repo.upsertDownload({ productRef: imported, label: 'ダウンロード', linkKind: 'main', linkIndex: 0, state: 'queued' });
      const impRow = repo.listDownloads().find((d) => d.productRef === imported);
      repo.updateDownload(impRow.id, { state: 'done', savePath: path.join(dir, 'RJIMPORT.zip') });
      const requeued = await dm.enqueue([imported]);
      const impAfter = repo.listDownloads().filter((d) => d.productRef === imported);
      check('手元に無い作品は「完了」の行を消して積み直す', requeued === 1 && impAfter.length === 1 && impAfter[0].state === 'queued' && impAfter[0].savePath === null, impAfter);
      const again = await dm.redownload(vid);
      const reset = repo.getDownload(row.id);
      check('ダウンロードし直しは行を待機に戻し、保存先を消す', again === 1 && reset.state === 'queued' && reset.savePath === null && reset.receivedBytes === 0, reset);

      // 落とし終えた（名前 (2).zip で保存された）ところから、置き換えを確かめる
      const fresh = path.join(dir, 'RJREDL (2).zip');
      fs.writeFileSync(fresh, 'original with wav');
      repo.updateDownload(row.id, { state: 'running', savePath: fresh });
      const finalPath = await dm.replaceExisting(row.id, vid, fresh);
      check('元の名前に置き換わる', finalPath === pruned && fs.readFileSync(pruned, 'utf8') === 'original with wav' && !fs.existsSync(fresh), finalPath);
      const other = path.join(dir, 'Other (2).zip');
      fs.writeFileSync(other, 'x');
      check('台帳に無い名前は置き換えない', (await dm.replaceExisting(row.id, vid, other)) === other && fs.existsSync(other));
    }

    // ── キューが止まらないこと ──
    log('\n== ダウンロードのキュー（止まらない・まとめて操作） ==');
    {
      const { DownloadManager, withTimeout } = build('src/main/download/downloadManager.ts', 'downloadManager.local.cjs');
      db.prepare('DELETE FROM downloads').run();
      repo.setSetting('download.concurrency', '2');
      const withLink = (pid) => {
        const id = addProduct(pid, 'voice', 'doujin');
        db.prepare('UPDATE products SET links = ? WHERE id = ?').run(JSON.stringify([{ label: 'ダウンロード', url: `https://example.invalid/${pid}.zip`, kind: 'download' }]), id);
        return id;
      };
      const hang = withLink('RJHANG');
      const ok = withLink('RJOK');
      const slow = withLink('RJSLOW');
      let releaseSlow = () => undefined;
      const dm = new DownloadManager({
        repo,
        // RJHANG は URL の取り直しが返ってこない。RJSLOW は合図するまで返らない
        fetchDetail: (id) => (id === hang ? new Promise(() => undefined) : id === slow ? new Promise((r) => { releaseSlow = r; }) : Promise.resolve(null)),
        onProgress: () => undefined,
        detailTimeoutMs: 300,
        startTimeoutMs: 60_000
      });
      const started = [];
      // 実際には落とさない。ダウンロード用のウィンドウの代わりに、頼まれた URL を控えるだけ
      dm.openWindow = (rowId) => ({ webContents: { id: 5000 + rowId, downloadURL: (url) => started.push(url) }, isDestroyed: () => false, destroy: () => undefined });
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      let rejected = null;
      await withTimeout(new Promise(() => undefined), 50, '時間切れ').catch((err) => { rejected = err.message; });
      check('時間内に終わらなければ失敗にする', rejected === '時間切れ');

      await dm.enqueue([hang]);
      await dm.enqueue([ok]);
      await sleep(100);
      check('1本の準備が返ってこなくても、ほかの作品は始まる（以前はキュー全体が待機のまま止まった）', started.some((u) => u.endsWith('RJOK.zip')) && !started.some((u) => u.endsWith('RJHANG.zip')), started);
      const preparing = dm.list().find((r) => r.productRef === hang);
      check('準備中は一覧でわかる', preparing.state === 'queued' && preparing.preparing === true, preparing);
      await sleep(500);
      check('URL の取り直しが返ってこなくても、時間を区切って手元の URL で始める', started.some((u) => u.endsWith('RJHANG.zip')), started);
      check('今回のまとまりに入る', dm.list().filter((r) => r.inBatch).length === 2);

      // 準備している間に一時停止したら始めない
      dm.pending.length = 0;
      repo.setSetting('download.concurrency', '8');
      await dm.enqueue([slow]);
      const slowRow = repo.listDownloads().find((d) => d.productRef === slow);
      dm.pause(slowRow.id);
      releaseSlow(null);
      await sleep(100);
      check('準備中に一時停止したものは始めない', !started.some((u) => u.endsWith('RJSLOW.zip')) && repo.getDownload(slowRow.id).state === 'paused', repo.getDownload(slowRow.id));

      // 取得中なのに何も走っていない行は、見回りで待機に戻す
      const okRow = repo.listDownloads().find((d) => d.productRef === ok);
      dm.pending.length = 0;
      dm.pump = () => undefined;
      repo.updateDownload(okRow.id, { state: 'running' });
      dm.sweep();
      check('取得中なのに何も走っていない行は待機に戻す', repo.getDownload(okRow.id).state === 'queued');

      // まとめて操作
      repo.updateDownload(okRow.id, { state: 'error', attempts: 3, error: '失敗' });
      const hangRow = repo.listDownloads().find((d) => d.productRef === hang);
      repo.updateDownload(hangRow.id, { state: 'canceled' });
      const resumed = dm.resumeAll();
      const states = repo.listDownloads().map((d) => `${d.productRef === ok ? 'ok' : d.productRef === hang ? 'hang' : 'slow'}:${d.state}:${d.attempts}`).sort();
      check('すべて再開: 一時停止・失敗・中止を待機に戻し、失敗の回数も戻す', resumed === 3 && states.join(',') === 'hang:queued:0,ok:queued:0,slow:queued:0', states);
      const paused = dm.pauseAll();
      check('すべて一時停止: 待機も止める', paused === 3 && repo.listDownloads().every((d) => d.state === 'paused'));
      repo.updateDownload(okRow.id, { state: 'done' });
      repo.updateDownload(hangRow.id, { state: 'canceled' });
      const cleared = dm.clearFinished();
      check('完了・中止を一覧から消す（ほかは残す）', cleared === 2 && repo.listDownloads().length === 1 && repo.listDownloads()[0].productRef === slow);
      dm.stop();
    }

    // ── ダウンロードの代わりに何が返ったかを理由にする ──
    log('\n== ダウンロードが始まらない理由（ページが返った・アプリ起動のリンク） ==');
    {
      const http = require('node:http');
      const server = http.createServer((req, res) => {
        if (req.url.startsWith('/page')) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body>login</body></html>');
        } else if (req.url.startsWith('/app')) {
          res.writeHead(302, { Location: 'dmmplayer2://download?pid=test' });
          res.end();
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${server.address().port}`;
      const { DownloadManager } = build('src/main/download/downloadManager.ts', 'downloadManager.local.cjs');
      db.prepare('DELETE FROM downloads').run();
      repo.setSetting('download.concurrency', '2');
      repo.setSetting('download.root', path.join(work, 'dl-root'));
      const withUrl = (pid, url) => {
        const id = addProduct(pid, 'video', 'video');
        db.prepare("UPDATE products SET links = ?, site_id = 'dmm', floor_id = 'doujin' WHERE id = ?").run(JSON.stringify([{ label: 'ダウンロード', url, kind: 'download' }]), id);
        return id;
      };
      const pageId = withUrl('VIDPAGE', `${base}/page`);
      const appId = withUrl('VIDAPP', `${base}/app`);
      const dm = new DownloadManager({ repo, fetchDetail: async () => null, onProgress: () => undefined, startTimeoutMs: 60_000 });
      await dm.enqueue([pageId, appId]);
      const started = Date.now();
      const rowOf = (pid) => repo.listDownloads().find((d) => d.productRef === pid);
      while (Date.now() - started < 20_000 && (rowOf(pageId).state !== 'error' || rowOf(appId).state !== 'error')) {
        await new Promise((r) => setTimeout(r, 200));
      }
      const pageRow = rowOf(pageId);
      const appRow = rowOf(appId);
      check('ページが返ったら、90 秒待たずに理由つきで失敗にする', pageRow.state === 'error' && /ページが返りました（(HTTP 200・)?127\.0\.0\.1/.test(pageRow.error ?? '') && !pageRow.savePath, pageRow);
      check('アプリを起動するリンクへ移ったら、その旨で失敗にする', appRow.state === 'error' && /dmmplayer2:/.test(appRow.error ?? ''), appRow);
      check('理由が分かった失敗は、同じ理由でやり直し続けない', pageRow.attempts >= 3 && appRow.attempts >= 3, [pageRow.attempts, appRow.attempts]);
      check('20 秒以内に分かる', Date.now() - started < 20_000, Date.now() - started);
      dm.stop();
      server.close();
      for (const id of [pageId, appId]) db.prepare('DELETE FROM products WHERE id = ?').run(id);
    }

    // 動画の作品ページの URL と shop 名
    {
      const video = build('src/main/sites/dmm/video.ts', 'video.local.cjs');
      check('動画の作品ページは floor を小文字にする', video.videoContentUrl('AV', 'jfb00336') === 'https://video.dmm.co.jp/av/content/?id=jfb00336' && video.videoContentUrl('AMATEUR', 'smus040') === 'https://video.dmm.co.jp/amateur/content/?id=smus040');
      check('shop 名: AV → videoa、AMATEUR → videoc', video.shopNameFor('AV')[0] === 'videoa' && video.shopNameFor('AMATEUR')[0] === 'videoc', [video.shopNameFor('AV'), video.shopNameFor('AMATEUR')]);
    }

    // ── 総集編・セットの収録作品 ──
    log('\n== 総集編・セットの収録作品（同じサークルの作品一覧で探す・手で直したぶんは残る） ==');
    {
      const { refreshCompilations, compilationCandidates } = build('src/main/meta/compilations.ts', 'compilations.local.cjs');
      const setRow = (id, fields) => {
        const keys = Object.keys(fields);
        db.prepare(`UPDATE products SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
      };
      const store = (pid) => `https://www.dlsite.com/maniax/work/=/product_id/${pid}.html`;
      const compId = addProduct('RJCOMP1', 'cg', 'doujin', 'サークル星');
      const partA = addProduct('RJPARTA', 'cg', 'doujin', 'サークル星');
      setRow(compId, {
        title: '星降る森 総集編',
        maker_id: 'RG1',
        detail_url: store('RJCOMP1'),
        tags: JSON.stringify(['総集編']),
        description: '【収録作品】\n01：星降る森の小さな図書館\n02：海辺の喫茶店へようこそ\n03：雪国の温泉宿と三つの鍵'
      });
      setRow(partA, { title: '星降る森の小さな図書館', maker_id: 'RG1', detail_url: store('RJPARTA') });

      // 同人・CG などの推定は設定でオンにしたときだけ（既定はオフ）
      let res = await refreshCompilations(repo);
      check('推定がオフ（既定）なら、同人の総集編の収録作品は出さない', res.count === 0 && repo.compilationOf(compId).entries.length === 0 && repo.getProduct(compId).isCompilation === false, res);
      repo.setSetting('compilation.guess', '1');
      // 一覧がまだ無いとき: 手元の同じサークルの作品で照らし合わせ、一覧を取りに行く対象に入れる
      res = await refreshCompilations(repo);
      let info = repo.compilationOf(compId);
      check(
        '一覧が無ければ、手元の同じサークルの作品で探し、一覧を取りに行く',
        res.count === 1 && res.needed.length === 1 && res.needed[0].store === 'dlsite-maniax' && res.needed[0].makerId === 'RG1' &&
          info.entries[0].matches[0]?.productId === 'RJPARTA' && info.entries[1].matches.length === 0 && info.catalog?.fetchedAt === null,
        { res, info }
      );

      repo.saveCatalog('dlsite-maniax', 'RG1', {
        items: [
          { productId: 'RJCOMP1', title: '星降る森 総集編', url: store('RJCOMP1') },
          { productId: 'RJPARTA', title: '星降る森の小さな図書館', url: store('RJPARTA') },
          { productId: 'RJSTORE2', title: '海辺の喫茶店へようこそ【DL版】', url: store('RJSTORE2') }
        ]
      });
      res = await refreshCompilations(repo);
      info = repo.compilationOf(compId);
      check('一覧があれば、取りに行かない', res.needed.length === 0, res);
      check('単独で買った作品は「購入済み」', info.entries[0].matches[0]?.ownedVia === 'single' && info.entries[0].matches[0]?.owned?.id === partA, info.entries[0]);
      check('一覧にしかない作品は「単独では未購入」（ストアの URL つき）', info.entries[1].matches[0]?.productId === 'RJSTORE2' && info.entries[1].matches[0]?.ownedVia === null && info.entries[1].matches[0]?.url === store('RJSTORE2'), info.entries[1]);
      check('総集編自身とは結び付けない', !info.entries.some((e) => e.matches.some((m) => m.productId === 'RJCOMP1')));
      check('一覧で見つからない収録作品も並べる', info.entries[2].matches.length === 0 && info.entries.length === 3, info.entries[2]);
      check('収録されている側から、持っている総集編を引ける', repo.compilationOf(partA).containedIn.map((p) => p.id).join() === String(compId));
      const found = repo.queryLibrary({ search: '海辺の喫茶店', limit: 20 }).items.map((p) => p.id);
      check('単独では持っていない作品の名前で検索すると、収録した総集編が出る', found.includes(compId), found);
      check('一覧に「総集編」と印を付ける', repo.getProduct(compId).isCompilation === true && repo.getProduct(partA).isCompilation === false);

      const candidates = compilationCandidates(repo, compId, '海辺の喫茶店へようこそ');
      check('選び直す候補は、一覧と手元の同じサークルの作品から（自身は除く・持っているかつき）', candidates[0]?.productId === 'RJSTORE2' && candidates[0]?.owned === false && !candidates.some((c) => c.productId === 'RJCOMP1'), candidates);

      repo.setCompilationOverride(compId, '星降る森の小さな図書館', []);
      repo.setCompilationOverride(compId, '雪国の温泉宿と三つの鍵', [{ productId: 'RJSTORE2', title: '海辺の喫茶店へようこそ【DL版】', url: store('RJSTORE2'), score: null }]);
      await refreshCompilations(repo);
      info = repo.compilationOf(compId);
      check('手で外したものは、読み直しても戻らない', info.entries[0].matches.length === 0 && info.entries[0].manual && repo.compilationOf(partA).containedIn.length === 0, info.entries[0]);
      check('手で選んだものは、読み直しても残る', info.entries[2].matches[0]?.productId === 'RJSTORE2' && info.entries[2].manual, info.entries[2]);
      repo.setCompilationOverride(compId, '星降る森の小さな図書館', null);
      check('自動に戻せる', repo.compilationOf(compId).entries[0].matches[0]?.productId === 'RJPARTA');

      // セット商品: 購入履歴に中身が並んでいれば、それを収録作品にする
      const setId = addProduct('SETPACK', 'game', 'game', 'ブランド月');
      const childA = addProduct('SETCHILDA', 'game', 'game', 'ブランド月');
      const childB = addProduct('SETCHILDB', 'game', 'game', 'ブランド月');
      setRow(setId, { title: '月の二本パック', product_type: 'set' });
      setRow(childA, { title: '月の本編', parent_product_id: 'SETPACK' });
      setRow(childB, { title: '月の続編', parent_product_id: 'SETPACK' });
      await refreshCompilations(repo);
      const setInfo = repo.compilationOf(setId);
      repo.setSetting('compilation.guess', '0');
      await refreshCompilations(repo);
      check('推定がオフでも、中身が分かっているセット商品は出す（同人の総集編は消える）', repo.compilationOf(setId).entries.length === 2 && repo.compilationOf(compId).entries.length === 0);
      repo.setSetting('compilation.guess', '1');
      await refreshCompilations(repo);
      check('セット商品は、購入履歴の中身を収録作品にする（セットの中身として所持）', setInfo.entries.map((e) => e.matches[0]?.productId).join() === 'SETCHILDA,SETCHILDB' && setInfo.entries.every((e) => e.matches[0]?.ownedVia === 'set'), setInfo);

      check('セット商品の中身を引ける', repo.setChildIds(setId).join() === [childA, childB].join() && repo.setChildIds(childA).length === 0);
      {
        const { DownloadManager } = build('src/main/download/downloadManager.ts', 'downloadManager.set.cjs');
        for (const c of [childA, childB]) {
          db.prepare("UPDATE products SET links = ?, file_size_bytes = 1000 WHERE id = ?").run(JSON.stringify([{ label: 'ダウンロード', url: `http://127.0.0.1:9/${c}`, kind: 'download' }]), c);
        }
        const dm = new DownloadManager({ repo, fetchDetail: async () => null, onProgress: () => undefined });
        const est = dm.estimate([setId]);
        check('セットをダウンロードに送ると、中身の作品を積む（見積もり）', est.products === 2 && est.files === 2 && est.bytes === 2000, est);
        dm.stop();
      }
      for (const id of [compId, partA, setId, childA, childB]) db.prepare('DELETE FROM products WHERE id = ?').run(id);
      check('作品を消せば、手で直したぶんも消える', db.prepare('SELECT count(*) AS n FROM compilation_overrides').get().n === 0);
      check('作品を消せば、収録作品も消える', db.prepare('SELECT count(*) AS n FROM compilation_entries').get().n === 0);
    }

    // 表示中の作品すべての ID（まとめてダウンロード・削除）
    {
      const all = repo.queryLibrary({ limit: 1_000_000 }).total;
      const ids = repo.queryLibraryIds({ limit: 2, offset: 5 });
      check('表示中すべての ID は、読み込み済みのページに関係なく全件', ids.length === all && new Set(ids).size === all, [ids.length, all]);
      const have = repo.queryLibraryIds({ localState: 'have' });
      check('絞り込みに合う作品だけ', have.length === repo.queryLibrary({ localState: 'have', limit: 1_000_000 }).total);
    }

    // ── リンク切れ ──
    log('\n== 紐付けたソフトが消えたら「リンク切れ」 ==');
    {
      const { judgeLinkHealth } = build('src/main/install/linkHealth.ts', 'linkHealth.local.cjs');
      const exe = path.join(work, 'linked', 'Game.exe');
      const target = { productRef: 1, kind: 'linked_existing', installPath: path.dirname(exe), executablePath: exe, uninstallKey: 'HKLM\\x', state: 'installed' };
      check('起動ファイルが無ければ切れている', judgeLinkHealth(target, { exists: () => false, dgpKeys: null }) === 'broken');
      check('起動ファイルがあれば生きている', judgeLinkHealth(target, { exists: (p) => p === exe, dgpKeys: null }) === 'installed');
      const dgp = { ...target, kind: 'dmm_game_player', executablePath: null, uninstallKey: 'dgp:AMAIN:gp_x' };
      check('DMM GAMES PLAYER から消えたゲームは切れている', judgeLinkHealth(dgp, { exists: () => true, dgpKeys: new Set(['dgp:AMAIN:gp_y']) }) === 'broken');
      check('DMM GAMES PLAYER ごと無いときも切れている', judgeLinkHealth(dgp, { exists: () => true, dgpKeys: 'missing' }) === 'broken');
      check('DMM GAMES PLAYER の設定が読めないときは判断しない', judgeLinkHealth(dgp, { exists: () => true, dgpKeys: null }) === null);

      const broken = addProduct('RJBROKEN', 'game', 'doujin');
      repo.upsertInstallation({ productRef: broken, kind: 'managed', installPath: path.dirname(exe), executablePath: exe });
      const before = repo.localCounts();
      repo.setInstallationState(broken, 'broken');
      const after = repo.localCounts();
      const brokenList = repo.queryLibrary({ localState: 'broken', limit: 20 }).items.map((p) => p.id);
      check('リンク切れを数え、絞り込める（インストール済みからは外れる）', after.broken === before.broken + 1 && after.installed === before.installed - 1 && brokenList.includes(broken), { before, after, brokenList });
      check('リンク切れは紐付け候補を探し直す対象に入る', repo.linkCandidateTargets().some((p) => p.id === broken));
      repo.setInstallationState(broken, 'installed');
      check('戻れば数えない', repo.localCounts().broken === before.broken);
      db.prepare('DELETE FROM products WHERE id = ?').run(broken);
    }

    // 動画のダウンロード導線: いちばん高い画質の、すべてのパート
    {
      const { downloadableLinks } = build('src/main/download/downloadManager.ts', 'downloadManager.links.cjs');
      const links = [6000, 3000].flatMap((rate) => [1, 2, 3].map((part) => ({ label: `ダウンロード ${rate}k`, url: `https://example.invalid/rate=${rate}/part=${part}/`, kind: 'download' })));
      const picked = downloadableLinks({ floorId: 'video', links: [{ label: 'ストリーミング再生', url: 'https://example.invalid/st', kind: 'stream' }, ...links] });
      check('動画はいちばん高い画質のパートをすべて落とす', picked.map((l) => l.url).join() === [1, 2, 3].map((p) => `https://example.invalid/rate=6000/part=${p}/`).join(), picked);
      const withQuality = ['6000', '4k'].flatMap((key) => [1, 2].map((part) => ({ label: `ダウンロード ${key}`, url: `https://example.invalid/${key}/${part}`, kind: 'download', quality: { key, name: key === '4k' ? '4K (2160p60)' : 'FullHD (1080p60)', sizeMb: part === 1 ? 100 : null, order: key === '4k' ? 20 : 15, part } })));
      check('4K を最高画質として選ぶ', downloadableLinks({ floorId: 'video', links: withQuality }).map((l) => l.url).join() === 'https://example.invalid/4k/1,https://example.invalid/4k/2');
      check('選んだ画質で落とす', downloadableLinks({ floorId: 'video', links: withQuality }, 'q:6000').map((l) => l.url).join() === 'https://example.invalid/6000/1,https://example.invalid/6000/2');
    }

    // DMM Player の検出（関連付けの読み取り）
    {
      const player = build('src/main/install/dmmPlayer.ts', 'dmmPlayer.local.cjs');
      const out = ['', 'HKEY_CLASSES_ROOT\\.dcv', '    (既定)    REG_SZ    DMM.Player.v2.dcv', ''].join('\r\n');
      check('関連付けの ProgID を読む', player.regDefaultValue(out) === 'DMM.Player.v2.dcv' && player.regDefaultValue(null) === null);
      check('DMM Player に渡すのは動画の DRM 付きファイルだけ', player.DMM_PLAYER_FILE.test('a.dcv') && !player.DMM_PLAYER_FILE.test('a.dmmb'));
    }

    // 動画のプレイヤー URL（2 パート目以降は part= を 1 つに）
    {
      const video = build('src/main/sites/dmm/video.ts', 'video.part.local.cjs');
      const base = 'https://www.dmm.co.jp/digital/-/player/=/player=html5/act=playlist/pid=abc00001/view_flag=1/parent_product_id=abc00001dl6/';
      check('動画のパートの URL を、公式のページが開く形にする', video.videoPartUrl(`${base}part=1/part=2/part=3/`) === `${base}part=3/` && video.videoPartUrl(`${base}part=1/`) === `${base}part=1/`);
    }

    // ── 壊れた DB の立て直し ──
    log('\n== 壊れた DB を立て直す（読める表を写す） ==');
    {
      const salvageDir = path.join(work, 'salvage');
      fs.mkdirSync(salvageDir, { recursive: true });
      const fresh = build('src/main/db/database.ts', 'database.salvage-test.cjs');
      const first = fresh.openDatabase(salvageDir);
      const r2 = new Repo(first.db);
      first.db.prepare(`INSERT INTO products (site_id, floor_id, product_id, title, first_seen_at, last_synced_at) VALUES ('dmm','doujin','d_keep','残る作品', 1, 1)`).run();
      r2.setSetting('download.root', 'D:\\Keep');
      r2.addLocalFile({ productRef: 1, path: 'D:\\Keep\\a.zip', sizeBytes: 1, kind: 'archive', source: 'download' });
      const insertCache = first.db.prepare('INSERT INTO content_cache (product_ref, signature, index_json, install_json, updated_at) VALUES (?, ?, ?, ?, ?)');
      const insertProduct = first.db.prepare(`INSERT INTO products (site_id, floor_id, product_id, title, first_seen_at, last_synced_at) VALUES ('dmm','doujin',?,?, 1, 1)`);
      for (let i = 0; i < 40; i++) {
        const id = Number(insertProduct.run(`d_c${i}`, `作品 c${i}`).lastInsertRowid);
        insertCache.run(id, 'sig', 'x'.repeat(20000), '{}', 1);
      }
      const root = first.db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'content_cache'").pluck().get();
      const pageSize = first.db.pragma('page_size', { simple: true });
      fresh.closeDatabase();
      // 作り置きの表の先頭ページを壊す
      const file = path.join(salvageDir, 'library.db');
      const fd = fs.openSync(file, 'r+');
      fs.writeSync(fd, Buffer.alloc(pageSize, 0xab), 0, pageSize, (root - 1) * pageSize);
      fs.closeSync(fd);

      const again = build('src/main/db/database.ts', 'database.salvage-test2.cjs');
      const opened = again.openDatabase(salvageDir);
      const r3 = new Repo(opened.db);
      check('壊れていたら退避して作り直す', !!opened.recoveredFrom && fs.existsSync(opened.recoveredFrom), opened.recoveredFrom);
      check('読める表（作品・設定・手元のファイル）は写す', r3.getProduct(1)?.title === '残る作品' && r3.getSetting('download.root') === 'D:\\Keep' && r3.localFiles(1).length === 1, opened.salvaged);
      check('作り置きの表は写さない（使ううちに作り直す）', opened.db.prepare('SELECT count(*) FROM content_cache').pluck().get() === 0);
      check('検索の索引も作り直される', opened.db.prepare("SELECT count(*) FROM products_fts WHERE products_fts MATCH '残る作品'").pluck().get() === 1);
      check('立て直した DB は壊れていない', opened.db.pragma('quick_check(1)')[0].quick_check === 'ok');
      again.closeDatabase();
    }

    closeDatabase();
  } catch (err) {
    log(`TEST_ERROR ${err && err.stack ? err.stack : err}`);
    failures.push('例外');
  } finally {
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    for (const dir of [work, otherDrive]) {
      // ダウンロード用ウィンドウのキャッシュが掴まれていて消せないことがある。消せなくても結果は書く
      if (dir) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          log(`  （後片付け: ${dir} を消せませんでした: ${err.code ?? err}）`);
        }
      }
    }
    fs.writeFileSync(resultFile, `${lines.join('\n')}\n${failures.length ? `NG: ${failures.join(' / ')}` : 'OK'}\n`);
    console.log(failures.length ? `\nNG: ${failures.length} 件失敗（詳細: ${resultFile}）` : `\nOK（詳細: ${resultFile}）`);
    setTimeout(() => app.exit(failures.length ? 1 : 0), 300);
  }
});
