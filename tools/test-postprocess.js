/**
 * ダウンロード後の処理を、本物の 7-Zip / ffmpeg / プロトコル / ダウンロードで確かめる。
 *   npx electron tools/test-postprocess.js
 *
 * **本物の userData やライブラリには書かない。** 使い捨てフォルダに DB・アーカイブ・WAV を作って試す。
 * （ゲームを含め、すべてのアーカイブを一時フォルダに生成する）
 * 結果は %TEMP%\test-postprocess-result.txt にも出る（Electron は終了が早いと標準出力の最後が消えるため）。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow, net, protocol, session } = require('electron');
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'postprocess-test-'));
app.setPath('userData', path.join(work, 'userData'));
// ダウンロード用の窓を閉じたときにアプリごと終わらないようにする（既定では最後の窓で終了する）
app.on('window-all-closed', () => undefined);

protocol.registerSchemesAsPrivileged([
  { scheme: 'mylib', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
]);

const failures = [];
const lines = [];
const resultFile = path.join(os.tmpdir(), 'test-postprocess-result.txt');
const log = (line) => {
  console.log(line);
  lines.push(line);
};
const check = (label, ok, detail) => {
  log(`${ok ? '  ok ' : '  NG '} ${label}${ok || detail === undefined ? '' : `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})`}`);
  if (!ok) failures.push(label);
};

const waitFor = async (fn, timeoutMs, label) => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`時間切れ: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

let ffmpegExe = 'ffmpeg';
const ffmpeg = (args) => {
  const result = spawnSync(ffmpegExe, ['-v', 'error', '-y', ...args], { windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`ffmpeg fixture: ${result.error ?? result.stderr?.toString()}`);
  return result;
};

/** 無圧縮の zip を手で作る（zip slip の試験用に、7-Zip では作れない名前も入れられる） */
function makeStoredZip(file, entries, flags = 0x800) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.isBuffer(name) ? name : Buffer.from(name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(data) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(flags, 8);
    cen.writeUInt32LE(crc >>> 0, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...chunks, cd, end]));
}

app.whenReady().then(async () => {
  try {
    const { openDatabase, closeDatabase } = build('src/main/db/database.ts', 'database.cjs');
    const { Repo } = build('src/main/db/repo.ts', 'repo.cjs');
    const { JobRunner } = build('src/main/jobs/jobRunner.ts', 'jobRunner.cjs');
    const { buildContentIndex } = build('src/main/content/contentIndex.ts', 'contentIndex.cjs');
    const { registerLocalProtocol, fileUrl, archiveEntryUrl, configureArchiveCache } = build('src/main/content/localProtocol.ts', 'localProtocol.cjs');
    const { readZipIndex } = build('src/main/archive/zipReader.ts', 'zipReader.cjs');
    const { BandwidthThrottle } = build('src/main/download/throttle.ts', 'throttle.cjs');
    const { ToolInstaller, extractZip } = build('src/main/tools/toolInstaller.ts', 'toolInstaller.cjs');
    const { readInstalledPrograms } = build('src/main/install/installService.ts', 'installService.cjs');

    const { db } = openDatabase(path.join(work, 'userData'));
    const repo = new Repo(db);
    const byPath = (p) => repo.getLocalFileById(db.prepare('SELECT id FROM local_files WHERE path = ?').get(p).id);
    const addProduct = (productId, workType, category = 'doujin') => {
      const now = Date.now();
      const id = Number(
        db
          .prepare(
            `INSERT INTO products (site_id, floor_id, product_id, title, first_seen_at, last_synced_at, category, work_type)
             VALUES ('dlsite', 'library', ?, ?, ?, ?, ?, ?)`
          )
          .run(productId, `テスト ${productId}`, now, now, category, workType).lastInsertRowid
      );
      return id;
    };
    const trashed = [];
    const progressSeen = [];
    const runner = new JobRunner({
      repo,
      onProgress: (rows) => {
        for (const r of rows) if (r.state === 'running' && r.progress > 0 && r.progress < 1) progressSeen.push([r.kind, r.progress]);
      },
      onLocalFilesChanged: () => undefined,
      trashItem: async (p) => {
        trashed.push(p);
        fs.rmSync(p, { recursive: true, force: true });
      },
      freeBytes: () => null,
      workDir: path.join(work, 'work'),
      toolsDir: path.join(work, 'tools')
    });
    runner.start();
    const tools = runner.tools();
    ffmpegExe = tools.ffmpeg || ffmpegExe;
    log(`7-Zip: ${tools.sevenZip} / ffmpeg: ${tools.ffmpeg} / ffprobe: ${tools.ffprobe}`);
    if (!tools.sevenZip || (!process.argv.includes('--encoding-only') && (!tools.ffmpeg || !tools.ffprobe))) throw new Error('必要な 7-Zip / ffmpeg / ffprobe がありません');
    const jobDone = (id, ms = 120000) =>
      waitFor(() => {
        const j = repo.getJob(id);
        return j && ['done', 'error', 'canceled'].includes(j.state) ? j : null;
      }, ms, `job ${id}`);

    const testZipEncodings = async () => {
      log('\n== UTF-8 フラグなし / Shift_JIS ZIP の MP3だけ残す ==');
      if (tools.sevenZip) {
        for (const encoding of ['utf8-unflagged', 'sjis', 'utf8-flagged']) {
          const pid = addProduct(`RJENC-${encoding}`, 'voice');
          const zip = path.join(work, `${encoding}.zip`);
          const name = ext => encoding === 'sjis'
            ? Buffer.concat([Buffer.from([0x89, 0xb9, 0x90, 0xba]), Buffer.from(`/track.${ext}`)]) // 音声
            : `音声/track.${ext}`;
          const entries = ['mp3', 'wav', 'txt'].map(ext => ({ name: name(ext), data: Buffer.from(`contents-${ext}`) }));
          makeStoredZip(zip, entries, encoding === 'utf8-flagged' ? 0x800 : 0);
          repo.addLocalFile({ productRef: pid, path: zip, sizeBytes: fs.statSync(zip).size, kind: 'archive', source: 'download' });
          const job = await jobDone(runner.enqueueLossyOnly(pid, zip, 'delete'));
          check(`${encoding}: 作り直しが完了`, job.state === 'done' && job.result?.removed === 1, job.error ?? job.result);
          const index = await readZipIndex(zip);
          check(`${encoding}: 日本語名のMP3と付属テキストを保持`, index.entries.filter(e => !e.isDir).map(e => e.name).sort().join(',') === '音声/track.mp3,音声/track.txt');
        }
      }
    };
    if (process.argv.includes('--encoding-only')) {
      await testZipEncodings();
      runner.stop();
      closeDatabase();
      return;
    }

    // 実ライブラリを探索せず、同じフォルダ構造の小さなZIPを生成する。
    const sample = path.join(work, 'game-fixture.zip');
    makeStoredZip(sample, [
      { name: 'テスト作品/readme_pc.txt', data: Buffer.from('fixture readme') },
      { name: 'テスト作品/ゲーム本体/index.html', data: Buffer.from('<html>fixture</html>') }
    ]);

    // ── ゲーム: 展開してアーカイブを消す ──
    log('\n== ゲーム: 展開して、済んだらアーカイブを消す ==');
    if (!sample || !tools.sevenZip) {
      log('  -- 作品アーカイブか 7-Zip が無いので飛ばします');
    } else {
      const pid = addProduct('RJGAME', 'game');
      const dir = path.join(work, 'lib', 'ゲーム');
      fs.mkdirSync(dir, { recursive: true });
      const archive = path.join(dir, 'RJ01000002.zip');
      fs.copyFileSync(sample, archive);
      repo.addLocalFile({ productRef: pid, path: archive, sizeBytes: fs.statSync(archive).size, kind: 'archive', source: 'download' });

      const listing = await readZipIndex(archive);
      check('自前の zip 読み取りで日本語の一覧が取れる', listing.entries.some((e) => e.name.endsWith('readme_pc.txt') && e.name.includes('テスト作品')), listing.entries.slice(0, 2).map((e) => e.name));

      const job = await jobDone(runner.enqueueExtract(pid, archive, false, { deleteArchive: true }));
      check('展開が完了する', job.state === 'done', job.error);
      const dest = path.join(dir, 'RJ01000002');
      check('フォルダ1つだけの中身は1段上げる', fs.existsSync(path.join(dest, 'readme_pc.txt')));
      check('日本語のフォルダ名が化けない', fs.existsSync(path.join(dest, 'ゲーム本体', 'index.html')));
      check('展開が済んだらアーカイブを消す', !fs.existsSync(archive), job.message);
      check('消したアーカイブは台帳からも外す', !db.prepare('SELECT 1 FROM local_files WHERE path = ?').get(archive));
      const folderRow = db.prepare('SELECT kind, derived_from FROM local_files WHERE path = ?').get(dest);
      check('展開フォルダは展開元つきで台帳に残る', folderRow?.kind === 'folder' && folderRow?.derived_from === archive, folderRow);

      // ボイス作品を手で展開したときは、アーカイブを残す
      const vid = addProduct('RJVOICEX', 'voice');
      const vdir = path.join(work, 'lib', 'ボイス手動');
      fs.mkdirSync(vdir, { recursive: true });
      const varchive = path.join(vdir, 'RJVOICEX.zip');
      fs.copyFileSync(sample, varchive);
      repo.addLocalFile({ productRef: vid, path: varchive, sizeBytes: 1, kind: 'archive', source: 'download' });
      const vjob = await jobDone(runner.enqueueExtract(vid, varchive, false, { deleteArchive: true }));
      check('圧縮のまま持つ作品は、展開してもアーカイブを消さない', vjob.state === 'done' && fs.existsSync(varchive), vjob.message);
    }

    // ── ボイス: WAV を FLAC に差し替えて zip を作り直す ──
    log('\n== ボイス: 中の WAV を FLAC に差し替えて zip を作り直す ==');
    let voiceZip = null;
    if (!tools.ffmpeg || !tools.ffprobe || !tools.sevenZip) {
      log('  -- ffmpeg か 7-Zip が無いので飛ばします');
    } else {
      const src = path.join(work, 'voice-src');
      fs.mkdirSync(path.join(src, '本編', 'SEあり'), { recursive: true });
      fs.mkdirSync(path.join(src, '本編', 'SEなし'), { recursive: true });
      fs.mkdirSync(path.join(src, '台本'), { recursive: true });
      ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=4:sample_rate=48000', '-ac', '2', '-c:a', 'pcm_s24le', path.join(src, '本編', 'SEあり', '01_おはよう.wav')]);
      // 途中の進捗が出るか見るため、こちらは長め（4分）にする
      ffmpeg(['-f', 'lavfi', '-i', 'anoisesrc=d=240:c=pink:a=0.3', '-ac', '2', '-c:a', 'pcm_s16le', path.join(src, '本編', 'SEなし', '01_おはよう.wav')]);
      ffmpeg(['-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'pcm_f32le', path.join(src, '本編', 'float.wav')]);
      // Shift_JIS「あい」を繰り返す（短すぎると 7-Zip が圧縮せずに入れるので、ある程度の大きさにする）
      fs.writeFileSync(path.join(src, '台本', '台本.txt'), Buffer.alloc(4000, Buffer.from([0x82, 0xa0, 0x82, 0xa2])));
      ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=1', '-frames:v', '1', path.join(src, 'jacket.png')]);

      const pid = addProduct('RJVOICE', 'voice');
      const dir = path.join(work, 'lib', 'ボイス');
      fs.mkdirSync(dir, { recursive: true });
      voiceZip = path.join(dir, 'RJVOICE.zip');
      spawnSync(tools.sevenZip, ['a', '-tzip', '-mx=5', voiceZip, '*'], { cwd: src, windowsHide: true });
      const beforeSize = fs.statSync(voiceZip).size;
      repo.addLocalFile({ productRef: pid, path: voiceZip, sizeBytes: beforeSize, kind: 'archive', source: 'download' });

      // 圧縮のままの見取り図
      const before = await buildContentIndex(pid, repo.localFiles(pid), tools.sevenZip, () => null);
      check('展開せずにグループ分けできる', JSON.stringify(before.audioGroups.map((g) => g.tags)) === JSON.stringify([[], ['SEあり'], ['SEなし']]), before.audioGroups.map((g) => [g.folder, g.tags]));
      check('アーカイブの概要（WAV 3件・自前で読めた）', before.archives[0]?.wavCount === 3 && before.archives[0]?.native, before.archives[0]);

      const job = await jobDone(runner.enqueueFlac(pid, voiceZip, 'keep'), 240000);
      check('zip の作り直しが完了する', job.state === 'done', job.error);
      check('2件を変換・浮動小数点は対象外', job.result?.converted === 2 && job.result?.skipped?.length === 1, job.result);
      check('変換の途中で進捗が出る', progressSeen.some(([k]) => k === 'flac'), progressSeen.slice(0, 3));
      const kept = path.join(dir, 'RJVOICE (WAV).zip');
      check('「残す」なら元の zip は (WAV) を付けて残る', fs.existsSync(kept));
      check('同じ名前で新しい zip ができる', fs.existsSync(voiceZip) && fs.statSync(voiceZip).size < beforeSize, `${beforeSize} → ${fs.existsSync(voiceZip) ? fs.statSync(voiceZip).size : '-'}`);
      const after = await readZipIndex(voiceZip);
      const names = after.entries.filter((e) => !e.isDir).map((e) => `${e.name}:${e.method}`).sort();
      check('FLAC・画像は無圧縮、テキストは圧縮して入る', names.includes('本編/SEあり/01_おはよう.flac:0') && names.includes('jacket.png:0') && names.includes('台本/台本.txt:8'), names);
      check('変換できない WAV はそのまま入っている', names.includes('本編/float.wav:8') || names.includes('本編/float.wav:0'), names);
      check('変換済みの WAV は入っていない', !names.some((n) => /01_おはよう\.wav/.test(n)), names);
      // DB の done は成果物の差し替え完了を表し、一時フォルダの finally はその直後に走る。
      await waitFor(
        () => fs.readdirSync(path.join(work, 'work')).filter((n) => n.startsWith('job-')).length === 0,
        5000,
        'FLAC の作業フォルダの片付け'
      );
      check('作業フォルダが片付いている', true);
      const row = db.prepare('SELECT size_bytes, source FROM local_files WHERE path = ?').get(voiceZip);
      check('台帳の大きさが新しい zip に合う', row?.size_bytes === fs.statSync(voiceZip).size, row);
    }

    log('\n== ボイス: MP3 がある WAV を消して zip を作り直す ==');
    if (!tools.ffmpeg || !tools.sevenZip) {
      log('  -- ffmpeg か 7-Zip が無いので飛ばします');
    } else {
      // 実例と同じ並び: 01_WAV / 02_MP3 (320kbps) / 03_SEなし/WAV・MP3。名前に記号を入れる
      const src = path.join(work, 'lossy-src');
      const root = path.join(src, '作品 ～ナイトプール♪～');
      for (const d of ['01_WAV', '02_MP3 (320kbps)', '03_SEなし/WAV', '03_SEなし/MP3 (320kbps)', '04_イラスト']) {
        fs.mkdirSync(path.join(root, ...d.split('/')), { recursive: true });
      }
      const tone = (file, codec) => ffmpeg(['-f', 'lavfi', '-i', 'sine=duration=2', '-c:a', codec, file]);
      tone(path.join(root, '01_WAV', 'トラック01 [前編] ドキドキ!.wav'), 'pcm_s16le');
      tone(path.join(root, '01_WAV', 'フリートークA.wav'), 'pcm_s16le');
      tone(path.join(root, '02_MP3 (320kbps)', 'トラック01 [前編] ドキドキ!.mp3'), 'libmp3lame');
      tone(path.join(root, '03_SEなし', 'WAV', 'トラック01 [前編] ドキドキ!【SEなし】.wav'), 'pcm_s16le');
      tone(path.join(root, '03_SEなし', 'MP3 (320kbps)', 'トラック01 [前編] ドキドキ!【SEなし】.mp3'), 'libmp3lame');
      // SEなし側の MP3 が無い WAV（SEありの MP3 と組にしてはいけない）
      tone(path.join(root, '03_SEなし', 'WAV', 'フリートークA.wav'), 'pcm_s16le');
      ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=1', '-frames:v', '1', path.join(root, '04_イラスト', 'ジャケット.png')]);

      const pid = addProduct('RJLOSSY', 'voice');
      const dir = path.join(work, 'lib', 'MP3だけ');
      fs.mkdirSync(dir, { recursive: true });
      const zip = path.join(dir, 'RJLOSSY.zip');
      spawnSync(tools.sevenZip, ['a', '-tzip', '-mx=5', zip, '*'], { cwd: src, windowsHide: true });
      const beforeSize = fs.statSync(zip).size;
      repo.addLocalFile({ productRef: pid, path: zip, sizeBytes: beforeSize, kind: 'archive', source: 'download' });

      const index = await buildContentIndex(pid, repo.localFiles(pid), tools.sevenZip, () => null);
      check('見取り図に「消せる WAV」が出る（2件・SEなしのフリートークは残す）', index.lossyOnly[0]?.count === 2 && index.lossyOnly[0]?.kept === 2, index.lossyOnly);

      const job = await jobDone(runner.enqueueLossyOnly(pid, zip, 'delete'), 120000);
      check('作り直しが完了する', job.state === 'done' && job.result?.removed === 2, job.error ?? job.result);
      const names = (await readZipIndex(zip)).entries.filter((e) => !e.isDir).map((e) => `${e.name}:${e.method}`).sort();
      check('組になる WAV は消える', !names.some((n) => n.includes('トラック01') && n.includes('.wav')), names);
      check('組が無い WAV は残る（SEありの MP3 とは組にしない）', names.some((n) => n.endsWith('01_WAV/フリートークA.wav:8') || n.endsWith('01_WAV/フリートークA.wav:0')) && names.some((n) => n.includes('03_SEなし/WAV/フリートークA.wav')), names);
      check('MP3・画像は無圧縮で入る', names.filter((n) => n.includes('.mp3:0')).length === 2 && names.some((n) => n.endsWith('ジャケット.png:0')), names);
      check('小さくなる', fs.statSync(zip).size < beforeSize, `${beforeSize} → ${fs.statSync(zip).size}`);
      await waitFor(
        () => fs.readdirSync(path.join(work, 'work')).filter((n) => n.startsWith('job-')).length === 0,
        5000,
        'MP3だけ残すの作業フォルダの片付け'
      );
      check('作業フォルダが片付いている', true);

      // 自動: 設定が入なら、ダウンロード後に「MP3 だけ残す」を積む（FLAC 化より先）
      const aid = addProduct('RJLOSSYAUTO', 'voice');
      const azip = path.join(dir, 'RJLOSSYAUTO.zip');
      spawnSync(tools.sevenZip, ['a', '-tzip', '-mx=1', azip, '*'], { cwd: src, windowsHide: true });
      repo.addLocalFile({ productRef: aid, path: azip, sizeBytes: 1, kind: 'archive', source: 'download' });
      runner.saveSettings({ lossyOnly: true, autoFlac: true, flacMinBytes: 0 });
      await runner.onDownloadFinished(aid);
      const aj = repo.jobsForProduct(aid);
      check('設定が入ならダウンロード後に「MP3 だけ残す」を積む（残る WAV はそのあと FLAC に）', aj.length === 1 && aj[0].kind === 'lossy', aj.map((j) => [j.kind, j.options]));
      runner.cancel(aj[0]?.id);
      await jobDone(aj[0].id).catch(() => undefined);
      runner.saveSettings({ lossyOnly: false, autoFlac: false });
    }

    await testZipEncodings();

    log('\n== CG 集: 画像と同じ内容の PDF を消して zip を作り直す・展開して使う ==');
    if (!tools.sevenZip) {
      log('  -- 7-Zip が無いので飛ばします');
    } else {
      const src = path.join(work, 'pdf-src');
      const cgRoot = path.join(src, 'CG集');
      fs.mkdirSync(path.join(cgRoot, '本編'), { recursive: true });
      fs.mkdirSync(path.join(cgRoot, 'スマホ版'), { recursive: true });
      for (let i = 1; i <= 12; i++) fs.writeFileSync(path.join(cgRoot, '本編', `${String(i).padStart(3, '0')}.jpg`), Buffer.alloc(2048, i));
      fs.writeFileSync(path.join(cgRoot, 'スマホ版', 'CG集.pdf'), Buffer.alloc(4096, 7));
      fs.writeFileSync(path.join(cgRoot, '読んでね.txt'), 'readme');
      const dir = path.join(work, 'lib', 'CG');
      fs.mkdirSync(dir, { recursive: true });

      const pid = addProduct('RJPDF', 'cg');
      const zip = path.join(dir, 'RJPDF.zip');
      spawnSync(tools.sevenZip, ['a', '-tzip', '-mx=1', zip, '*'], { cwd: src, windowsHide: true });
      repo.addLocalFile({ productRef: pid, path: zip, sizeBytes: fs.statSync(zip).size, kind: 'archive', source: 'download' });
      const index = await buildContentIndex(pid, repo.localFiles(pid), tools.sevenZip, () => null);
      check('見取り図に「消せる PDF」が出る', index.pdfStrip[0]?.count === 1 && index.pdfStrip[0]?.names[0] === 'CG集/スマホ版/CG集.pdf', index.pdfStrip);

      const job = await jobDone(runner.enqueueStripPdf(pid, zip, 'delete'), 120000);
      check('作り直しが完了する', job.state === 'done' && job.result?.removed === 1, job.error ?? job.result);
      const names = (await readZipIndex(zip)).entries.filter((e) => !e.isDir).map((e) => e.name).sort();
      check('PDF だけが消え、画像とテキストは残る', !names.some((n) => n.endsWith('.pdf')) && names.filter((n) => n.endsWith('.jpg')).length === 12 && names.includes('CG集/読んでね.txt'), names);

      // 自動: 設定が入なら、ダウンロード後に積む
      const aid = addProduct('RJPDFAUTO', 'cg');
      const azip = path.join(dir, 'RJPDFAUTO.zip');
      spawnSync(tools.sevenZip, ['a', '-tzip', '-mx=1', azip, '*'], { cwd: src, windowsHide: true });
      repo.addLocalFile({ productRef: aid, path: azip, sizeBytes: 1, kind: 'archive', source: 'download' });
      const pdfDefaults = runner.settings();
      check('既定は PDF を消さない・どの種別も圧縮したまま', pdfDefaults.stripPdfTypes.length === 0 && Object.values(pdfDefaults.archiveHandling).every((v) => v === 'archive'), pdfDefaults);
      // 選んでいない種別（マンガ）では積まない
      runner.saveSettings({ stripPdfTypes: ['manga'], autoFlac: false, lossyOnly: false });
      await runner.onDownloadFinished(aid);
      check('選んでいない種別（CG）では「PDF を消す」を積まない', repo.jobsForProduct(aid).length === 0, repo.jobsForProduct(aid).map((j) => j.kind));
      runner.saveSettings({ stripPdfTypes: ['cg'] });
      await runner.onDownloadFinished(aid);
      const aj = repo.jobsForProduct(aid);
      check('CG を選んでいれば、ダウンロード後に「PDF を消す」を積む', aj.length === 1 && aj[0].kind === 'pdf', aj.map((j) => j.kind));
      runner.cancel(aj[0]?.id);
      await jobDone(aj[0].id).catch(() => undefined);
      // 同人以外（商業の電子書籍）は、種別が CG でも触らない
      const bid = addProduct('BJPDF', 'cg', 'book');
      const bzip = path.join(dir, 'BJPDF.zip');
      spawnSync(tools.sevenZip, ['a', '-tzip', '-mx=1', bzip, '*'], { cwd: src, windowsHide: true });
      repo.addLocalFile({ productRef: bid, path: bzip, sizeBytes: 1, kind: 'archive', source: 'download' });
      await runner.onDownloadFinished(bid);
      check('同人以外は PDF を消さない', repo.jobsForProduct(bid).length === 0, repo.jobsForProduct(bid).map((j) => j.kind));
      runner.saveSettings({ stripPdfTypes: [] });

      // 圧縮したまま持つ作品も展開する: 作り直し（PDF を消す）が済んでから展開し、zip は設定で消す
      const eid = addProduct('RJEXTRACT', 'cg');
      const ezip = path.join(dir, 'RJEXTRACT.zip');
      spawnSync(tools.sevenZip, ['a', '-tzip', '-mx=1', ezip, '*'], { cwd: src, windowsHide: true });
      repo.addLocalFile({ productRef: eid, path: ezip, sizeBytes: fs.statSync(ezip).size, kind: 'archive', source: 'download' });
      runner.saveSettings({ stripPdfTypes: ['cg'], archiveHandling: { voice: 'extract' } });
      await runner.onDownloadFinished(eid);
      check('ほかの種別（ボイス）を展開にしても、CG は圧縮のまま（PDF を消すだけ）', runner.settings().archiveHandling.cg === 'archive' && runner.settings().archiveHandling.voice === 'extract');
      const firstJobs = repo.jobsForProduct(eid);
      await jobDone(firstJobs[0].id);
      check('CG が圧縮のままなら展開しない', repo.jobsForProduct(eid).every((j) => j.kind === 'pdf'), repo.jobsForProduct(eid).map((j) => j.kind));
      // 作り直した zip を作り直す前の形に戻して、CG を「展開して zip を削除」にしてやり直す
      fs.rmSync(ezip, { force: true });
      spawnSync(tools.sevenZip, ['a', '-tzip', '-mx=1', ezip, '*'], { cwd: src, windowsHide: true });
      for (const j of repo.jobsForProduct(eid)) repo.deleteJob(j.id);
      runner.saveSettings({ archiveHandling: { cg: 'extractDelete' } });
      await runner.onDownloadFinished(eid);
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        const ej = repo.jobsForProduct(eid);
        if (ej.some((j) => j.kind === 'extract' && (j.state === 'done' || j.state === 'error'))) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      const ej = repo.jobsForProduct(eid).sort((a, b) => a.id - b.id);
      check('PDF を消してから展開する', ej.map((j) => `${j.kind}:${j.state}`).join(',') === 'pdf:done,extract:done', ej.map((j) => [j.kind, j.state, j.error]));
      const folder = repo.localFiles(eid).find((f) => f.kind === 'folder');
      check('展開したフォルダが台帳に載り、PDF は入っていない', !!folder && fs.existsSync(path.join(folder.path, '本編', '001.jpg')) && !fs.existsSync(path.join(folder.path, 'スマホ版', 'CG集.pdf')), folder);
      check('「削除する」なら zip は消える', !fs.existsSync(ezip) && !repo.localFiles(eid).some((f) => f.path === ezip), repo.localFiles(eid).map((f) => f.path));
      runner.saveSettings({ stripPdfTypes: [], archiveHandling: { cg: 'archive', voice: 'archive' } });
    }

    // ── mylib:// でアーカイブから直接読む ──
    log('\n== mylib:// でアーカイブの中から直接読む ==');
    configureArchiveCache(path.join(work, 'cache'));
    registerLocalProtocol({ allowedPaths: () => repo.allLocalPaths(), sevenZip: () => tools.sevenZip });
    if (voiceZip && fs.existsSync(voiceZip)) {
      const entry = '本編/SEなし/01_おはよう.flac';
      const expected = spawnSync(tools.sevenZip, ['e', '-so', voiceZip, entry.replace(/\//g, '\\')], { windowsHide: true, maxBuffer: 1 << 30 }).stdout;
      const full = await net.fetch(archiveEntryUrl(voiceZip, entry));
      const body = Buffer.from(await full.arrayBuffer());
      check('無圧縮エントリを丸ごと読める', full.status === 200 && body.equals(expected), `${full.status} ${body.length}/${expected.length}`);
      const part = await net.fetch(archiveEntryUrl(voiceZip, entry), { headers: { Range: 'bytes=1000-1999' } });
      const pbody = Buffer.from(await part.arrayBuffer());
      check('無圧縮エントリは Range でそのまま切り出す（206）', part.status === 206 && pbody.equals(expected.subarray(1000, 2000)), part.status);
      check('キャッシュを使っていない', !fs.existsSync(path.join(work, 'cache')) || fs.readdirSync(path.join(work, 'cache')).length === 0);
      const txt = await net.fetch(archiveEntryUrl(voiceZip, '台本/台本.txt'));
      const decoded = new TextDecoder('shift_jis').decode(await txt.arrayBuffer());
      check('圧縮エントリはその場で展開して返す', txt.status === 200 && decoded === 'あい'.repeat(1000), `${txt.status} ${decoded.slice(0, 10)}`);
      const wav = await net.fetch(archiveEntryUrl(voiceZip, '本編/float.wav'), { headers: { Range: 'bytes=0-99' } });
      const wavDetail = wav.status === 206 ? '' : await wav.text();
      check('圧縮された音声は一時キャッシュに書き出して Range で返す', wav.status === 206 && fs.readdirSync(path.join(work, 'cache')).length === 1, `${wav.status} ${wavDetail}`);
      const outside = await net.fetch(fileUrl(path.join(work, 'userData', 'library.db')));
      check('台帳の外は 403', outside.status === 403, outside.status);
    }

    // ── ダウンロード後の自動処理 ──
    log('\n== ダウンロード後の自動処理（分割は全部そろってから） ==');
    if (sample && tools.sevenZip) {
      const pid = addProduct('RJAUTO', 'game');
      const dir = path.join(work, 'lib', '自動');
      fs.mkdirSync(dir, { recursive: true });
      const archive = path.join(dir, 'RJAUTO.zip');
      fs.copyFileSync(sample, archive);
      repo.upsertDownload({ productRef: pid, label: '1/2', linkKind: 'split', linkIndex: 0, state: 'done' });
      repo.upsertDownload({ productRef: pid, label: '2/2', linkKind: 'split', linkIndex: 1, state: 'running' });
      repo.addLocalFile({ productRef: pid, path: archive, sizeBytes: 1, kind: 'archive', source: 'download' });

      runner.saveSettings({ autoExtract: false });
      await runner.onDownloadFinished(pid);
      check('設定が切なら積まない', repo.jobsForProduct(pid).length === 0);
      runner.saveSettings({ autoExtract: true, deleteArchiveAfterExtract: false });
      await runner.onDownloadFinished(pid);
      check('残りのダウンロードがあるうちは積まない', repo.jobsForProduct(pid).length === 0);
      db.prepare("UPDATE downloads SET state = 'done' WHERE product_ref = ?").run(pid);
      await runner.onDownloadFinished(pid);
      const auto = repo.jobsForProduct(pid);
      check('全部終わったら自動で展開を積む', auto.length === 1 && auto[0].kind === 'extract' && auto[0].auto, auto);
      await jobDone(auto[0].id);
      check('「アーカイブを残す」設定なら残る', fs.existsSync(archive) && !!repo.extractedFrom(archive));

      // 解凍するだけの exe（自己解凍書庫）。拡張子では分からないので、7-Zip で見分けてから扱う
      const sfxModule = path.join(path.dirname(tools.sevenZip), '7z.sfx');
      if (fs.existsSync(sfxModule)) {
        log('\n== 解凍するだけの exe（自己解凍書庫） ==');
        const cp = require('node:child_process');
        const sdir = path.join(work, 'lib', '自己解凍');
        fs.mkdirSync(sdir, { recursive: true });
        /** 無音の WAV（1 秒・16bit・モノラル・8kHz） */
        const silentWav = () => {
          const rate = 8000;
          const wav = Buffer.alloc(44 + rate * 2);
          wav.write('RIFF', 0); wav.writeUInt32LE(36 + rate * 2, 4); wav.write('WAVE', 8);
          wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
          wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
          wav.write('data', 36); wav.writeUInt32LE(rate * 2, 40);
          return wav;
        };
        /** 作品フォルダ（readme と WAV）を、7-Zip の SFX モジュールで自己解凍 exe にする */
        const makeSfx = (name) => {
          const src = path.join(work, `sfx-src-${name}`);
          fs.mkdirSync(path.join(src, '作品'), { recursive: true });
          fs.writeFileSync(path.join(src, '作品', 'readme.txt'), 'はじめにお読みください');
          fs.writeFileSync(path.join(src, '作品', '01_本編.wav'), silentWav());
          const exe = path.join(sdir, `${name}.exe`);
          const made = cp.spawnSync(tools.sevenZip, ['a', `-sfx${sfxModule}`, exe, '作品'], { cwd: src, windowsHide: true });
          if (made.status !== 0) throw new Error(`自己解凍 exe を作れません: ${made.stderr}`);
          return exe;
        };

        // ── zip に置き換えない設定: exe から直接展開する ──
        runner.saveSettings({ sfxToZip: false, autoExtract: true, deleteArchiveAfterExtract: false });
        const sfx = makeSfx('RJSFX');
        const sid = addProduct('RJSFX', 'game');
        repo.addLocalFile({ productRef: sid, path: sfx, sizeBytes: fs.statSync(sfx).size, kind: 'installer', source: 'download' });
        await runner.onDownloadFinished(sid);
        check('ダウンロードし終えたら自己解凍書庫と見分けて印を付ける', byPath(sfx).kind === 'sfx', byPath(sfx).kind);
        const sj = repo.jobsForProduct(sid);
        check('zip 化しない設定なら exe から直接展開を積む', sj.length === 1 && sj[0].kind === 'extract' && sj[0].auto, sj.map((j) => j.kind));
        await jobDone(sj[0].id);
        const sfxOut = repo.extractedFrom(sfx);
        check('exe を実行せずに中身を取り出せる', !!sfxOut && fs.existsSync(path.join(sfxOut.path, 'readme.txt')), sfxOut && sfxOut.path);

        // ── 既定: 展開 → 各種処理 → zip に詰め直す → exe はごみ箱（自己解凍 exe で配られたボイス作品の形） ──
        runner.saveSettings({ sfxToZip: true, autoFlac: true, flacMinBytes: 0 });
        check('既定では zip に置き換える', runner.settings().sfxToZip === true);
        const vsfx = makeSfx('RJSFXVOICE');
        const vsid = addProduct('RJSFXVOICE', 'voice');
        repo.addLocalFile({ productRef: vsid, path: vsfx, sizeBytes: fs.statSync(vsfx).size, kind: 'installer', source: 'download' });
        const trashedBefore = trashed.length;
        await runner.onDownloadFinished(vsid);
        const vsj = repo.jobsForProduct(vsid);
        check('自己解凍 exe は zip への置き換えを積む', vsj.length === 1 && vsj[0].kind === 'sfxzip' && vsj[0].auto, vsj.map((j) => j.kind));
        const vdone = await jobDone(vsj[0].id);
        check('置き換えが済む', vdone.state === 'done', vdone.error);
        const vzip = path.join(sdir, 'RJSFXVOICE.zip');
        check('同じ場所に zip ができる', fs.existsSync(vzip));
        check('exe はごみ箱へ入れる', !fs.existsSync(vsfx) && trashed.slice(trashedBefore).some((p) => p.toLowerCase().includes('rjsfxvoice')), trashed.slice(trashedBefore));
        const vrows = repo.localFiles(vsid).filter((f) => !f.missingAt);
        check('台帳は exe の代わりに zip になる', vrows.length === 1 && vrows[0].path === vzip && vrows[0].kind === 'archive' && vrows[0].source === 'download', vrows.map((f) => [path.basename(f.path), f.kind, f.source]));
        const inZip = (await readZipIndex(vzip)).entries.filter((e) => !e.isDir).map((e) => e.name).sort();
        check('WAV は FLAC にしてから詰める（各種処理を済ませてから zip に）', inZip, ['作品/01_本編.flac', '作品/readme.txt']);
        await new Promise((r) => setTimeout(r, 300));
        check('ボイスは圧縮のまま持つので、zip を展開しない', !repo.jobsForProduct(vsid).some((j) => j.kind === 'extract'), repo.jobsForProduct(vsid).map((j) => j.kind));

        // ── ゲーム: zip に置き換えたあと、ふだんどおり展開する ──
        runner.saveSettings({ autoFlac: false });
        const gsfx = makeSfx('RJSFXGAME');
        const gsid = addProduct('RJSFXGAME', 'game');
        repo.addLocalFile({ productRef: gsid, path: gsfx, sizeBytes: fs.statSync(gsfx).size, kind: 'installer', source: 'download' });
        await runner.onDownloadFinished(gsid);
        const gz = repo.jobsForProduct(gsid).find((j) => j.kind === 'sfxzip');
        await jobDone(gz.id);
        const gzip = path.join(sdir, 'RJSFXGAME.zip');
        const gext = await waitFor(() => repo.jobsForProduct(gsid).find((j) => j.kind === 'extract') ?? null, 10000, 'ゲームの展開');
        await jobDone(gext.id);
        check('ゲームは zip に置き換えたあと、ふだんどおり展開する', !!repo.extractedFrom(gzip), repo.jobsForProduct(gsid).map((j) => [j.kind, j.state]));

        // ── 分割の自己解凍（name.part1.exe + name.part2.rar …）も zip にまとめる ──
        const split = makeSfx('RJSPLITSRC');
        const splitDir = path.join(sdir, '分割');
        fs.mkdirSync(splitDir, { recursive: true });
        // 7-Zip では RAR を作れないので、part1.exe だけの「1巻の分割」として並びを確かめる
        const part1 = path.join(splitDir, 'RJSPLIT.part1.exe');
        fs.copyFileSync(split, part1);
        fs.rmSync(split);
        const spid = addProduct('RJSPLIT', 'voice');
        repo.addLocalFile({ productRef: spid, path: part1, sizeBytes: fs.statSync(part1).size, kind: 'archive', source: 'download' });
        await runner.onDownloadFinished(spid);
        const spj = repo.jobsForProduct(spid);
        check('分割の自己解凍の先頭も zip への置き換えを積む', spj.length === 1 && spj[0].kind === 'sfxzip', spj.map((j) => j.kind));
        await jobDone(spj[0].id);
        check('分割の自己解凍も RJSPLIT.zip になる', fs.existsSync(path.join(splitDir, 'RJSPLIT.zip')) && !fs.existsSync(part1));

        // ── ふつうの実行ファイルは書庫として扱わない ──
        const plain = path.join(sdir, 'Setup.exe');
        fs.copyFileSync(tools.sevenZip, plain);
        const nid = addProduct('RJPLAINEXE', 'game');
        repo.addLocalFile({ productRef: nid, path: plain, sizeBytes: 1, kind: 'installer', source: 'download' });
        await runner.onDownloadFinished(nid);
        check('ふつうの実行ファイルは展開も置き換えもしない', repo.jobsForProduct(nid).length === 0 && byPath(plain).kind === 'installer', byPath(plain).kind);

        // ── 取り込んだ exe は、印は付けるが勝手に処理しない（手元のゲームのフォルダなどを大量に触らないように） ──
        const imported = makeSfx('RJSFXSCAN');
        const iid = addProduct('RJSFXSCAN', 'game');
        repo.addLocalFile({ productRef: iid, path: imported, sizeBytes: 1, kind: 'installer', source: 'scan' });
        const started = await runner.extractDownloadedSelfExtracting();
        check('起動時の確認で、取り込んだ exe にも印は付ける', byPath(imported).kind === 'sfx', byPath(imported).kind);
        check('取り込んだ exe は自動では処理しない', started === 0 && repo.jobsForProduct(iid).length === 0, started);
        runner.saveSettings({ deleteArchiveAfterExtract: false });
      } else {
        log('  -- 7-Zip の SFX モジュールが無いので、自己解凍 exe の確認は飛ばします');
      }

      // 圧縮のまま持つ作品は、自動 FLAC が有効で WAV が多ければ zip の作り直しを積む
      if (voiceZip && tools.ffmpeg) {
        const vid = addProduct('RJAUTOV', 'voice');
        const vdir = path.join(work, 'lib', '自動ボイス');
        fs.mkdirSync(vdir, { recursive: true });
        const vzip = path.join(vdir, 'RJAUTOV.zip');
        fs.copyFileSync(path.join(work, 'lib', 'ボイス', 'RJVOICE (WAV).zip'), vzip);
        repo.addLocalFile({ productRef: vid, path: vzip, sizeBytes: 1, kind: 'archive', source: 'download' });
        runner.saveSettings({ autoFlac: true, flacMinBytes: 0 });
        await runner.onDownloadFinished(vid);
        const vj = repo.jobsForProduct(vid);
        check('圧縮のまま持つ作品は展開せず、FLAC 化を積む', vj.length === 1 && vj[0].kind === 'flac', vj.map((j) => j.kind));
        runner.cancel(vj[0]?.id);
        runner.saveSettings({ autoFlac: false });
        await jobDone(vj[0].id).catch(() => undefined);
      }
    }

    // ── ツールの取得（配布元の代わりにローカルの HTTP サーバ） ──
    log('\n== ツールの取得（チェックサム照合・入れ替え・zip slip） ==');
    {
      const zipFile = path.join(work, 'fake-ffmpeg.zip');
      makeStoredZip(zipFile, [
        { name: 'ffmpeg-n9.9-latest-win64-lgpl-shared-9.9/bin/ffmpeg.exe', data: Buffer.from('fake ffmpeg') },
        { name: 'ffmpeg-n9.9-latest-win64-lgpl-shared-9.9/bin/ffprobe.exe', data: Buffer.from('fake ffprobe') },
        { name: 'ffmpeg-n9.9-latest-win64-lgpl-shared-9.9/bin/avcodec-61.dll', data: Buffer.from('dll') },
        { name: 'ffmpeg-n9.9-latest-win64-lgpl-shared-9.9/LICENSE.txt', data: Buffer.from('LGPL') },
        { name: 'ffmpeg-n9.9-latest-win64-lgpl-shared-9.9/doc/manual.html', data: Buffer.from('doc') }
      ]);
      const zipBytes = fs.readFileSync(zipFile);
      const sha = crypto.createHash('sha256').update(zipBytes).digest('hex');
      let digest = `sha256:${sha}`;
      const server = http.createServer((req, res) => {
        if (req.url.startsWith('/api')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            tag_name: 'latest',
            assets: [
              { name: 'ffmpeg-n9.9-latest-win64-gpl-shared-9.9.zip', size: 1, browser_download_url: 'http://x/none', digest: 'sha256:00' },
              { name: 'ffmpeg-n9.9-latest-win64-lgpl-shared-9.9.zip', size: zipBytes.length, browser_download_url: `http://127.0.0.1:${server.address().port}/asset.zip`, digest }
            ]
          }));
        } else {
          res.writeHead(200, { 'Content-Length': zipBytes.length });
          res.end(zipBytes);
        }
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const { TOOL_SPECS } = require(path.join(outDir, 'toolInstaller.cjs'));
      const events = [];
      const installer = new ToolInstaller({
        toolsDir: path.join(work, 'tools'),
        workDir: path.join(work, 'work'),
        fetch: (url, init) => net.fetch(url, init),
        onProgress: (p) => events.push(p.phase),
        specs: { ffmpeg: { ...TOOL_SPECS.ffmpeg, releaseUrl: `http://127.0.0.1:${server.address().port}/api` } }
      });
      const plan = await installer.plan('ffmpeg');
      check('LGPL 版を選ぶ（GPL 版は選ばない）', plan.assets.length === 1 && plan.assets[0].name.includes('lgpl'), plan);
      const info = await installer.install('ffmpeg');
      const dest = path.join(work, 'tools', 'ffmpeg');
      check('bin の中身とライセンスだけを取り出す', ['ffmpeg.exe', 'ffprobe.exe', 'avcodec-61.dll', 'LICENSE.txt', 'installed.json'].every((n) => fs.existsSync(path.join(dest, n))) && !fs.existsSync(path.join(dest, 'doc')), fs.readdirSync(dest));
      check('版とチェックサムを記録する', info.version === '9.9' && info.sha256.includes(sha), info);
      check('進捗が段階どおりに出る', ['resolving', 'downloading', 'verifying', 'extracting', 'done'].every((p) => events.includes(p)), [...new Set(events)]);
      check('入れたものが「このアプリで入れたもの」として見つかる', runner.tools().sources.ffmpeg === 'bundled' || runner.tools().sources.ffmpeg === 'configured' || runner.tools().sources.ffmpeg === 'system', runner.tools().sources);

      digest = `sha256:${'0'.repeat(64)}`;
      let err = null;
      try {
        await installer.install('ffmpeg');
      } catch (e) {
        err = e.message;
      }
      check('チェックサムが違えば入れない', !!err && err.includes('一致しません'), err);
      check('失敗しても前の版は残る', fs.existsSync(path.join(dest, 'ffmpeg.exe')) && !fs.existsSync(`${dest}.installing`));

      digest = null;
      err = null;
      try {
        await installer.install('ffmpeg');
      } catch (e) {
        err = e.message;
      }
      check('チェックサムが付いていなければ入れない', !!err && err.includes('チェックサム'), err);
      server.close();

      const evil = path.join(work, 'evil.zip');
      makeStoredZip(evil, [{ name: '../escape.txt', data: Buffer.from('x') }]);
      err = null;
      try {
        await extractZip(evil, path.join(work, 'evil-out'), (n) => n);
      } catch (e) {
        err = e.message;
      }
      check('フォルダの外へ出る名前を含む zip は拒否する（zip slip）', !!err && !fs.existsSync(path.join(work, 'escape.txt')), err);
    }

    // ── 帯域制限 ──
    log('\n== 帯域制限（ローカルの HTTP サーバから本物のダウンロード） ==');
    {
      const SIZE = 64 * 1024 * 1024;
      const payload = Buffer.alloc(SIZE, 7);
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': SIZE, 'Content-Disposition': 'attachment; filename="blob.bin"' });
        // 回線の速さを 40MB/s 程度にそろえる（ループバックのままだと一瞬で終わって、制限が効く前に落ち切る）
        let offset = 0;
        const timer = setInterval(() => {
          if (res.writableLength > 4 * 1024 * 1024) return;
          const chunk = payload.subarray(offset, offset + 1024 * 1024);
          offset += chunk.length;
          res.write(chunk);
          if (offset >= SIZE) {
            clearInterval(timer);
            res.end();
          }
        }, 25);
        res.on('close', () => clearInterval(timer));
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;
      const ses = session.fromPartition('throttle-test');
      const win = new BrowserWindow({ show: false, webPreferences: { session: ses } });
      const timedDownload = (limit) =>
        new Promise((resolve, reject) => {
          const throttle = new BandwidthThrottle(() => limit);
          throttle.start(100);
          const started = Date.now();
          ses.once('will-download', (_e, item) => {
            item.setSavePath(path.join(work, `blob-${limit}.bin`));
            throttle.add(1, item);
            item.once('done', (_e2, state) => {
              throttle.stop();
              if (state !== 'completed') return reject(new Error(state));
              resolve({ seconds: (Date.now() - started) / 1000, bytes: item.getReceivedBytes() });
            });
          });
          win.webContents.downloadURL(`http://127.0.0.1:${port}/blob-${limit}`);
        });
      const free = await timedDownload(0);
      check('制限なしでも最後まで落ちる', free.bytes === SIZE, free);
      const limited = await timedDownload(6 * 1024 * 1024);
      const rate = limited.bytes / limited.seconds;
      log(`     制限なし ${free.seconds.toFixed(2)} 秒 / 6MB/s 制限 ${limited.seconds.toFixed(2)} 秒（平均 ${(rate / 1024 / 1024).toFixed(2)} MB/s）`);
      check('平均が上限の 1.3 倍以下', rate <= 6 * 1024 * 1024 * 1.3, `${(rate / 1024 / 1024).toFixed(2)} MB/s`);
      check('極端に遅くはならない（上限の 0.5 倍以上）', rate >= 6 * 1024 * 1024 * 0.5, `${(rate / 1024 / 1024).toFixed(2)} MB/s`);
      win.destroy();
      server.close();
    }

    // ── 導入済みプログラム ──
    log('\n== 導入済みプログラムの一覧（レジストリ・読むだけ） ==');
    const programs = await readInstalledPrograms();
    check('一覧が読める', Array.isArray(programs) && programs.length > 0, programs.length);

    runner.stop();
    closeDatabase();
  } catch (err) {
    log(`TEST_ERROR ${err && err.stack ? err.stack : err}`);
    failures.push('例外');
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {
      /* 片付けに失敗しても結果は変わらない */
    }
    fs.writeFileSync(resultFile, `${lines.join('\n')}\n${failures.length ? `NG: ${failures.join(' / ')}` : 'OK'}\n`);
    console.log(failures.length ? `\nNG: ${failures.length} 件失敗（詳細: ${resultFile}）` : `\nOK（詳細: ${resultFile}）`);
    setTimeout(() => app.exit(failures.length ? 1 : 0), 300);
  }
});
