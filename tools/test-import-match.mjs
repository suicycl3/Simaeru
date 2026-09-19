/**
 * 取り込み時の突き合わせ（作品ID・タイトル正規化）の検証。
 *   node tools/test-import-match.mjs
 */
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const outFile = path.join(os.tmpdir(), 'importMatch.test.cjs');
esbuild.buildSync({
  entryPoints: [path.join(import.meta.dirname, '..', 'src', 'main', 'import', 'matcher.ts')],
  alias: { '@shared': path.join(import.meta.dirname, '..', 'src', 'shared') },
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'error'
});
const { buildMatchIndex, extractIds, normalizeTitle, stripExtension, matchFile, isRuntimeDir, isScanTarget } = require(outFile);

const failures = [];
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  console.log(`${ok ? '  ok ' : '  NG '} ${label}${ok ? '' : `\n        期待 ${e}\n        実際 ${a}`}`);
  if (!ok) failures.push(label);
};

console.log('== 作品IDの抽出 ==');
check('DMM同人', extractIds(['d_100003.zip']), ['d_100003']);
check('DLsite同人', extractIds(['RJ01000002.zip']), ['RJ01000002']);
check('DLsiteゲーム', extractIds(['[サークル] タイトル VJ000001']), ['VJ000001']);
check('DMM電子書籍', extractIds(['b111abcd00001.epub']), ['b111abcd00001']);
check('DMM PCゲーム', extractIds(['abc_1001']), ['abc_1001']);
check('前後が英数字なら拾わない', extractIds(['xd_100003y.zip']), []);
check('親フォルダからも拾う', extractIds(['disc1.zip', '[サークル] 作品 RJ300001']), ['RJ300001']);
check('全角で書かれていても拾う', extractIds(['ｄ＿１００００３.zip']), ['d_100003']);
check('全角のPCゲームIDも拾う', extractIds(['ｐｃｇ＿０００１']), ['pcg_0001']);

console.log('\n== タイトルの正規化 ==');
check('括弧と記号を落とす', normalizeTitle('【完全版】まじめ後輩ちゃん・ひみつ！（単話）'), normalizeTitle('まじめ後輩ちゃんひみつ'));
check('全角半角をそろえる', normalizeTitle('Ｇａｍｅ　２'), 'game2');
check('ひらがなとカタカナを同じに', normalizeTitle('ばーじょん'), normalizeTitle('バージョン'));
// 購入履歴は「ダウンロード版」、手元のフォルダは「DL版」と書かれていることが多い
check('ダウンロード版とDL版を同じ扱いに',
  normalizeTitle('さくらつまみ2 〜おてんば先輩とおっとり後輩とのにぎやか生活〜 ダウンロード版'),
  normalizeTitle('さくらつまみ２ おてんば先輩とおっとり後輩とのにぎやか生活 DL版'));
check('中身が変わる「完全版」は落とさない',
  normalizeTitle('ひだまりの向こうがわ 完全版') === normalizeTitle('ひだまりの向こうがわ'), false);
// 区切りの最後の塊が使い捨ての印のときだけ落とす（語の一部の "dl" は壊さない）
check('末尾の DL / 版数 / インストなし を落とす',
  ['Kiss&Crisis_DL', '魔導士ティアと不思議な大図書館_ver1.07', '僕ママ×友ママ交姦ハメップ性活_DL版_インストなし'].map((x) => normalizeTitle(x)),
  ['kisscrisis', '魔導士ティアト不思議ナ大図書館', '僕ママ友ママ交姦ハメップ性活']);
check('語の一部の dl は残す', normalizeTitle('dl記念 dlsite作品'), 'dl記念dlsite作品');
check('題名の一部かもしれない V3 は残す', normalizeTitle('ダンガンロンパ V3'), 'ダンガンロンパv3');
check('閉じていない括弧から先は宣伝文句とみなす',
  normalizeTitle('ダウナークールギャルJKとだらハメオホ声子作りえっち【FANZA限定差分付き'),
  normalizeTitle('【10，000DL記念ボイス追加！】【FANZA限定差分付き】ダウナークールギャルJKとだらハメオホ声子作りえっち'));

const products = [
  { id: 1, productId: 'RJ01000002', contentId: 'RJ01000002', title: 'まじめ後輩ちゃんとひみつの図書室', siteId: 'dlsite', category: 'doujin' },
  { id: 2, productId: 'd_100004', contentId: 'd_100004', title: 'おてんばお嬢様がひみつのレッスンでわんつー', siteId: 'dmm', category: 'doujin' },
  { id: 3, productId: 'VJ000001', contentId: 'VJ000001', title: 'ひだまりの向こうがわ', siteId: 'dlsite', category: 'game' },
  { id: 4, productId: 'VJ000002', contentId: 'VJ000002', title: 'ひだまりの向こうがわ 完全版', siteId: 'dlsite', category: 'game' },
  { id: 5, productId: 'pcg_0001', contentId: 'pcg_0001', title: 'さくらつまみ2 〜おてんば先輩とおっとり後輩とのにぎやか生活〜 ダウンロード版', siteId: 'dmm', category: 'game' }
];

console.log('\n== 突き合わせ ==');
const byId = matchFile(['RJ01000002.zip', '[まるねこ工房] まじめ後輩ちゃん'], products);
check('IDが1件 → 自動確定', [byId.decided, byId.candidates[0]?.product.id], [true, 1]);

const byTitle = matchFile(['おてんばお嬢様_レッスン.zip'], products);
check('IDなし → 候補どまり', byTitle.decided, false);
check('タイトル部分一致で候補に出る', byTitle.candidates.map((c) => c.product.id), [2]);

const ambiguous = matchFile(['ひだまりの向こうがわ.zip'], products);
check('似た作品が複数 → 全部候補', ambiguous.candidates.map((c) => c.product.id).sort(), [3, 4]);
check('複数候補は自動確定しない', ambiguous.decided, false);

const unknown = matchFile(['d_999999.zip'], products);
check('購入履歴に無いID → 候補なし', [unknown.decided, unknown.candidates.length], [false, 0]);
// data_0001 のような作品IDでない名前を拾っただけのときに、タイトル照合ごと止めてしまわないこと
// 手元は「DL版」・全角数字、購入履歴は「ダウンロード版」・半角数字（実例: pcg_0001）
const edition = matchFile(['sakura2.exe', 'さくらつまみ２ おてんば先輩とおっとり後輩とのにぎやか生活 DL版'], products);
check('版の書き方が違っても見つかる', edition.candidates.map((c) => [c.product.id, c.confidence]), [[5, 'high']]);

const falseId = matchFile(['data_0001', 'ひだまりの向こうがわ.zip'], products);
check('IDらしき名前が別物でもタイトルで探す', falseId.candidates.map((c) => c.product.id).sort(), [3, 4]);

console.log('\n== 作り置きの索引 ==');
const index = buildMatchIndex(products);
check('索引でも答えは同じ', matchFile(['RJ01000002.zip'], index).candidates.map((c) => c.product.id), [1]);
check('コンテンツIDからも引ける',
  matchFile(['x VJ000001 x'], buildMatchIndex([{ id: 9, productId: 'other_0001', contentId: 'VJ000001', title: '別名の作品', siteId: 'dlsite', category: 'game' }])).candidates.map((c) => c.product.id),
  [9]);
const first = matchFile(['ひだまりの向こうがわ.zip'], index);
check('同じ名前の並びは記憶から返る（作り直さない）', matchFile(['ひだまりの向こうがわ.zip'], index) === first, true);

console.log('\n== 足切りを入れても答えが変わらないこと（無作為な突き合わせ） ==');
{
  // 文字ビットでの足切りは速さのための仕組みで、答えは素朴な実装と一致しなければならない
  const isSub = (short, long) => {
    let i = 0;
    for (const ch of long) {
      if (ch === short[i]) i++;
      if (i === short.length) return true;
    }
    return i === short.length;
  };
  const reference = (parts, list) => {
    const keys = [...new Set(parts.map((part) => normalizeTitle(stripExtension(part))))].filter((k) => k.length >= 4);
    const out = [];
    for (const product of list) {
      const key = normalizeTitle(product.title);
      if (!key) continue;
      if (keys.includes(key)) { out.push([product.id, 'high', 1]); continue; }
      let best = 0;
      for (const k of keys) {
        const [short, long] = k.length <= key.length ? [k, key] : [key, k];
        const ratio = short.length / long.length;
        if (short.length < 8 && ratio < 0.5) continue;
        if (long.includes(short) || (short.length >= 6 && ratio >= 0.4 && isSub(short, long))) {
          if (ratio > best) best = ratio;
        }
      }
      if (best > 0) out.push([product.id, 'medium', best]);
    }
    out.sort((x, y) => (x[1] === y[1] ? y[2] - x[2] : x[1] === 'high' ? -1 : 1));
    return out.slice(0, 8).map(([id, confidence]) => [id, confidence]);
  };
  // 何度走らせても同じになるよう、乱数は固定の種から作る
  let seed = 20260919;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const alphabet = [...'あいうえおかきくけこさしすせそabcde12'];
  const pick = (n) => Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');
  const list = Array.from({ length: 120 }, (_, i) => ({
    id: i + 1,
    productId: `z_${1000 + i}`,
    contentId: null,
    title: pick(4 + Math.floor(rnd() * 14)),
    siteId: 'dmm',
    category: 'doujin'
  }));
  const fuzzIndex = buildMatchIndex(list);
  let mismatch = null;
  for (let n = 0; n < 400 && !mismatch; n++) {
    // 半分は既存タイトルから文字を抜いた名前（部分一致・飛ばし読みを起こしやすくする）
    const base = list[Math.floor(rnd() * list.length)].title;
    const cut = [...base].filter(() => rnd() > 0.3).join('');
    const parts = [`${rnd() < 0.5 ? cut : pick(3 + Math.floor(rnd() * 10))}.zip`, pick(2 + Math.floor(rnd() * 8))];
    const got = matchFile(parts, fuzzIndex).candidates.map((c) => [c.product.id, c.confidence]);
    const want = reference(parts, list);
    if (JSON.stringify(got) !== JSON.stringify(want)) mismatch = { parts, got, want };
  }
  check('400通りすべてで素朴な実装と一致', mismatch, null);
}

console.log('\n== 候補の絞り込みと並び ==');
{
  const list = [
    { id: 1, productId: 'x_0001', contentId: null, title: 'BRAND.teamXX よくばりセット 〜人気シリーズをまとめた厳選5本パック〜', siteId: 'dmm', category: 'game' },
    { id: 2, productId: 'x_0002', contentId: null, title: 'なつやすみ！みずうみでのんびりスイミング！ 〜監視員のバイトを始めたらにぎやかな夏になった件〜 ダウンロード版', siteId: 'dmm', category: 'game' },
    { id: 3, productId: 'x_0003', contentId: null, title: 'なつやすみ！のんびり田舎ライフ 〜年上のいとこたちとのにぎやか生活〜 ダウンロード版', siteId: 'dmm', category: 'game' }
  ];
  // 親フォルダの「anim」がどの作品名にも含まれてしまい、候補が溢れていた
  const noisy = matchFile(['swimming5.exe', 'なつやすみ！みずうみでのんびりスイミング DL版', 'anim'], list);
  check('短い親フォルダ名だけでは候補にしない', noisy.candidates.map((c) => c.product.id), [2]);
  check('近い方が先', matchFile(['なつやすみ！のんびり田舎ライフ', 'anim'], list).candidates.map((c) => c.product.id)[0], 3);
  check('親フォルダ名だけのフォルダは候補なし', matchFile(['readme.txt', 'SaveGraphic', 'anim'], list).candidates.length, 0);
}

console.log('\n== 対象の拡張子 ==');
check('zipは対象', isScanTarget('a.ZIP'), true);
check('テキストは対象', isScanTarget('readme.txt'), true);
check('画像は対象外', isScanTarget('cover.jpg'), false);

console.log('\n== 同梱のランタイムは作品ではない ==');
check('DirectX のフォルダは中を見ない', [isRuntimeDir('DirectX'), isRuntimeDir('_CommonRedist'), isRuntimeDir('vcredist')], [true, true, true]);
check('版が付いた名前・実行環境のフォルダも同じ扱い',
  [isRuntimeDir('DirectX9c'), isRuntimeDir('Runtime'), isRuntimeDir('UCRTx86'), isRuntimeDir('vc_redist2019')],
  [true, true, true, true]);
check('作品のフォルダは見る', [isRuntimeDir('なつやすみ！'), isRuntimeDir('data')], [false, false]);
check('DirectX の導入ファイルは拾わない',
  ['dxwebsetup.exe', 'DXSETUP.exe', 'directx_Jun2010_redist.exe', 'vc_redist.x64.exe', 'oalinst.exe', 'UE4PrereqSetup_x64.exe'].map((f) => isScanTarget(f)),
  [false, false, false, false, false, false]);
check('作品の実行ファイルは拾う', [isScanTarget('swimming5.exe'), isScanTarget('setup.exe')], [true, true]);

if (failures.length) {
  console.error(`\nNG: ${failures.length} 件失敗 (${failures.join(' / ')})`);
  process.exit(1);
}
console.log('\nOK');
