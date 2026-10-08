/**
 * 統計のタグの規則（分類・名寄せ）と、購入履歴の集計・件数の移り変わりを確かめる。
 *   node tools/test-purchase-stats.mjs
 * 作品は架空のもの。タグはサイトが実際に付けている一般的な名前を使う。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'simaeru-stats-'));
const outfile = path.join(work, 'stats.cjs');
buildSync({
  stdin: { contents: "export * from './src/shared/tagRules'; export * from './src/shared/purchaseStats'; export * from './src/shared/genreCatalog';", resolveDir: root, loader: 'ts' },
  outfile, bundle: true, platform: 'node', format: 'cjs', alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'error'
});
const s = require(outfile);
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };

test('属性ではないタグを種類ごとに外す', () => {
  const kinds = Object.fromEntries([
    '成人向け', '男性向け', 'オリジナル', '旧作', 'デモ・体験版あり', '同人',
    '最大90%OFFセール【感謝祭オータム2026】', '3点以上で5%OFFクーポン／感謝祭オータム2026対象', '秋の最大16%ポイント還元キャンペーン 第5弾', 'コミケ104（2024夏）',
    'Windows11対応作品', 'ブラウザ対応', 'QUALITY_GROUP_HD',
    'CGがいい', 'エロに定評',
    'マンガ', 'ボイス・ASMR', 'ADV',
    '拘束精液まみれADV',
    '夏が舞台のゲーム', '中出し', 'ASMR', 'SM', 'OL',
    // 形の決まった新しい言い回しも拾う
    '育成AVG', '戦車擬人化砲撃ACT', '脱衣STG', '処女ムービー', '推理アドベンチャー', 'コマンド選択式アドベンチャーゲーム',
    '誘惑してきた妹とエッチを楽しむゲーム', 'ロールプレイング(コスプレRPG)', 'AVG・RPG等7本収録', 'RPG', 'ノベル',
    'ネクスト同人2026', 'YOU5月イベント', 'BEST PRICE版', 'がんばろう同人！',
    'QUALITY_GROUP_4K', '4K', '8KVR', 'DMM GAMES PLAYER専用', 'Mac対応商品', '4時間以上作品',
    'INTERHEART作品', 'ぺんしるブランド',
    // 短い公式ジャンルは残す
    '癒されるゲーム', '田舎が舞台のゲーム', '3P・4P', 'KU100'
  ].map((tag) => [tag, s.classifyTag(tag)]));
  assert.deepEqual(kinds, {
    '成人向け': 'audience', '男性向け': 'audience', 'オリジナル': 'audience', '旧作': 'audience', 'デモ・体験版あり': 'audience', '同人': 'audience',
    '最大90%OFFセール【感謝祭オータム2026】': 'promo', '3点以上で5%OFFクーポン／感謝祭オータム2026対象': 'promo',
    '秋の最大16%ポイント還元キャンペーン 第5弾': 'promo', 'コミケ104（2024夏）': 'promo',
    'Windows11対応作品': 'tech', 'ブラウザ対応': 'tech', 'QUALITY_GROUP_HD': 'tech',
    'CGがいい': 'review', 'エロに定評': 'review',
    'マンガ': 'format', 'ボイス・ASMR': 'format', 'ADV': 'format',
    '拘束精液まみれADV': 'blurb',
    // 公式ジャンル・短い英字のジャンルは属性
    '夏が舞台のゲーム': 'attribute', '中出し': 'attribute', 'ASMR': 'attribute', 'SM': 'attribute', 'OL': 'attribute',
    '育成AVG': 'blurb', '戦車擬人化砲撃ACT': 'blurb', '脱衣STG': 'blurb', '処女ムービー': 'blurb', '推理アドベンチャー': 'blurb',
    'コマンド選択式アドベンチャーゲーム': 'blurb', '誘惑してきた妹とエッチを楽しむゲーム': 'blurb',
    'ロールプレイング(コスプレRPG)': 'format', 'AVG・RPG等7本収録': 'format', 'RPG': 'format', 'ノベル': 'format',
    'ネクスト同人2026': 'promo', 'YOU5月イベント': 'promo', 'BEST PRICE版': 'promo', 'がんばろう同人！': 'promo',
    'QUALITY_GROUP_4K': 'tech', '4K': 'tech', '8KVR': 'tech', 'DMM GAMES PLAYER専用': 'tech', 'Mac対応商品': 'tech', '4時間以上作品': 'tech',
    'INTERHEART作品': 'audience', 'ぺんしるブランド': 'audience',
    '癒されるゲーム': 'attribute', '田舎が舞台のゲーム': 'attribute', '3P・4P': 'attribute', 'KU100': 'attribute'
  });
  // 形の決まっていない文句は、店舗ページの「ゲームジャンル」欄で見た語として渡されたら外す
  assert.equal(s.classifyTag('密室陵●強要サスペンス'), 'attribute');
  assert.equal(s.classifyTag('密室陵●強要サスペンス', new Set(['密室陵●強要サスペンス'])), 'blurb');
  assert.equal(s.countsAsAttribute('密室陵●強要サスペンス', { exclude: [], include: [], groups: null, blurbs: ['密室陵●強要サスペンス'] }), false);
});

test('公式ジャンルの一覧: 分類で判定し、評価・販促は分類にかかわらず外す', () => {
  const kinds = Object.fromEntries([
    '癒されるゲーム', '夏が舞台のゲーム', 'ASMR', '寝取られ（NTR）', '後背位／バック', '東方Project', '断面図あり',
    'デジコミ', 'イラスト・CG集', '単話', 'フルカラー', 'J.GARDEN57', 'コミケ104（2024夏）', 'Windows11対応作品',
    'アメトーークCLUB「エロゲーム大好き芸人」で紹介', 'セット商品', '全年齢向け', 'CGがいい', '初心者おすすめ', '無料作品',
    // DLsite が言い換えたジャンル（API の名前・作品ページの名前とも属性）
    '陵辱', '屈辱', '痴漢', '秘密さわさわ'
  ].map((tag) => [tag, s.classifyTag(tag)]));
  assert.deepEqual(kinds, {
    '癒されるゲーム': 'attribute', '夏が舞台のゲーム': 'attribute', 'ASMR': 'attribute', '寝取られ（NTR）': 'attribute', '後背位／バック': 'attribute',
    '東方Project': 'attribute', '断面図あり': 'attribute',
    'デジコミ': 'format', 'イラスト・CG集': 'format', '単話': 'format', 'フルカラー': 'format', 'J.GARDEN57': 'promo', 'コミケ104（2024夏）': 'promo',
    'Windows11対応作品': 'tech', 'アメトーークCLUB「エロゲーム大好き芸人」で紹介': 'audience', 'セット商品': 'audience', '全年齢向け': 'audience',
    'CGがいい': 'review', '初心者おすすめ': 'promo', '無料作品': 'promo',
    '陵辱': 'attribute', '屈辱': 'attribute', '痴漢': 'attribute', '秘密さわさわ': 'attribute'
  });
  assert.equal(s.catalogKind('一覧に無い語'), null);
  // 一覧のそろったフロアでは、一覧に無い語は数えない（新しい販促・動画の検索語）
  const doujin = { siteId: 'dmm', floorId: 'doujin' };
  assert.equal(s.classifyTagIn('FANZA限定', doujin), 'unlisted');
  assert.equal(s.classifyTagIn('楓カレン', { siteId: 'dmm', floorId: 'video' }), 'unlisted');
  assert.equal(s.classifyTagIn('巨乳', doujin), 'attribute');
  assert.equal(s.classifyTagIn('輪●', doujin), 'attribute'); // DMM の以前の伏せ字の名前
  assert.equal(s.classifyTagIn('巨乳/爆乳', { siteId: 'dlsite', floorId: 'library' }), 'attribute');
  // 電子書籍は一覧が一部しか無いので、語の形だけで判定する
  assert.equal(s.classifyTagIn('FANZA限定', { siteId: 'dmm', floorId: 'book' }), 'attribute');
  // 公式ジャンルに無い語のうち、属性と言える語は既定で数える（同じ意味の公式ジャンルがあればそちらに寄せる）
  const video = { siteId: 'dmm', floorId: 'video' };
  for (const tag of ['ノーパン', '女上司', '公衆トイレ', '巨尻', 'なかだし', 'キス・接吻', 'てこき', '媚薬']) assert.equal(s.classifyTagIn(tag, video), 'attribute', tag);
  assert.equal(s.canonicalTag('なかだし').key, s.canonicalTag('中出し').key);
  assert.equal(s.canonicalTag('てこき').key, s.canonicalTag('手コキ').key);
  assert.equal(s.canonicalTag('ドラッグ').key, s.canonicalTag('薬物').key); // DMM のドラッグと DLsite の薬物
  // 意味の取れない検索語・女優名・区分は外したまま
  for (const tag of ['いく', 'まくり', '何度も', '楓カレン', 'デビュー', '男優']) assert.equal(s.classifyTagIn(tag, video), 'unlisted', tag);
  // 辞典に入れた語は一覧に無くても数える
  assert.equal(s.classifyTagIn('一覧に無い語', doujin, s.buildTagDictionary({ '属性': ['一覧に無い語'] })), 'attribute');
});

test('既定の辞典: 1 つの語は 1 つのグループにだけ入り、DLsite の言い換えはすべて寄る', () => {
  const owner = new Map();
  for (const [label, members] of Object.entries(s.TAG_GROUPS)) {
    for (const m of [label, ...members]) {
      const key = s.tagFoldKey(m);
      assert(!owner.has(key) || owner.get(key) === label, `「${m}」が ${owner.get(key)} と ${label} の両方にある`);
      owner.set(key, label);
    }
  }
  for (const [, api, display] of s.DLSITE_RENAMED_GENRES) {
    assert.equal(s.canonicalTag(api).key, s.canonicalTag(display).key, `${api} ⇔ ${display}`);
  }
  // DMM で別々の公式ジャンルとして並ぶ組は寄せない
  assert.notEqual(s.canonicalTag('メスイキ').key, s.canonicalTag('メス堕ち').key);
  assert.notEqual(s.canonicalTag('女性主導').key, s.canonicalTag('女性優位').key);
});

test('名寄せ: 表記ゆれ・同義語・伏せ字・粒度の違い', () => {
  const same = (...tags) => assert.equal(new Set(tags.map((t) => s.canonicalTag(t).key)).size, 1, tags.join(' / '));
  const differ = (a, b) => assert.notEqual(s.canonicalTag(a).key, s.canonicalTag(b).key, `${a} / ${b}`);
  // 区切り・仮名の違いだけ（辞書なし）
  same('ラブラブ・あまあま', 'ラブラブ/あまあま');
  same('褐色・日焼け', '褐色/日焼け');
  // 寝取り・寝取られはまとめた側（DMM）に寄せる
  same('寝取り・寝取られ・NTR', '寝取られ（NTR）', '寝取り', '寝取られ', '寝取り・NTR');
  assert.equal(s.canonicalTag('寝取られ').label, '寝取り・寝取られ（NTR）');
  same('先輩/後輩', '先輩', '後輩');
  // 同義語と伏せ字
  same('巨乳', '巨乳/爆乳');
  same('学園もの', '学校/学園');
  same('催●・洗脳', '催眠', 'トランス/暗示');
  same('バイノーラル', 'バイノーラル/ダミヘ', 'KU100');
  same('痴●', '痴漢');
  same('ロリ', '少女', 'つるぺた', 'ツルペタ');
  same('辱め', '陵辱');
  same('断面図あり', '断面図');
  same('百合', 'レズビアン', 'レズ/女同士');
  // 意味の違うものは寄せない
  differ('羞恥', '辱め');
  differ('逆NTR', '寝取り');
  differ('巨乳', 'おっぱい');
  // 表記ゆれだけのものは、見せるときに区切りを「・」にそろえる
  assert.equal(s.tidyTagLabel('ラブラブ/あまあま'), 'ラブラブ・あまあま');
});

test('利用者の上書き: 外す・数えるに戻す・壊れた設定', () => {
  const key = s.canonicalTag('中出し').key;
  assert.equal(s.countsAsAttribute('中出し', { exclude: [key], include: [], groups: null }), false);
  assert.equal(s.countsAsAttribute('CGがいい', { exclude: [], include: [s.canonicalTag('CGがいい').key], groups: null }), true);
  assert.deepEqual(s.parseTagOverrides('壊れた'), { exclude: [], include: [], groups: null });
  assert.deepEqual(s.parseTagOverrides('{"exclude":["a",1],"include":"x"}'), { exclude: ['a'], include: [], groups: null });
  assert.deepEqual(s.parseTagOverrides('{"groups":{"A":["b",2]," ":["c"]}}').groups, { A: ['b'] });
  assert.equal(s.parseTagOverrides('{"groups":[1]}').groups, null);
});

test('名寄せの辞典の編集: 作る・寄せる・移す・外す・名前を変える・消す', () => {
  const base = { 'NTR': ['寝取り', '寝取られ'], '巨乳': ['爆乳'] };
  let g = s.applyDictionaryEdit(base, { type: 'addGroup', label: ' 百合 ' });
  assert.deepEqual(g['百合'], []);
  assert.deepEqual(base, { 'NTR': ['寝取り', '寝取られ'], '巨乳': ['爆乳'] }); // 元は変えない
  g = s.applyDictionaryEdit(g, { type: 'addMember', label: '百合', tag: 'レズ/女同士' });
  // 別のグループの語を足すと、そちらから移す
  g = s.applyDictionaryEdit(g, { type: 'addMember', label: '巨乳', tag: '寝取り' });
  assert.deepEqual(g['NTR'], ['寝取られ']);
  assert.deepEqual(g['巨乳'], ['爆乳', '寝取り']);
  // 表記ゆれ（カタカナ・区切り）でも同じ語として外せる
  g = s.applyDictionaryEdit(g, { type: 'removeMember', label: '百合', tag: 'れず・女同士' });
  assert.deepEqual(g['百合'], []);
  // 名前を変えると、元の名前は別名として残る（並びも保つ）
  g = s.applyDictionaryEdit(g, { type: 'renameGroup', from: 'NTR', to: '寝取り・寝取られ（NTR）' });
  assert.deepEqual(Object.keys(g), ['寝取り・寝取られ（NTR）', '巨乳', '百合']);
  assert.deepEqual(g['寝取り・寝取られ（NTR）'], ['NTR', '寝取られ']);
  g = s.applyDictionaryEdit(g, { type: 'deleteGroup', label: '百合' });
  assert.deepEqual(Object.keys(g), ['寝取り・寝取られ（NTR）', '巨乳']);
  // できない編集
  assert.throws(() => s.applyDictionaryEdit(g, { type: 'addGroup', label: '巨乳' }), s.DictionaryEditError);
  assert.throws(() => s.applyDictionaryEdit(g, { type: 'addGroup', label: '  ' }), s.DictionaryEditError);
  assert.throws(() => s.applyDictionaryEdit(g, { type: 'renameGroup', from: '巨乳', to: '寝取り・寝取られ（NTR）' }), s.DictionaryEditError);
  assert.throws(() => s.applyDictionaryEdit(g, { type: 'addMember', label: '巨乳', tag: '寝取り・寝取られ（NTR）' }), s.DictionaryEditError);
  assert.throws(() => s.applyDictionaryEdit(g, { type: 'addMember', label: '無い', tag: 'x' }), s.DictionaryEditError);
  // 代表名そのものを足しても何も変わらない
  assert.deepEqual(s.applyDictionaryEdit(g, { type: 'addMember', label: '巨乳', tag: '巨乳' }), g);
});

test('編集した辞典で名寄せする', () => {
  const dict = s.buildTagDictionary({ 'おっぱい': ['巨乳', '爆乳'] });
  assert.equal(s.canonicalTag('巨乳', dict).key, s.canonicalTag('おっぱい', dict).key);
  // 既定の辞典にあっても、編集した辞典に無ければ寄せない
  assert.notEqual(s.canonicalTag('寝取り', dict).key, s.canonicalTag('寝取られ', dict).key);
});

// 架空の購入履歴
const row = (siteId, purchasedAt, tags, extra = {}) => ({ siteId, purchasedAt, tags, workType: 'voice', maker: 'サークルA', creators: [], ...extra });
const rows = [
  row('dmm', '2024-01-05', ['成人向け', '寝取り・寝取られ・NTR', '寝取られ（NTR）', '巨乳', '最大90%OFFセール【感謝祭】']),
  row('dlsite', '2024-01-20 21:30', ['寝取られ', '巨乳/爆乳', 'ラブラブ/あまあま'], { maker: 'サークルB', creators: [{ role: '声優', name: '声優X', id: null }] }),
  row('dmm', '2024-03-02', ['ラブラブ・あまあま', '巨乳'], { workType: 'manga', creators: [{ role: '作者', name: '作者Y', id: null }, { role: '作者', name: '作者Y', id: '1' }] }),
  row('dmm', '2025-02-10 08:05', ['ラブラブ・あまあま', 'CGがいい'], { creators: [{ role: '声優', name: '声優X', id: null }] }),
  row('dlsite', null, ['巨乳']) // 購入日の無いものは数えない
];

test('統計: 件数・名寄せ後のタグ・除外したタグ・時刻', () => {
  const st = s.buildPurchaseStats(rows);
  assert.equal(st.total, 4);
  assert.equal(st.firstMonth, '2024-01');
  assert.equal(st.lastMonth, '2025-02');
  assert.equal(st.monthly.length, 14); // 間の月も 0 件で並べる
  assert.deepEqual(st.bySite, [{ siteId: 'dmm', count: 3 }, { siteId: 'dlsite', count: 1 }]);
  const tags = Object.fromEntries(st.tags.map((t) => [t.label, [t.count, t.sites.join(',')]]));
  // 1 作品に NTR のタグが 2 つ付いていても 1 件。DMM と DLsite の表記がまとまる
  assert.deepEqual(tags, {
    '巨乳': [3, 'dlsite,dmm'],
    'ラブラブ・あまあま': [3, 'dlsite,dmm'],
    '寝取り・寝取られ（NTR）': [2, 'dlsite,dmm']
  });
  const excluded = Object.fromEntries(st.excludedTags.map((t) => [t.label, t.kind]));
  assert.deepEqual(excluded, { '成人向け': 'audience', '最大90%OFFセール【感謝祭】': 'promo', 'CGがいい': 'review' });
  assert.deepEqual(st.voices, [{ key: '声優X', label: '声優X', count: 2 }]);
  assert.deepEqual(st.authors, [{ key: '作者Y', label: '作者Y', count: 1 }]); // 同じ人が 2 回載っていても 1 件
  assert.equal(st.weekHour.count, 2);
  assert.equal(st.weekHour.cells[6][21], 1); // 2024-01-20 は土曜
  // 直近 12 か月（2024-03〜2025-02）に増えたタグ
  assert.deepEqual(st.risingTags.map((t) => [t.label, t.count, t.previous]), [['ラブラブ・あまあま', 2, 1]]);
});

test('統計: 期間・サイトの絞り込みと利用者の上書き', () => {
  const st = s.buildPurchaseStats(rows, { from: '2024-02', to: '2025-12', siteIds: ['dmm'] }, {
    exclude: [s.canonicalTag('巨乳').key], include: [s.canonicalTag('CGがいい').key], groups: null
  });
  assert.equal(st.total, 2);
  assert.deepEqual(st.tags.map((t) => [t.label, t.count]), [['ラブラブ・あまあま', 2], ['CGがいい', 1]]);
  assert.deepEqual(st.excludedTags.map((t) => [t.label, t.byUser]), [['巨乳', true]]);
  assert.deepEqual(st.includedTags.map((t) => [t.label, t.kind]), [['CGがいい', 'review']]);
});

test('統計と辞典の一覧は、編集した辞典に従う', () => {
  // 巨乳とラブラブ・あまあまを 1 つにまとめる（あり得ない寄せ方だが、辞典どおりに数えることを見る）
  const overrides = { exclude: [], include: [], groups: { 'まとめ': ['巨乳', '巨乳/爆乳', 'ラブラブ・あまあま'] } };
  const st = s.buildPurchaseStats(rows, {}, overrides);
  assert.deepEqual(st.tags.map((t) => [t.label, t.count]).slice(0, 1), [['まとめ', 4]]);
  // 既定の辞典の寄せ（寝取り・寝取られ）は、編集した辞典には無いので別々に数える
  assert.equal(st.tags.filter((t) => /寝取/.test(t.label)).length, 3); // 寝取り・寝取られ・NTR / 寝取られ（NTR） / 寝取られ
  const race = s.buildRaceData(rows, { dimension: 'tag', mode: 'cumulative', topN: 1 }, overrides);
  assert.deepEqual(race.series.map((x) => x.label), ['まとめ']);
  const view = s.buildDictionaryView(rows, overrides);
  assert.equal(view.edited, true);
  assert.deepEqual(view.groups.map((g) => [g.label, g.builtin, g.count]), [['まとめ', false, 5]]); // 辞典の一覧は購入日の無い作品も数える
  // 台帳にある表記を、件数つきで並べる（表記ゆれもまとめて数える）
  const members = Object.fromEntries(view.groups[0].members.map((m) => [m.tag, [m.count, m.seen.sort().join('|')]]));
  assert.deepEqual(members['ラブラブ・あまあま'], [3, 'ラブラブ/あまあま|ラブラブ・あまあま']);
  assert.deepEqual(members['巨乳'], [3, '巨乳']);
  assert.equal(view.tags.find((t) => t.tag === '寝取られ').group, null);
  assert.equal(view.tags.find((t) => t.tag === '成人向け').kind, 'audience');
  // 既定の辞典のとき
  const defaults = s.buildDictionaryView(rows);
  assert.equal(defaults.edited, false);
  const ntr = defaults.groups.find((g) => g.label === '寝取り・寝取られ（NTR）');
  assert.equal(ntr.builtin, true);
  assert.equal(ntr.count, 2);
});

test('タグ情報の揃い具合: 未取得の作品は数えず、割合はタグ情報のある作品で割る', () => {
  const r = (siteId, month, tags, extra = {}) => ({ siteId, purchasedAt: `${month}-01`, tags, workType: null, maker: null, creators: [], ...extra });
  const sample = [
    r('dmm', '2024-01', ['巨乳'], { creators: [{ role: '声優', name: 'X', id: null }] }),
    r('dmm', '2024-01', ['制服']),
    r('dmm', '2025-01', ['巨乳'], { creators: [{ role: '声優', name: 'X', id: null }] }),
    r('dmm', '2025-02', ['DLゲーム'], { metaFetched: false }), // 未取得の DMM: タグ情報なし
    r('dmm', '2025-02', [], { metaFetched: false, metaGivenUp: true }), // 取得を試しきって取れなかった
    r('dlsite', '2025-02', ['巨乳/爆乳'], { metaFetched: false }), // 未取得でも DLsite は同期でタグが取れる
    r('dmm', '2025-02', ['成人向け']) // 取得済みだが属性タグが無い
  ];
  const st = s.buildPurchaseStats(sample);
  assert.equal(st.total, 7);
  assert.deepEqual(st.coverage, { tagged: 5, unfetched: 2, givenUp: 1, peopleMissing: 3, noAttributeTags: 1 });
  // 割合は、タグ情報のある作品（直近 12 か月で 3 件、その前の 12 か月で 2 件）で割る。未取得の 2 件で薄まらない
  const rising = st.risingTags.find((t) => t.label === '巨乳');
  assert.equal(rising.share, 2 / 3);
  assert.equal(rising.previousShare, 1 / 2);
  // 動画: 対象の情報がまだ無い作品の数（期間の終わりの 3 か月のうちの数も）
  const byTag = s.buildRaceData(sample, { dimension: 'tag', mode: 'cumulative', topN: 5 });
  assert.deepEqual(byTag.missing, { total: 2, recent: 2 });
  const byVoice = s.buildRaceData(sample, { dimension: 'voice', mode: 'cumulative', topN: 5 });
  assert.deepEqual(byVoice.missing, { total: 3, recent: 3 }); // 声優は DLsite も詳細を取るまで分からない
  assert.deepEqual(s.buildRaceData(sample, { dimension: 'maker', mode: 'cumulative', topN: 5 }).missing, { total: 0, recent: 0 });
  // 省略（取得済みとみなす）なら、これまでどおり
  assert.equal(s.buildPurchaseStats(rows).coverage.unfetched, 0);
});

test('件数の移り変わり: 累計・直近の件数・上位だけ・期間', () => {
  const cumulative = s.buildRaceData(rows, { dimension: 'tag', mode: 'cumulative', topN: 2 });
  assert.equal(cumulative.months[0], '2024-01');
  assert.equal(cumulative.months.at(-1), '2025-02');
  assert.deepEqual(cumulative.monthTotals.slice(0, 3), [2, 0, 1]);
  const v = Object.fromEntries(cumulative.series.map((x) => [x.label, x.values]));
  assert.deepEqual(v['巨乳'].slice(0, 3), [2, 2, 3]);
  assert.deepEqual(v['寝取り・寝取られ（NTR）'].slice(0, 3), [2, 2, 2]);
  assert.equal(v['ラブラブ・あまあま'].at(-1), 3);
  // 直近 2 か月の件数（窓を抜けた月のぶんは減る）
  const windowed = s.buildRaceData(rows, { dimension: 'tag', mode: 'window', windowMonths: 2, topN: 5 });
  const w = Object.fromEntries(windowed.series.map((x) => [x.label, x.values]));
  assert.deepEqual(w['巨乳'].slice(0, 4), [2, 2, 1, 1]);
  // 期間を指定すると、その始めから数え直す
  const period = s.buildRaceData(rows, { dimension: 'tag', mode: 'cumulative', topN: 5, from: '2024-03', to: '2024-04' });
  assert.deepEqual(period.months, ['2024-03', '2024-04']);
  assert.deepEqual(Object.fromEntries(period.series.map((x) => [x.label, x.values])), { '巨乳': [1, 1], 'ラブラブ・あまあま': [1, 1] });
  // ほかの軸
  const makers = s.buildRaceData(rows, { dimension: 'maker', mode: 'cumulative', topN: 5 });
  assert.deepEqual(makers.series.map((x) => [x.label, x.values.at(-1)]).sort(), [['サークルA', 3], ['サークルB', 1]]);
  const types = s.buildRaceData(rows, { dimension: 'workType', mode: 'cumulative', topN: 5 });
  assert.deepEqual(types.series.map((x) => [x.label, x.values.at(-1)]).sort(), [['ボイス・ASMR', 3], ['マンガ・コミック', 1]]);
  // 何も無い期間
  assert.deepEqual(s.buildRaceData(rows, { dimension: 'tag', mode: 'cumulative', topN: 5, from: '2030-01', to: '2029-01' }).series, []);
});

test('寄せる候補: 辞典に無い組を、含む・区切った語・伏せ字で見つける（意味の違う組は出さない）', () => {
  const r = (siteId, tags) => ({ siteId, purchasedAt: '2024-01-01', tags, workType: null, maker: null, creators: [] });
  const sample = [
    r('dmm', ['断面図あり', '和服・浴衣', '痴●', '白ギャル', '寝取られない', '人妻・主婦']),
    r('dmm', ['断面図あり', '人妻']),
    r('dlsite', ['断面図', '着物/和服', '痴漢', 'ギャル', '寝取られ', '人妻'])
  ];
  const empty = { exclude: [], include: [], groups: {} };
  const pairs = s.buildDictionaryView(sample, empty).suggestions.map((x) => [x.dmm.tag, x.dlsite.tag, x.reason]);
  const has = (a, b) => pairs.some(([x, y]) => x === a && y === b);
  assert(has('断面図あり', '断面図'), JSON.stringify(pairs)); // 後ろに付いた形
  assert(has('和服・浴衣', '着物/和服'), JSON.stringify(pairs)); // 区切った語が重なる
  assert(pairs.some(([x, y, why]) => x === '痴●' && y === '痴漢' && why === 'masked'), JSON.stringify(pairs)); // 伏せ字
  assert(has('人妻・主婦', '人妻'), JSON.stringify(pairs)); // 片方は両方のサイトにある
  assert(!has('白ギャル', 'ギャル'), '前に付いた語は別の意味になりやすいので出さない');
  assert(!has('寝取られない', '寝取られ'), '否定は出さない');
  // 両方のサイトに同じ表記であるもの同士は出さない（もう同じものとして数えている）
  assert(!pairs.some(([x, y]) => x === '人妻' && y === '人妻'));
  // 外した組は出さない
  const id = s.buildDictionaryView(sample, empty).suggestions.find((x) => x.dmm.tag === '断面図あり').id;
  assert(!s.buildDictionaryView(sample, { ...empty, dismissed: [id] }).suggestions.some((x) => x.id === id));
  // 既定の辞典では、断面図・和服・痴漢・人妻はもうまとまっているので出さない
  const withDefault = s.buildDictionaryView(sample).suggestions.map((x) => x.dmm.tag);
  assert.deepEqual(withDefault.filter((t) => ['断面図あり', '和服・浴衣', '痴●', '人妻・主婦'].includes(t)), []);
  // 上書きの読み取り: 外した組を持てる
  assert.deepEqual(s.parseTagOverrides('{"dismissed":["a|b"]}').dismissed, ['a|b']);
});

test('ゲームジャンル欄で見た語の控え: 重ならず、上限で古いほうから捨てる', () => {
  const blurbFile = path.join(work, 'blurb.cjs');
  buildSync({ entryPoints: [path.join(root, 'src/main/stats/blurbTags.ts')], outfile: blurbFile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' });
  const { knownBlurbTags, rememberBlurbTags } = require(blurbFile);
  const settings = new Map();
  const repo = { getSetting: (k) => settings.get(k) ?? null, setSetting: (k, v) => settings.set(k, v) };
  assert.deepEqual(knownBlurbTags(repo), []);
  rememberBlurbTags(repo, ['甲ADV', ' 乙AVG ', '']);
  rememberBlurbTags(repo, ['甲ADV', '丙ACT']);
  rememberBlurbTags(repo, undefined);
  assert.deepEqual(knownBlurbTags(repo), ['甲ADV', '乙AVG', '丙ACT']);
  rememberBlurbTags(repo, Array.from({ length: 5001 }, (_, i) => `文句${i}`));
  const all = knownBlurbTags(repo);
  assert.equal(all.length, 5000);
  assert.equal(all.at(-1), '文句5000');
  settings.set('stats.blurbTags', '壊れた');
  assert.deepEqual(knownBlurbTags(repo), []);
});

try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 一時フォルダは OS が片付ける */ }
console.log(`OK ${passed}`);
