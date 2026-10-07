/**
 * 中身の見取り図（画像・台本の振り分け）を、使い捨てのフォルダと zip で確かめる。
 *   npx electron tools/test-content-index.js
 *
 * **本物のライブラリは触らない。** すべて一時フォルダに作る。
 * ここで見ているのは「台本らしいフォルダ名」の扱い。CG集は「セリフあり／なし」「TEXT／NO TEXT」に
 * 本編を入れるので、台本とみなすと「画像を見る」が出なくなる（実際に出なかった）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { app } = require('electron');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'simaeru-content-index-'));
app.setPath('userData', path.join(work, 'profile'));

let failed = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok ' : 'NG '} ${name}${ok ? '' : ` — ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`}`);
};

/** 無圧縮の zip を1つ作る（7-Zip を呼ばずに済ませる） */
function makeZip(zipPath, files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, body] of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(body);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); // 名前は UTF-8
    local.writeUInt16LE(0, 8); // 無圧縮
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    chunks.push(local, nameBytes, data);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x800, 8);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBytes.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(zipPath, Buffer.concat([...chunks, centralBuf, end]));
}

const write = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};

app.whenReady().then(async () => {
  try {
    const outfile = path.join(root, 'out/test/content-index.cjs');
    buildSync({
      stdin: { contents: "export { buildContentIndex } from './src/main/content/contentIndex';", resolveDir: root, loader: 'ts' },
      outfile, bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3'],
      alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'error'
    });
    const { buildContentIndex } = require(outfile);
    const local = (p, kind) => [{ id: 1, path: p, sizeBytes: 0, kind, source: 'download', missingAt: null }];
    const names = (list) => list.map((e) => e.relPath).sort();

    // ① CG集（音声なし）。本編が「セリフあり／なし」に入る
    console.log('== CG集（音声なし）==');
    const cg = path.join(work, 'cg');
    write(path.join(cg, '本編/CG集_セリフあり/01_01.jpg'), 'a');
    write(path.join(cg, '本編/CG集_セリフあり/01_02.jpg'), 'b');
    write(path.join(cg, '本編/CG集_セリフなし/01_01.jpg'), 'c');
    write(path.join(cg, 'readme.txt'), 'x');
    const cgIndex = await buildContentIndex(1, local(cg, 'folder'), null, () => null);
    check('本編の画像が全部出る', cgIndex.images.length, 3);
    check('台本には入れない', cgIndex.documents.map((d) => d.relPath), ['readme.txt']);

    // ② 英語の CG集。「01 TEXT」「02 NO TEXT」も本編
    console.log('== CG集（TEXT / NO TEXT）==');
    const en = path.join(work, 'en');
    write(path.join(en, '01 TEXT/page 01.jpg'), 'a');
    write(path.join(en, '01 TEXT/page 02.jpg'), 'b');
    write(path.join(en, '02 NO TEXT/page 01.jpg'), 'c');
    write(path.join(en, '03 promotion/icon.jpg'), 'd');
    const enIndex = await buildContentIndex(1, local(en, 'folder'), null, () => null);
    check('どのフォルダの画像も出る', enIndex.images.length, 4);

    // ③ ボイス作品。音声があるので台本フォルダの画像は台本のまま
    console.log('== ボイス作品（音声あり）==');
    const voice = path.join(work, 'voice');
    write(path.join(voice, '01_おはよう.mp3'), 'a');
    write(path.join(voice, '台本/01.png'), 'b');
    write(path.join(voice, 'ジャケット.jpg'), 'c');
    const voiceIndex = await buildContentIndex(1, local(voice, 'folder'), null, () => null);
    check('台本フォルダの画像は台本', names(voiceIndex.documents), ['台本/01.png']);
    check('それ以外の画像は画像', names(voiceIndex.images), ['ジャケット.jpg']);

    // ④ ボイス作品でも、差分の名前のフォルダは台本にしない
    console.log('== ボイス作品＋差分CG ==');
    const mixed = path.join(work, 'mixed');
    write(path.join(mixed, '01_おはよう.mp3'), 'a');
    write(path.join(mixed, '台本/01.png'), 'b');
    write(path.join(mixed, 'CG_セリフあり/01.jpg'), 'c');
    const mixedIndex = await buildContentIndex(1, local(mixed, 'folder'), null, () => null);
    check('台本は台本', names(mixedIndex.documents), ['台本/01.png']);
    check('セリフありのCGは画像', names(mixedIndex.images), ['CG_セリフあり/01.jpg']);

    // ⑤ 圧縮のまま持つ CG集（zip の中を読む）
    console.log('== zip のままの CG集 ==');
    const zip = path.join(work, 'cgset.zip');
    makeZip(zip, [
      ['本編/CG集_セリフあり/01_01.jpg', 'a'],
      ['本編/CG集_セリフあり/01_02.jpg', 'b'],
      ['本編/CG集_セリフなし/01_01.jpg', 'c'],
      ['本編/readme.txt', 'x']
    ]);
    const zipIndex = await buildContentIndex(1, local(zip, 'archive'), null, () => null);
    check('zip の中でも画像として出る', zipIndex.images.length, 3);
    check('読み取りに失敗していない', zipIndex.sources.map((s) => s.error ?? 'ok'), ['ok']);

    // ⑥ ゲームの素材は画像に混ぜない（台本らしい名前でも）
    console.log('== ゲームの素材 ==');
    const game = path.join(work, 'game');
    write(path.join(game, 'game.exe'), 'a');
    write(path.join(game, 'data/text/01.png'), 'b');
    const gameIndex = await buildContentIndex(1, local(game, 'folder'), null, () => null);
    check('ゲームの中の画像は出さない', gameIndex.images.length, 0);

    // ⑦ CG集におまけのボイスが1つだけ付いている。本編の画像を台本に回さない
    console.log('== CG集＋おまけボイス ==');
    const bonus = path.join(work, 'bonus');
    write(path.join(bonus, '01 TEXT/page 01.jpg'), 'a');
    write(path.join(bonus, '01 TEXT/page 02.jpg'), 'b');
    write(path.join(bonus, '02 NO TEXT/page 01.jpg'), 'c');
    write(path.join(bonus, 'おまけボイス.mp3'), 'd');
    const bonusIndex = await buildContentIndex(1, local(bonus, 'folder'), null, () => null);
    check('TEXT の画像も出る', bonusIndex.images.length, 3);
    check('台本には入れない', bonusIndex.documents.length, 0);
    check('おまけの音声は音声として出る', bonusIndex.audioGroups.length, 1);

    // ⑧ 本編の音声がある作品でも、「NO TEXT」と並ぶ「TEXT」は文字ありの差分（画像）
    console.log('== ボイス付きCG集（TEXT / NO TEXT が並ぶ）==');
    const voiced = path.join(work, 'voiced');
    write(path.join(voiced, 'voice/01.mp3'), 'a');
    write(path.join(voiced, 'CG/TEXT/01.jpg'), 'b');
    write(path.join(voiced, 'CG/NO TEXT/01.jpg'), 'c');
    write(path.join(voiced, 'script/01.png'), 'd');
    const voicedIndex = await buildContentIndex(1, local(voiced, 'folder'), null, () => null);
    check('差分の両方が画像', names(voicedIndex.images), ['CG/NO TEXT/01.jpg', 'CG/TEXT/01.jpg']);
    check('隣に差分の無い台本は台本', names(voicedIndex.documents), ['script/01.png']);

    console.log(failed === 0 ? '\nOK' : `\nNG ${failed} 件`);
    // 動いている Electron が userData（この一時フォルダの中）を掴んでいて消せないことがある。後片付けの失敗で終われなくならないようにする
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 一時フォルダは OS が片付ける */ }
    app.exit(failed === 0 ? 0 : 1);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
