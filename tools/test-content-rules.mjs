/**
 * 作品の中身の振り分け（版ラベル・トラックの束ね・ゲームの型・分割アーカイブ・Range）の検証。
 *   node tools/test-content-rules.mjs
 *
 * ゲームの型は、実際に落とした作品のアーカイブの中身（一覧）を元にした構成で確かめる。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const root = path.join(import.meta.dirname, '..');
const electronStub = path.join(os.tmpdir(), 'electron-stub.cjs');
fs.writeFileSync(electronStub, 'module.exports = { protocol: {}, shell: {} };');
const build = (entry, name, external = []) => {
  const outfile = path.join(os.tmpdir(), name);
  esbuild.buildSync({
    entryPoints: [path.join(root, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    alias: {
      '@shared': path.join(root, 'src', 'shared'),
      // 純粋な関数だけを試すので、electron は空の代わりで足りる
      ...(external.includes('electron') ? { electron: electronStub } : {})
    },
    logLevel: 'error'
  });
  return require(outfile);
};

const rules = build('src/shared/contentRules.ts', 'contentRules.test.cjs');
const zip = build('src/main/archive/sevenZip.ts', 'sevenZip.test.cjs');
const proto = build('src/main/content/localProtocol.ts', 'localProtocol.test.cjs', ['electron']);
const idx = build('src/main/content/contentIndex.ts', 'contentIndex.test.cjs', ['electron']);
const policy = build('src/shared/storagePolicy.ts', 'storagePolicy.test.cjs');
const zipr = build('src/main/archive/zipReader.ts', 'zipReader.test.cjs');
const dgp = build('src/main/install/dmmGamePlayer.ts', 'dmmGamePlayer.test.cjs', ['electron']);

const failures = [];
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  console.log(`${ok ? '  ok ' : '  NG '} ${label}${ok ? '' : `\n        期待 ${e}\n        実際 ${a}`}`);
  if (!ok) failures.push(label);
};

console.log('== 版のラベル（フォルダ名から） ==');
check('SEあり', rules.versionTags('本編/SEあり'), ['SEあり']);
check('SEなし', rules.versionTags('本編/SEなし'), ['SEなし']);
check('SE無し(括弧)', rules.versionTags('02_本編（SE無し）'), ['SEなし']);
check('no SE', rules.versionTags('mp3/no SE'), ['SEなし', 'MP3']);
check('親SEあり・子SEなしは子を優先', rules.versionTags('SEあり/SEなし'), ['SEなし']);
check('特典', rules.versionTags('特典/おまけトラック'), ['特典']);
check('WAV とハイレゾ', rules.versionTags('WAV_96kHz24bit'), ['ハイレゾ', 'WAV']);
check('ラベル無し', rules.versionTags('01_本編'), []);
check('単語の一部の wav は拾わない', rules.versionTags('wavelength'), []);

console.log('\n== 同じトラックの別版を束ねるキー ==');
check('拡張子と版の違いは同じキー',
  rules.trackKey('01_おはよう.wav') === rules.trackKey('01_おはよう（SEなし）.mp3'), true);
check('全角数字・空白の違いも同じキー',
  rules.trackKey('０１ おはよう.flac') === rules.trackKey('01_おはよう.wav'), true);
check('別トラックは別キー', rules.trackKey('01_おはよう.wav') === rules.trackKey('02_おやすみ.wav'), false);

console.log('\n== 自然順 ==');
check('2 は 10 より前', ['10.wav', '2.wav', '1.wav'].sort(rules.naturalCompare), ['1.wav', '2.wav', '10.wav']);

console.log('\n== 振り分け ==');
check('台本フォルダの画像は台本', rules.classifyEntry('台本/01.png'), 'scriptImage');
check('普通の画像', rules.classifyEntry('CG/01.png'), 'image');
check('pdf', rules.classifyEntry('おまけ/台本.PDF'), 'document');
check('lrc', rules.classifyEntry('01.lrc'), 'subtitle');

console.log('\n== ゲームの型（§8） ==');
const facts = (list) => list.map(([rel, size = 1000]) => ({ rel, size, isDir: rel.endsWith('/') ? true : false }))
  .map((f) => (f.isDir ? { ...f, rel: f.rel.replace(/\/$/, '') } : f));

// 実行ファイルとデータが並ぶだけ → C
const hidamari = rules.judgeInstall(facts([
  ['advwin32.exe', 2033616], ['DAT/'], ['DAT/SETUP1.MRG'], ['DAT.MRG', 35452685], ['GRAPHIC.MRG', 87230778],
  ['FILTER/'], ['FILTER/SETUPEX.FIL'], ['MP2/BGM001.MP2']
]));
check('実行ファイルとデータだけなら portable', hidamari.type, 'portable');
check('本体候補は実行ファイル', hidamari.executables.map((e) => e.rel), ['advwin32.exe']);

// setup.exe と Input/main.exe・pfs が並ぶ → B
const withInstaller = rules.judgeInstall(facts([
  ['Autorun.inf'], ['icon.ico'], ['Input/'], ['Input/readme.txt'], ['Input/root.pfs', 42239662],
  ['Input/root.pfs.000', 461234630], ['Input/main.exe', 5159424], ['PC情報の取得.bat'],
  ['setup.exe', 1847066], ['はじめにお読みください.txt']
]));
check('本体と導入ファイルが並ぶなら installer_with_files', withInstaller.type, 'installer_with_files');
check('インストーラを拾う', withInstaller.installers.map((e) => e.rel), ['setup.exe']);
check('本体候補を拾う', withInstaller.executables.map((e) => e.rel), ['Input/main.exe']);
check('お読みくださいを拾う', withInstaller.readmes, ['Input/readme.txt', 'はじめにお読みください.txt']);

// 「setup.exe だけ」 → A
const onlySetup = rules.judgeInstall(facts([['setup.exe', 1900000000], ['autorun.inf']]));
check('setup だけなら installer', onlySetup.type, 'installer');

// ブラウザで遊ぶ作品: index.html が入口
const web = rules.judgeInstall(facts([
  ['サンプル作品 (PC)/readme_pc.txt'], ['サンプル作品 (PC)/ゲーム本体/'], ['サンプル作品 (PC)/ゲーム本体/index.html'],
  ['サンプル作品 (PC)/ゲーム本体/assets/build/bundle.js']
]));
check('HTML作品は portable', web.type, 'portable');
check('HTML作品の入口', web.htmlEntries, ['サンプル作品 (PC)/ゲーム本体/index.html']);

// Update.exe と .fpk だけ → 本体に当てる追加データ
const dlc = rules.judgeInstall(facts([
  ['sample_dl/CV01_7.fpk', 10422907], ['sample_dl/patchdlc01.fpk', 41756842], ['sample_dl/readme.txt', 621],
  ['sample_dl/Update.exe', 92672], ['sample_dl/update.lst', 301]
]));
check('追加ディスク（Update.exe と .fpk）は patch', dlc.type, 'patch');
check('アップデータを実行できる候補に出す', dlc.installers.map((e) => e.rel), ['sample_dl/Update.exe']);

// Setup.exe と SETUP/本体exe・データ → B
const high = rules.judgeInstall(facts([
  ['Setup.exe', 900000], ['SETUP/'], ['SETUP/SampleGame.exe', 3000000], ['SETUP/data.pak', 200000000], ['readme.txt']
]));
check('本体が SETUP/ の下にあっても installer_with_files', high.type, 'installer_with_files');
check('SETUP/ の下の本体を拾う', high.executables.map((e) => e.rel), ['SETUP/SampleGame.exe']);

// ランタイムは本体候補にしない
const runtime = rules.judgeInstall(facts([['game.exe', 500], ['redist/vcredist_x86.exe', 9000], ['UnityCrashHandler64.exe', 9000]]));
check('ランタイム・クラッシュハンドラを除外', runtime.executables.map((e) => e.rel), ['game.exe']);

console.log('\n== ボイス作品のプレイリスト（ゲームの素材は混ぜない） ==');
const sink = { audio: [] };
const groups = idx.groupAudio([
  { url: 'u1', relPath: '本編/SEあり/01_a.wav', name: '01_a.wav', size: 1, container: 'C:/w', inArchive: false },
  { url: 'u2', relPath: '本編/SEあり/10_b.wav', name: '10_b.wav', size: 1, container: 'C:/w', inArchive: false },
  { url: 'u3', relPath: '本編/SEあり/2_c.wav', name: '2_c.wav', size: 1, container: 'C:/w', inArchive: false },
  { url: 'u4', relPath: '本編/SEなし/01_a.wav', name: '01_a.wav', size: 1, container: 'C:/w', inArchive: false }
]);
void sink;
check('フォルダごとにグループ', groups.map((g) => [g.folder, g.tags]), [['本編/SEあり', ['SEあり']], ['本編/SEなし', ['SEなし']]]);
const withBonus = idx.groupAudio([
  { url: 'b1', relPath: '特典/01.mp3', name: '01.mp3', size: 1, container: 'C:/w', inArchive: false },
  { url: 'b2', relPath: '本編/01.mp3', name: '01.mp3', size: 1, container: 'C:/w', inArchive: false }
]);
check('特典は本編のあと', withBonus.map((g) => g.folder), ['本編', '特典']);
check('グループ内は自然順', groups[0].tracks.map((t) => t.name), ['01_a.wav', '2_c.wav', '10_b.wav']);

console.log('\n== 分割アーカイブ ==');
check('part1.exe は先頭', zip.splitInfo('game.part1.exe'), { base: 'game', index: 1 });
check('part2.rar は続き', zip.isSecondaryPart('game.part2.rar'), true);
check('part01.rar は展開対象', zip.isArchiveFile('game.part01.rar'), true);
check('7z.002 は続き', zip.isSecondaryPart('data.7z.002'), true);
check('普通の exe は対象外', zip.isArchiveFile('setup.exe'), false);
check('展開先の名前', [zip.extractFolderName('VJ000003.zip'), zip.extractFolderName('game.part1.exe'), zip.extractFolderName('a.7z.001')], ['VJ000003', 'game', 'a']);

console.log('\n== 7z -slt の読み取り ==');
const listing = 'Path = 本編\r\nFolder = +\r\nSize = 0\r\n\r\nPath = 本編\\01.wav\r\nFolder = -\r\nSize = 123\r\nAttributes = A\r\n';
check('区切りを / に揃える', zip.parseSltListing(listing), [
  { path: '本編', size: 0, isDir: true },
  { path: '本編/01.wav', size: 123, isDir: false }
]);

console.log('\n== mylib:// の範囲チェック・Range ==');
check('配下は許可', proto.isUnder('C:\\Lib\\作品\\a.wav', ['C:\\Lib\\作品']), true);
check('大文字小文字は無視', proto.isUnder('c:\\lib\\作品\\A.WAV', ['C:\\Lib\\作品']), true);
check('前方一致だけの別フォルダは拒否', proto.isUnder('C:\\Lib\\作品2\\a.wav', ['C:\\Lib\\作品']), false);
check('.. で抜けるのは拒否', proto.isUnder('C:\\Lib\\作品\\..\\秘密.txt', ['C:\\Lib\\作品']), false);
check('Range 先頭から', proto.parseRange('bytes=0-', 1000), { start: 0, end: 999 });
check('Range 範囲', proto.parseRange('bytes=100-199', 1000), { start: 100, end: 199 });
check('Range 末尾', proto.parseRange('bytes=-100', 1000), { start: 900, end: 999 });
check('Range はみ出しは null', proto.parseRange('bytes=2000-', 1000), null);
const url = proto.archiveEntryUrl('C:\\Lib\\作品.zip', '台本/01 [SE].pdf');
check('URL の往復', proto.parseLocalUrl(url), { kind: 'entry', archive: 'C:\\Lib\\作品.zip', entry: '台本/01 [SE].pdf' });

console.log('\n== 導入済みプログラムとの近さ ==');
check('同名は1', rules.titleSimilarity('ひだまりの向こうがわ', 'ひだまりの向こうがわ'), 1);
check('版表記付きでも高い', rules.titleSimilarity('ひだまりの向こうがわ', 'ひだまりの向こうがわ ダウンロード版') > 0.6, true);
check('無関係は低い', rules.titleSimilarity('ひだまりの向こうがわ', 'Microsoft Visual C++ 2015') < 0.2, true);

console.log('\n== 保存のしかた（展開して使う / 圧縮のまま） ==');
const mode = (category, workType, hasExe) => policy.decideStorage({ category, workType }, hasExe === undefined ? undefined : { hasExecutable: hasExe }).mode;
check('ゲームは展開', mode('doujin', 'game'), 'extract');
check('ツールは展開', mode('doujin', 'tool'), 'extract');
check('PCゲーム区分で種別不明は展開', mode('game', null), 'extract');
check('DLsite の VJ でもボイスは圧縮のまま', mode('game', 'voice'), 'archive');
check('マンガは圧縮のまま', mode('doujin', 'manga'), 'archive');
check('CG は圧縮のまま（中に exe があっても種別で決める）', mode('doujin', 'cg', true), 'archive');
check('動画・音楽・小説は圧縮のまま', [mode('doujin', 'video'), mode('game', 'music'), mode('book', 'novel')], ['archive', 'archive', 'archive']);
check('種別「その他」で exe 入りは展開', mode('doujin', 'other', true), 'extract');
check('種別「その他」で exe なしは圧縮のまま', mode('doujin', 'other', false), 'archive');
check('実行ファイルの手がかり', [policy.hasExecutable(['a/Game.EXE']), policy.hasExecutable(['web/index.html']), policy.hasExecutable(['a.png'])], [true, true, false]);

console.log('\n== zip のファイル名の文字コード ==');
const sjisBytes = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x2e, 0x74, 0x78, 0x74]); // Shift_JIS「日本語.txt」
const utf8Bytes = new TextEncoder().encode('日本語.txt');
check('UTF-8 フラグ付きは UTF-8', zipr.decodeName(utf8Bytes, true), '日本語.txt');
check('フラグ無しの Shift_JIS（Windows の日本語 zip）', zipr.decodeName(sjisBytes, false), '日本語.txt');
check('フラグ無しでも正しい UTF-8 なら UTF-8（Mac の zip）', zipr.decodeName(utf8Bytes, false), '日本語.txt');
check('ASCII はそのまま', zipr.decodeName(new TextEncoder().encode('a/b.png'), false), 'a/b.png');

console.log('\n== 多言語化 ==');
{
  const i18n = build('src/shared/i18n/index.ts', 'i18n.test.cjs');
  i18n.setLang('ja');
  check('日本語はそのまま・差し込み', i18n.t('{0} 件', { 0: 5 }), '5 件');
  i18n.setLang('en');
  check('英語は辞書から・差し込み', i18n.t('{0} 件', { 0: 5 }), '5 titles');
  check('false / null は空', i18n.t('{0}{1} ファイルをダウンロードのキューに入れました', { 0: false, 1: 3 }), 'Added 3 files to the download queue');
  check('辞書に無ければ日本語のまま', i18n.t('辞書に無い文'), '辞書に無い文');
  check('渡していない差し込みは残す（フォルダ構成のトークンなど）', i18n.t('{site}/{maker}'), '{site}/{maker}');
  check('言語の判定', [i18n.normalizeLang('ja-JP'), i18n.normalizeLang('en-US'), i18n.normalizeLang('zh-CN'), i18n.normalizeLang('zh-TW'), i18n.normalizeLang('fr')], ['ja', 'en', 'zh', 'zh', null]);
  i18n.setLang('zh');
  check('中国語は辞書から・差し込み', i18n.t('{0} 件', { 0: 5 }), '5 个');
  check('中国語の日付の書式', i18n.locale(), 'zh-CN');
  check('選べる言語', i18n.LANGS.map((l) => l.value), ['ja', 'en', 'zh']);
  i18n.setLang('ja');
}

console.log('\n== DMM GAMES PLAYER ==');
check('起動URL: PCゲーム(AMAIN)は main', dgp.dgpLaunchUrl('AMAIN', 'gp_7lwx46c8'), 'dmmgameplayer://play/AMAIN/gp_7lwx46c8/main/win');
check('起動URL: クライアントゲーム(ACL)は cl', dgp.dgpLaunchUrl('ACL', 'tskx'), 'dmmgameplayer://play/ACL/tskx/cl/win');
// DMM GAMES PLAYER 本体（app.asar）が受け付ける形
check(
  '本体が受け付ける形に合う',
  /^dmmgameplayer:\/\/play\/[a-zA-Z0-9_]+?\/[a-zA-Z0-9_-]+?\/(cl|main|emulator)\/(win|mac)$/.test(dgp.dgpLaunchUrl('GCL', 'jewepri-re-x')),
  true
);
check(
  'レジストリの値（引用符なし）',
  dgp.exeFromCommand('    (既定)    REG_SZ    C:\\Program Files\\DMMGamePlayer\\DMMGamePlayer.exe %1\r\n'),
  'C:\\Program Files\\DMMGamePlayer\\DMMGamePlayer.exe'
);
check('レジストリの値（引用符あり）', dgp.exeFromCommand('    (Default)    REG_SZ    "C:\\DGP\\DMMGamePlayer.exe" "%1"'), 'C:\\DGP\\DMMGamePlayer.exe');
check('紐付けの記録', dgp.parseDgpKey(dgp.dgpKey({ gameType: 'AMAIN', productId: 'gp_nb092q4w' })), { gameType: 'AMAIN', productId: 'gp_nb092q4w' });
check('記録でないもの', dgp.parseDgpKey('HKLM\\Software\\X'), null);
{
  const games = [
    { productId: 'rs', gameType: 'GCL', path: 'D:\\DMMGames\\rs', version: '1', installed: true },
    { productId: 'gp_nb092q4w', gameType: 'AMAIN', path: 'D:\\Game\\otherbrand\\otherbrand_title', version: '1', installed: true },
    { productId: 'gp_7lwx46c8', gameType: 'AMAIN', path: 'D:\\Game\\samplesoft\\SampleSoft_GameName', version: '1', installed: true }
  ];
  const ranked = dgp.rankDgpGames(games, { title: 'サンプル作品…… 特別版', maker: 'SampleSoft', productId: 'samplesoft_0106' });
  check('ブランド名がフォルダ名に入っているものが先頭（PCゲームが先）', ranked.map((g) => g.productId), ['gp_7lwx46c8', 'gp_nb092q4w', 'rs']);
}
check('専用作品の判定（タグ）', dgp.isDgpOnly({ tags: ['DMM GAMES PLAYER専用'], description: null }), true);
check('説明文だけでは専用扱いにしない（タグがあるものだけ）', dgp.isDgpOnly({ tags: [], description: '本商品を利用するためには、「DMM GAMES PLAYER」が必要です。' }), false);
check('ふつうの作品', dgp.isDgpOnly({ tags: ['ADV'], description: 'x' }), false);

console.log('\n== 画像と同じ内容の PDF（スマホ向けなど） ==');
{
  const imgs = (dir, n, size = 500_000) => Array.from({ length: n }, (_, i) => ({ path: `${dir}/${String(i + 1).padStart(3, '0')}.jpg`, size }));
  const names = (plan) => plan.remove.map((r) => r.path);
  // 本編の画像 + スマホ向け PDF の並び
  check('フォルダ名が「スマホ」なら消す', names(rules.planPdfStrip([...imgs('本編', 30), { path: 'スマホ版/作品.pdf', size: 1_000_000 }])), ['スマホ版/作品.pdf']);
  check('名前に「PDF版」', names(rules.planPdfStrip([...imgs('CG', 20), { path: '作品_PDF版.pdf', size: 100_000 }])), ['作品_PDF版.pdf']);
  check('画像の合計の 2 割以上の PDF は、名前がふつうでも消す', names(rules.planPdfStrip([...imgs('CG', 20), { path: '作品名.pdf', size: 3_000_000 }])), ['作品名.pdf']);
  // 文字あり・なしの 2 版を画像で持ち、PDF は 1 版ぶん（画像の合計の 1 割ほど）
  const two = [...imgs('『作品』/01_本編', 254, 1_150_000), ...imgs('『作品』/02_本編(文字なしver)', 254, 1_150_000), { path: '『作品』/readme.txt', size: 1082 }];
  check('2 版の画像と 1 版ぶんの PDF（名前が画像フォルダと重なる）', names(rules.planPdfStrip([...two, { path: '『作品』/本編.pdf', size: 69_201_295 }])), ['『作品』/本編.pdf']);
  check('名前が重ならなくても、いちばん大きい画像フォルダの 1 割以上なら消す', names(rules.planPdfStrip([...two, { path: '『作品』/全ページ.pdf', size: 40_000_000 }])), ['『作品』/全ページ.pdf']);
  check('名前が重ならず小さいものは残す', names(rules.planPdfStrip([...two, { path: '『作品』/あいさつ.pdf', size: 2_000_000 }])), []);
  check('小さい PDF（説明書など）は残す', names(rules.planPdfStrip([...imgs('CG', 20), { path: '作品名.pdf', size: 200_000 }])), []);
  check('おまけ・設定資料らしい名前は大きくても残す', names(rules.planPdfStrip([...imgs('CG', 20), { path: 'おまけ/設定資料集.pdf', size: 9_000_000 }])), []);
  check('画像が少ない作品は触らない（PDF が本体かもしれない）', names(rules.planPdfStrip([...imgs('表紙', 3), { path: 'スマホ版/作品.pdf', size: 9_000_000 }])), []);
  check('音声が入っている作品は触らない（台本 PDF）', names(rules.planPdfStrip([...imgs('イラスト', 20), { path: '台本スマホ用.pdf', size: 9_000_000 }, { path: '01.mp3', size: 1 }])), []);
  check('PDF を消す対象は同人の CG・マンガだけ', [
    policy.pdfStripType({ category: 'doujin', workType: 'cg' }),
    policy.pdfStripType({ category: 'doujin', workType: 'manga' }),
    policy.pdfStripType({ category: 'book', workType: 'manga' }),
    policy.pdfStripType({ category: 'doujin', workType: 'voice' }),
    policy.pdfStripType({ category: 'doujin', workType: null })
  ], ['cg', 'manga', null, null, null]);
  check('圧縮の扱いの種別（分からないものは その他）', [
    policy.archiveWorkType({ workType: 'voice' }),
    policy.archiveWorkType({ workType: 'game' }),
    policy.archiveWorkType({ workType: null })
  ], ['voice', 'other', 'other']);
  const plan = rules.planPdfStrip([...imgs('CG', 20), { path: 'スマホ/a.pdf', size: 10 }, { path: 'readme.pdf', size: 10 }]);
  check('残す PDF と画像の数も返す', [plan.kept, plan.imageCount, plan.removeBytes], [['readme.pdf'], 20, 10]);
}

console.log('\n== NeeView の初期設定（見開き・サブフォルダー） ==');
{
  const nv = build('src/main/viewer/neeviewSettings.ts', 'neeviewSettings.test.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neeview-test-'));
  const exe = path.join(dir, 'NeeView.exe');
  // 版情報の形だけ真似る（FileVersion の後ろに区切りと版の文字列）
  fs.writeFileSync(exe, Buffer.concat([Buffer.alloc(64), Buffer.from('FileVersion\0\0\u000046.3.4312.0\0', 'utf16le'), Buffer.alloc(16)]));
  check('インストーラ版（設定の置き場所が違う）は触らない', await nv.neeViewSettingFile(exe), null);
  fs.writeFileSync(path.join(dir, 'NeeView.settings.json'), JSON.stringify({ PackageType: 'Zip', UseLocalApplicationData: false }));
  check('exe の版から Format を作る', await nv.neeViewFormat(exe), 'NeeView/46.3.4312');
  const file = path.join(dir, 'Profile', 'UserSetting.json');
  check('無ければ作る', await nv.applyNeeViewDefaults(exe, { onlyCreate: true }), 'created');
  const created = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('見開き・サブフォルダーを読み込む（開いている本と既定の両方）', created, {
    Format: 'NeeView/46.3.4312',
    Config: { BookSetting: { PageMode: 'WidePage', IsRecursiveFolder: true }, BookSettingDefault: { PageMode: 'WidePage', IsRecursiveFolder: true } }
  });
  check('NeeView と同じく CRLF で書く', fs.readFileSync(file, 'utf8').includes('\r\n'), true);
  // 入れ直しで引き継いだ設定は、入れるときには変えない
  fs.writeFileSync(file, JSON.stringify({ Format: 'NeeView/46.3.4312', Config: { Window: { WindowPlacement: 'Maximized' }, BookSetting: { PageMode: 'SinglePage', SortMode: 'FileName' } } }));
  check('入れるときは、ある設定を変えない', await nv.applyNeeViewDefaults(exe, { onlyCreate: true }), 'unchanged');
  check('ボタンからは2項目だけ書き換える', await nv.applyNeeViewDefaults(exe), 'merged');
  const merged = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('ほかの設定はそのまま', [merged.Config.Window, merged.Config.BookSetting, merged.Config.BookSettingDefault], [
    { WindowPlacement: 'Maximized' },
    { PageMode: 'WidePage', SortMode: 'FileName', IsRecursiveFolder: true },
    { PageMode: 'WidePage', IsRecursiveFolder: true }
  ]);
  check('もう入っていれば書かない', await nv.applyNeeViewDefaults(exe), 'unchanged');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n== 総集編・セットの収録作品（説明文の一覧とサークルの作品一覧） ==');
{
  const comp = build('src/shared/compilation.ts', 'compilation.test.cjs');
  const description = [
    '人気シリーズをまとめた総集編です。',
    '【収録作品】',
    'シリーズの始まりから最新作まで',
    '01：星降る森の小さな図書館',
    '02：星降る森の小さな図書館2 〜冬の章〜',
    'CG枚数：120枚',
    '03：放課後の天文部と七つの謎',
    '・海辺の喫茶店へようこそ（2019年発売）',
    '※特典は含まれません',
    '04：ここは一覧の外'
  ].join('\n');
  const entries = comp.parseCompilationEntries(description);
  check('見出しの後ろを、注意書きまで読む（枚数の行は外す・発売年は落とす）', entries, [
    { title: 'シリーズの始まりから最新作まで', listed: false },
    { title: '星降る森の小さな図書館', listed: true },
    { title: '星降る森の小さな図書館2 〜冬の章〜', listed: true },
    { title: '放課後の天文部と七つの謎', listed: true },
    { title: '海辺の喫茶店へようこそ', listed: true }
  ]);
  check('見出しが無くても、番号つきの行が 2 つあれば読む', comp.parseCompilationEntries('説明\n1. 雨の日の郵便屋さん\n2. 晴れの日の郵便屋さん').map((e) => e.title), ['雨の日の郵便屋さん', '晴れの日の郵便屋さん']);
  check('番号つきの行が 1 つだけなら読まない', comp.parseCompilationEntries('1. 雨の日の郵便屋さん'), []);
  check('総集編のタグがあれば対象', comp.isCompilationLike({ title: '星降る森 完全版', tags: ['総集編'], description }), true);
  check('タイトルの言葉でも対象（詰め合わせ）', comp.isCompilationLike({ title: '星降る森 3作品詰め合わせ', tags: [], description }), true);
  check('手がかりが無ければ、一覧らしい行があっても対象にしない', comp.isCompilationLike({ title: '星降る森', tags: [], description }), false);

  const pool = [
    { key: 'P2', title: '星降る森の小さな図書館', sameMaker: true },
    { key: 'P3', title: '星降る森の小さな図書館2 〜冬の章〜', sameMaker: true },
    { key: 'P4', title: '放課後の天文部と七つの謎【DL版】', sameMaker: false },
    { key: 'P5', title: '雪国の温泉宿', sameMaker: true },
    { key: 'P6', title: '海辺の喫茶店', sameMaker: false }
  ];
  const matched = comp.matchCompilationEntries(entries, pool);
  check('照らし合わせ: 同じサークルは近いもの、別のサークルはほぼ同じタイトルだけ・番号の無い文は結び付かなければ外す', matched.map((m) => [m.position, m.title, m.matches.map((x) => x.key)]), [
    [1, '星降る森の小さな図書館', ['P2']],
    [2, '星降る森の小さな図書館2 〜冬の章〜', ['P3']],
    [3, '放課後の天文部と七つの謎', ['P4']],
    [4, '海辺の喫茶店へようこそ', []]
  ]);
  const quoted = comp.parseCompilationEntries('▼収録作品\n『星降る森の小さな図書館』\n星降る森の小さな図書館と、冬の物語をひとつに。\n 雪国の温泉宿 ▼【ソフ倫受理番号：0000000D】\n※内容に変更はありません');
  check('『』で囲んだ行・ソフ倫の受理番号つきの行は、印が無くてもタイトル（▼の見出しも読む）', quoted, [
    { title: '星降る森の小さな図書館', listed: true },
    { title: '星降る森の小さな図書館と、冬の物語をひとつに。', listed: false },
    { title: '雪国の温泉宿', listed: true }
  ]);
  check('「セット商品」のタグ・セット商品も手がかりにする', [
    comp.hasCompilationSignal({ title: '星降る森＆雪国', tags: ['セット商品'], description: null }),
    comp.hasCompilationSignal({ title: '星降る森＆雪国', tags: [], description: null, productType: 'set' }),
    comp.hasCompilationSignal({ title: '星降る森＆雪国', tags: [], description: null, productType: 'single' })
  ], [true, true, false]);
  check('版違いが並んでも 3 つまで', comp.matchCompilationEntries([{ title: '星降る森の図書館', listed: true }], [1, 2, 3, 4].map((n) => ({ key: `V${n}`, title: '星降る森の図書館', sameMaker: true }))).map((m) => m.matches.length), [3]);

  const cat = build('src/main/sites/catalogParse.ts', 'catalogParse.test.cjs');
  check('DMM 同人のサークル一覧', cat.parseDoujinMakerList(
    '<li><a href="https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_100001/" onmousedown="x"> <img src="a.jpg" alt="星降る森 &amp; 図書館"> </a>' +
    '<a href="https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_100001/"><img alt="星降る森 &amp; 図書館"></a>' +
    '<a href="https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_100002/"><img src="b.jpg" alt="雪国の温泉宿"></a></li>'
  ), [
    { productId: 'd_100001', title: '星降る森 & 図書館', url: 'https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_100001/' },
    { productId: 'd_100002', title: '雪国の温泉宿', url: 'https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=d_100002/' }
  ]);
  check('DMM PCゲームのブランド一覧', cat.parseDlsoftMakerList(
    '<a href="https://dlsoft.dmm.co.jp/detail/moon_0001/" title="月の本編【受賞】" class="component-cardProductBuy__detailLink" data-x="1"><img></a>' +
    '<a class="component-cardProductBuy__detailLink" title="月の続編" href="https://dlsoft.dmm.co.jp/detail/moon_0002/"></a>' +
    '<a href="https://dlsoft.dmm.co.jp/detail/other_0001/" title="関係ないリンク"></a>'
  ).map((i) => [i.productId, i.title]), [['moon_0001', '月の本編【受賞】'], ['moon_0002', '月の続編']]);
  check('DLsite のサークル一覧', cat.parseDlsiteCircleList(
    '<tr data-list_item_product_id="RJ01000001"><div hidden class="ga4_event_item_RJ01000001"data-product_id="RJ01000001"data-work_name="星降る森&quot;完全版&quot;"data-maker_id="RG1"></div></tr>',
    'maniax'
  ), [{ productId: 'RJ01000001', title: '星降る森"完全版"', url: 'https://www.dlsite.com/maniax/work/=/product_id/RJ01000001.html' }]);
  check('一覧を取るストア', [
    cat.catalogStoreOf({ siteId: 'dmm', floorId: 'doujin', makerId: '100', detailUrl: null }),
    cat.catalogStoreOf({ siteId: 'dmm', floorId: 'dlsoft', makerId: '200', detailUrl: null }),
    cat.catalogStoreOf({ siteId: 'dlsite', floorId: 'library', makerId: 'RG1', detailUrl: 'https://www.dlsite.com/home/work/=/product_id/RJ1.html' }),
    cat.catalogStoreOf({ siteId: 'dmm', floorId: 'book', makerId: '300', detailUrl: null }),
    cat.catalogStoreOf({ siteId: 'dmm', floorId: 'doujin', makerId: null, detailUrl: null })
  ], [{ store: 'dmm-doujin', makerId: '100' }, { store: 'dmm-dlsoft', makerId: '200' }, { store: 'dlsite-home', makerId: 'RG1' }, null, null]);
  check('一覧のページの URL', [
    cat.catalogPageUrl('dmm-doujin', '100', 1),
    cat.catalogPageUrl('dmm-doujin', '100', 2),
    cat.catalogPageUrl('dmm-dlsoft', '200', 2),
    cat.catalogPageUrl('dlsite-maniax', 'RG1', 3)
  ], [
    'https://www.dmm.co.jp/dc/doujin/-/list/=/article=maker/id=100/',
    'https://www.dmm.co.jp/dc/doujin/-/list/=/article=maker/id=100/page=2/',
    'https://dlsoft.dmm.co.jp/list/?maker=200&sort=date&page=2',
    'https://www.dlsite.com/maniax/circle/profile/=/maker_id/RG1/order/release_d/per_page/100/show_type/1/page/3'
  ]);
  const pages = [
    '本作は「星降る森の物語」の前編・後編に描き下ろしを加えた総集編です。',
    '==============================',
    '【収録内容】',
    '',
    '◆星降る森 〜前編〜 「図書館の少女」（57ページ）',
    '',
    '◆星降る森 〜後編〜 「二人の図書館」（81ページ）',
    '',
    '◆【初収録】星降る森 〜過去編〜 「初めて森へ来た日」（60ページ）',
    '',
    '◆別視点ver.同梱（260ページ）',
    '◆トーンver.同梱（260ページ×2パターン）',
    '◆修正 カラー:白ノリ トーン:黒ノリ',
    '◆サイズ 1136×1600px',
    '◆JPEG版、PDF版の2種同梱',
    '全編 260ページ×4パターンの1，040ページ',
    '==============================',
    '制作:星のサークル'
  ].join('\n');
  check('ページ数の括弧・【初収録】の印を落とし、同梱・修正・サイズなどの行は外す', comp.parseCompilationEntries(pages).filter((e) => e.listed).map((e) => e.title), [
    '星降る森 〜前編〜 「図書館の少女」',
    '星降る森 〜後編〜 「二人の図書館」',
    '星降る森 〜過去編〜 「初めて森へ来た日」'
  ]);
  check('伏せ字・記号の違いは無視する', comp.titleCore('ひ●みつの ｱｲﾃﾑ！'), 'ひみつのアイテム');
}

console.log('\n== 動画の画質・説明文の HTML ==');
{
  const vq = build('src/shared/videoQuality.ts', 'videoQuality.test.cjs');
  const mk = (key, name, order, sizeMb, part = 1) => ({ label: `ダウンロード ${name}`, url: `u/${key}/${part}`, kind: 'download', quality: { key, name, sizeMb, order, part } });
  const links = [mk('300', '低画質 (144p)', 1, 373), mk('6000', 'FullHD (1080p60)', 15, 6679), mk('4k', '4K (2160p60)', 20, 11023), mk('4000', 'HD (720p60)', 11, 4845)];
  const opts = vq.videoQualityOptions(links);
  check('画質は API の並びで高い順（4k を 4 と読まない）', opts.map((o) => o.key), ['4k', '6000', '4000', '300']);
  check('既定: いちばん高い画質', vq.pickVideoQuality(opts, 'best')?.key, '4k');
  check('既定: 1080p まで', vq.pickVideoQuality(opts, 'h:1080')?.key, '6000');
  check('既定: 高さに合うものが無ければいちばん低い画質', vq.pickVideoQuality(opts, 'h:100')?.key, '300');
  check('作品ごとの指定', vq.pickVideoQuality(opts, 'q:4000')?.key, '4000');
  const parts = [mk('6000', 'FullHD (1080p)', 15, 9000, 1), mk('6000', 'FullHD (1080p)', 15, null, 2), mk('6000', 'FullHD (1080p)', 15, null, 3)];
  check('複数パートは合計の容量とパート数', vq.videoQualityOptions(parts).map((o) => [o.sizeMb, o.parts]), [[9000, 3]]);
  const old = [{ label: 'ダウンロード 6000k', url: 'a', kind: 'download' }, { label: 'ダウンロード 300k', url: 'b', kind: 'download' }];
  check('画質の情報が無い古い導線は、ラベルの数から', vq.videoQualityOptions(old).map((o) => [o.key, o.height]), [['6000', 1080], ['300', 144]]);

  const ht = build('src/shared/htmlText.ts', 'htmlText.test.cjs');
  check('説明文の HTML をテキストに', ht.htmlToText('一行目<br>二行目<br />&amp;<b>強調</b>&quot;'), '一行目\n二行目\n&強調"');
  check('タグが無ければそのまま', ht.htmlToText('a < b\n  c'), 'a < b\n  c');
}

console.log('\n== PDF の見開き ==');
{
  const sp = build('src/renderer/src/lib/pdfSpread.ts', 'pdfSpread.test.cjs');
  check('単ページ', sp.spreadRows(3, 'off'), [[1], [2], [3]]);
  check('見開き（奇数ページは最後が 1 枚）', sp.spreadRows(5, 'on'), [[1, 2], [3, 4], [5]]);
  check('見開き（表紙は単独）', sp.spreadRows(6, 'cover'), [[1], [2, 3], [4, 5], [6]]);
  check('ページを含む組', [sp.rowIndexOf(sp.spreadRows(6, 'cover'), 1), sp.rowIndexOf(sp.spreadRows(6, 'cover'), 3), sp.rowIndexOf(sp.spreadRows(6, 'cover'), 99)], [0, 1, 0]);
  check('ページが無ければ組も無い', sp.spreadRows(0, 'on'), []);
}

if (failures.length) {
  console.error(`\nNG: ${failures.length} 件失敗`);
  process.exit(1);
}
console.log('\nOK');
