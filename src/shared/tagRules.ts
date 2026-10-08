/**
 * 統計で使うタグの規則（属性かどうかの分類と、サイトをまたいだ名寄せ）。
 * メイン・画面・テストで共有する。ライブラリのタグの絞り込みには使わない（絞り込みの意味が変わるため）。
 *
 * 分類: 作品の属性（中身・登場人物・シチュエーション）だけを数え、それ以外は種類ごとに外す。
 * 名寄せ: 3 段で行う。
 *   1. 表記ゆれ（NFKC、区切りの「・ / ／ 、」、カタカナとひらがな、大文字小文字）は自動で同じものにする
 *   2. 意味が同じで語が違うもの・DMM の伏せ字は、下の辞書で寄せる
 *   3. 片方のサイトがまとめていて、もう片方が分けているもの（寝取り／寝取られ など）は、まとめた側に寄せる
 */

import { t } from './i18n';
import { DLSITE_RENAMED_GENRES, GENRE_CATALOG } from './genreCatalog';

export type TagKind =
  /** 作品の属性。統計で数える */
  | 'attribute'
  /** 成人向け・男性向け・オリジナル・旧作・同人・体験版あり など、対象や区分 */
  | 'audience'
  /** セール・クーポン・キャンペーン・コミケ・アワード など、販促 */
  | 'promo'
  /** 対応 OS・ブラウザ対応・画質 など、動作環境や技術 */
  | 'tech'
  /** CGがいい・エロに定評 など、評価 */
  | 'review'
  /** マンガ・ボイス・ADV など、作品の形式（種別の統計で見せる） */
  | 'format'
  /** 「〜まみれADV」のような、1 作品専用の宣伝文句 */
  | 'blurb'
  /** 公式ジャンルの一覧がそろっているフロアで、一覧に無い語（新しい販促・宣伝文句・動画の検索語など） */
  | 'unlisted';

export const TAG_KIND_LABELS: Record<TagKind, string> = {
  attribute: '属性',
  audience: '対象・区分',
  promo: '販促',
  tech: '動作環境・技術',
  review: '評価',
  format: '形式',
  blurb: '作品ごとの宣伝文句',
  unlisted: '公式ジャンルに無い語'
};

const AUDIENCE = new Set([
  '男性向け', '女性向け', '成人向け', '全年齢', 'アダルト', 'オリジナル', '同人', '商業', '商業書籍', '旧作',
  '単体', '単体作品', 'シリーズもの', 'ベスト・総集編', '総集編', 'アンソロジー', 'その他', 'パロディ・その他',
  'DL版独占販売', '独占配信', '独占販売', '独占', '配信', 'デモ・体験版あり', '体験版あり', '原作', '原作コラボ', 'コラボ', '原作映像化作品'
]);
/** レーベル・ブランドの名前（「INTERHEART作品」「○○ブランド」） */
const LABEL = /^[A-Za-z0-9 .&＆!'-]+作品$|ブランド$/;

/**
 * 販促。セール名は年や季節が変わるので、一覧ではなく語で見る。
 * 西暦（2026 など）を含むものも、催しの名前とみなす（「ネクスト同人2026」「コミケ104（2024夏）」）
 */
const PROMO =
  /セール|OFF|ＯＦＦ|クーポン|キャンペーン|還元|ポイント|特集|アワード|受賞|コミケ|コミックマーケット|広告掲載|アクセス上位|初心者おすすめ|ランキング|予約特典|新作|準新作|注目(?:作品|サークル)|イベント|フェア|記念|期間限定|割引|半額|無料|プレゼント|対象作品|がんばろう|BEST PRICE|廉価|特価|(?:19|20)\d{2}/i;

/** 動作環境・画質・収録時間など */
const TECH =
  /対応(?:作品|商品)$|専用$|^ブラウザ対応$|^ハイビジョン$|^TWO_DIMENSION$|^QUALITY_GROUP_[A-Z0-9_]+$|^(?:MUS|ET3|TBL)$|^AMUSE CRAFT$|^\d+K(?:VR)?$|^\d+時間以上|^(?:ハイクオリティ)?VR$|^クラウドゲーム$/;

const REVIEW = /がいい$|に定評$|^萌えるゲーム$/;

/** 作品の形式の語。そのものは「形式」、前に文句が付いたもの（「育成AVG」）は「宣伝文句」 */
const FORMAT_WORDS =
  '(?:ADV|AVG|RPG|SLG|ACT|STG|アドベンチャー(?:ゲーム)?|テキストアドベンチャー|(?:デジタル|ビジュアル)?ノ[ベべ]ル(?:ゲーム)?|シミュレーション|シューティング|ムービー|アクション)';
const FORMAT_SUFFIX = new RegExp(`^(.*?)${FORMAT_WORDS}$`);
const FORMAT = new Set([
  'マンガ', 'コミック', '少年コミック', '青年コミック', 'アダルトマンガ単話', 'アダルトマンガ単行本', '漫画 / アニメ', 'CG・イラスト',
  'イラスト・CG集', 'CG集', 'ボイス・ASMR', '音声付き', '音声作品', '動画', '動画・アニメーション', 'アニメーション', 'アニメ',
  'DLゲーム', 'ゲーム系', 'ロールプレイング', 'カードゲーム', 'パズル', 'ツクール', '3D作品', '3DCG', 'ドット', 'ライトノベル'
]);
/** 「ロールプレイング(コスプレRPG)」のように、形式の後ろに括弧書きの文句が付いたもの */
const FORMAT_WITH_NOTE = /^(?:アドベンチャー|ロールプレイング|シミュレーション|パズル|デジタルノベル|アクション|シューティング|その他)[(（].*[)）]$/;
/** セット・追加ディスクなどの形（「AVG・RPG等7本収録」「…＋ファンディスク」） */
const FORMAT_PACK = /\d+本収録$|ファンディスク/;

/**
 * 1 作品専用の長い文句（「誘惑してきた妹とエッチを楽しむゲーム」）。
 * 「夏が舞台のゲーム」「癒されるゲーム」のような公式ジャンルは短いので残す
 */
const LONG_GAME_BLURB = /^.{11,}ゲーム$/;

/**
 * 公式ジャンルの一覧（genreCatalog.ts）の分類ごとの種類。
 * 'mixed' は性格の混ざった分類（「その他」）で、名前ごとの指定（CATALOG_NAME_KIND）が無ければ語の形で決め、
 * 語の形で属性になっても「対象・区分」とみなす（作品の属性の分類には入っていないため）
 */
const CATALOG_CATEGORY_KIND: Record<string, TagKind | 'mixed'> = {
  // DLsite: どの分類も作品の属性（形式に近いものは名前ごとに指定する）
  'R-18G/マニア': 'attribute',
  'アイテム/道具': 'attribute',
  'キャラクター/衣装': 'attribute',
  'こだわり/アピール': 'attribute',
  'シチュエーション/系統': 'attribute',
  'プレイ/えっち傾向': 'attribute',
  '外見/身体的特徴': 'attribute',
  // DMM
  'PCゲーム:キャラクター': 'attribute',
  'PCゲーム:ゲーム内容': 'attribute',
  'PCゲーム:コスチューム': 'attribute',
  'PCゲーム:舞台': 'attribute',
  'PCゲーム:ゲームジャンル': 'format',
  'PCゲーム:対応OS': 'tech',
  'PCゲーム:その他': 'mixed',
  '電子書籍:おすすめジャンル': 'attribute',
  '同人:趣味趣向/キャラクター': 'attribute',
  '同人:趣味趣向/コスチューム/服装/アイテム': 'attribute',
  '同人:趣味趣向/シチュエーション/系統': 'attribute',
  '同人:趣味趣向/タイプ/身体的特徴': 'attribute',
  '同人:趣味趣向/プレイ': 'attribute',
  '同人:ゲームジャンル': 'format',
  '同人:初回頒布イベント': 'promo',
  '同人:その他': 'mixed'
};

/** 公式ジャンルのうち、分類だけでは決まらないもの */
const CATALOG_NAME_KIND: Record<string, TagKind> = {
  // 形式（作品の作り・媒体）
  ...Object.fromEntries(
    [
      '3D作品', 'TRPG', 'TRPGシナリオ', 'TRPGリプレイ集', 'TRPGルールブック', 'RPGBakin', 'ツクール', 'ドット', 'ドット制作', 'アニメ', '技術書', '評論',
      '少年コミック', '少女コミック', '女性コミック', '青年コミック', 'イラスト・CG集', '音声付き', '動画・アニメーション', 'ノベル', '3DCG',
      '単話', 'フルカラー', '実写', 'マンガ誌', '写真集', '複数話', '月刊誌'
    ].map((n) => [n, 'format' as TagKind])
  ),
  // 対象・区分
  ...Object.fromEntries(
    ['アンソロジー', 'シリーズもの', '総集編', 'ベスト・総集編', '健全', '作家複数', '全年齢向け', '女性向け', '専売', '公式', 'デモ・体験版あり'].map((n) => [
      n,
      'audience' as TagKind
    ])
  ),
  無料作品: 'promo',
  // DMM 同人の「その他」のうち、作品の属性（中身・見せ方）
  ...Object.fromEntries(
    ['男無', '女主人公のみ', '擬人化', '逆転無し', '残虐表現', '女性視点', '断面図あり', 'ASMR', 'バイノーラル', 'フォーリーサウンド', 'KU100',
      '東方Project', '主観視点', '定点', 'ローアングル', 'どんでん返し'].map((n) => [n, 'attribute' as TagKind])
  )
};

const nfkc = (text: string): string => text.normalize('NFKC').trim();

/** 公式ジャンルの名前（NFKC） → 載っている分類 */
const CATALOG = new Map<string, string[]>();
for (const site of Object.values(GENRE_CATALOG)) {
  for (const [category, names] of Object.entries(site)) {
    for (const name of names) CATALOG.set(nfkc(name), [...(CATALOG.get(nfkc(name)) ?? []), category]);
  }
}
const CATALOG_NAME_KIND_NFKC = new Map(Object.entries(CATALOG_NAME_KIND).map(([name, kind]) => [nfkc(name), kind]));
/** DLsite が言い換えたジャンル（元の名前・言い換えた名前とも、作品の属性） */
const DLSITE_LEGACY = new Set(DLSITE_RENAMED_GENRES.flatMap(([, api, display]) => [nfkc(api), nfkc(display)]));

/** 公式ジャンルの一覧での種類。一覧に無ければ null */
export function catalogKind(tag: string): TagKind | null {
  const name = nfkc(tag);
  const named = CATALOG_NAME_KIND_NFKC.get(name);
  if (named) return named;
  if (DLSITE_LEGACY.has(name)) return 'attribute';
  const categories = CATALOG.get(name);
  if (!categories) return null;
  const kinds = categories.map((c) => CATALOG_CATEGORY_KIND[c] ?? 'mixed');
  // 同じ名前が属性の分類にもあれば属性（「その他」にもある ASMR など）
  if (kinds.includes('attribute')) return 'attribute';
  const fixed = kinds.find((k): k is TagKind => k !== 'mixed');
  if (fixed) return fixed;
  const byShape = classifyByShape(name);
  return byShape === 'attribute' ? 'audience' : byShape;
}

/**
 * タグの種類。利用者の上書き（含める・外す）は見ない。
 * 1. 公式ジャンルの一覧にあれば、その分類で決める（評価・販促の語は分類にかかわらず外す）
 * 2. 無ければ、語の形で決める
 * @param blurbs 店舗ページの自由記述の欄（DMM の PC ゲームの「ゲームジャンル」）で見た語。形が何であれ宣伝文句とみなす
 */
export function classifyTag(tag: string, blurbs?: ReadonlySet<string>): TagKind {
  const name = nfkc(tag);
  const official = catalogKind(name);
  if (official) {
    if (official === 'attribute' && REVIEW.test(name)) return 'review';
    if (official === 'attribute' && PROMO.test(name)) return 'promo';
    return official;
  }
  if (blurbs?.has(tag) || blurbs?.has(name)) return 'blurb';
  return classifyByShape(name);
}

/**
 * 公式ジャンルの一覧がそろっているフロア。ここでは一覧に載っている語（と、言い換え前の名前・DMM の以前の伏せ字・辞典の語）だけを
 * 属性として数える。新しい販促や宣伝文句は、語の形にかかわらず外れる。
 * DMM の電子書籍は一覧が一部（おすすめ）しか取れないので含めない。動画は一覧が取れないが、検索語（女優名など）が混ざるので含める
 */
export function isStrictFloor(siteId: string, floorId: string | null | undefined): boolean {
  if (siteId === 'dlsite') return true;
  return siteId === 'dmm' && (floorId === 'doujin' || floorId === 'dlsoft' || floorId === 'video');
}

/** 数えると決めた語（PROMOTED_TAGS はこのあとに書くので、初めて使うときに作る） */
let promoted: Set<string> | null = null;
const isPromoted = (tag: string): boolean => (promoted ??= new Set(PROMOTED_TAGS.map(nfkc))).has(nfkc(tag));

/** 公式ジャンル（言い換え前の名前・伏せ字の以前の名前・辞典の語・数えると決めた語を含む）か */
export function isListedGenre(tag: string, dictionary: TagDictionary = DEFAULT_TAG_DICTIONARY): boolean {
  return catalogKind(tag) !== null || isPromoted(tag) || tag.includes('●') || dictionary.alias.has(tagFoldKey(tag));
}

/** 作品のフロアを考えたタグの種類。一覧のそろったフロアで一覧に無い属性は 'unlisted' */
export function classifyTagIn(
  tag: string,
  row: { siteId: string; floorId?: string | null },
  dictionary: TagDictionary = DEFAULT_TAG_DICTIONARY,
  blurbs?: ReadonlySet<string>
): TagKind {
  const kind = classifyTag(tag, blurbs);
  if (kind === 'attribute' && isStrictFloor(row.siteId, row.floorId) && !isListedGenre(tag, dictionary)) return 'unlisted';
  return kind;
}

/** 語の形での判定（公式ジャンルの一覧に無い語に使う） */
export function classifyByShape(name: string): TagKind {
  if (AUDIENCE.has(name) || LABEL.test(name)) return 'audience';
  if (PROMO.test(name)) return 'promo';
  if (TECH.test(name)) return 'tech';
  if (REVIEW.test(name)) return 'review';
  if (FORMAT.has(name) || FORMAT_WITH_NOTE.test(name) || FORMAT_PACK.test(name)) return 'format';
  const suffix = FORMAT_SUFFIX.exec(name);
  if (suffix) return suffix[1] ? 'blurb' : 'format';
  if (LONG_GAME_BLURB.test(name)) return 'blurb';
  return 'attribute';
}

/**
 * 名寄せの辞書。代表名 ← 別名。区切りや仮名の違いだけのものは書かなくてよい（自動で寄る）。
 * DMM の伏せ字（●）はここで元の語の側に寄せる。
 */
export const TAG_GROUPS: Record<string, string[]> = {
  // まとめた側に寄せる（DMM は寝取りと寝取られを 1 つのタグにしている）
  '寝取り・寝取られ（NTR）': ['寝取り・寝取られ・NTR', '寝取られ（NTR）', '寝取られ・NTR', '寝取り・NTR', '寝取られ', '寝取り', 'NTR'],
  '先輩・後輩': ['先輩/後輩', '先輩', '後輩'],
  '乱交・複数プレイ': ['複数プレイ/乱交', '乱交', '3P・4P', '3P4P', '3P', '輪●', '輪姦', '回し'],
  // 同じ意味で語が違う
  '巨乳': ['巨乳/爆乳', '爆乳'],
  'フェラ': ['フェラチオ'],
  '学園もの': ['学校/学園'],
  '催眠・洗脳': ['催●・洗脳', '催眠', '洗脳', 'トランス/暗示', '精神支配'],
  'アイドル・芸能人': ['芸能人/アイドル/モデル', 'アイドル', '芸能', 'モデル'],
  '妊娠・孕ませ': ['孕ませ・子作り', '子作り'],
  // DMM の「辱め」は DLsite の「陵辱」にあたる。「羞恥」とは分ける
  '陵辱・辱め': ['辱め', '陵辱', '凌辱', '屈辱'],
  '羞恥': ['羞恥/恥辱'],
  '野外・露出': ['露出', '青姦', '屋外', '野外'],
  '無理矢理': ['強●', '強制/無理矢理', '命令/無理矢理', 'レイプ', '合意なし'],
  '逆レイプ': ['逆レ●プ', '逆レ'],
  // DLsite の言い換え（API の名前 ⇔ 作品ページの名前）は genreCatalog.ts の DLSITE_RENAMED_GENRES と合わせる
  '調教': ['調教・奴●', 'しつけ', '奴隷', '下僕'],
  '痴漢': ['痴●', '秘密さわさわ'],
  '鬼畜': ['超ひどい'],
  '睡眠姦': ['すやすやえっち'],
  '監禁': ['閉じ込め'],
  '獣姦': ['畜えち'],
  'メスガキ': ['ざぁ～こ♡'],
  'ロリ（少女・つるぺた）': ['ロリ', '少女', 'つるぺた'],
  'バイノーラル': ['バイノーラル/ダミヘ', 'KU100'],
  '和服・浴衣': ['着物/和服'],
  'ナース': ['看護婦・ナース', '看護師'],
  'スクール水着': ['競泳・スクール水着'],
  '体操着・ブルマ': ['ブルマ', '体操着'],
  'ケモミミ': ['ネコミミ・獣系', 'ネコミミ・ケモミミ', '獣耳', 'ネコミミ'],
  '性転換・女体化': ['性転換(TS)', '女体化'],
  '男の娘・女装': ['女装・男の娘', '男の娘', '女装'],
  'ふたなり': ['フタナリ'],
  'おもらし・放尿': ['放尿・お漏らし', 'おもらし', '放尿/おしっこ'],
  'ごっくん': ['ごっくん/食ザー'],
  '妊婦': ['ぼて腹/妊婦', '妊婦・ボテ腹'],
  'メガネ': ['めがね', 'メガネっ娘'],
  '近親相姦': ['近親もの'],
  '異種姦': ['異種えっち'],
  '機械姦': ['機械責め'],
  'ギャグ・コメディ': ['ギャグ', 'コメディ'],
  'お嬢様': ['お嬢様・令嬢'],
  '人妻': ['人妻・主婦', '人妻主婦', '主婦'],
  '断面図': ['断面図あり'],
  'おもちゃ・異物': ['道具/異物', 'おもちゃ', '異物挿入'],
  '拘束・緊縛': ['拘束', '縛り・緊縛', '緊縛'],
  '百合・レズ': ['百合', 'レズビアン', '百合・レズビアン', 'レズ/女同士'],
  // 公式ジャンルの一覧の突き合わせで見つけた組（2026-10-08。tools/gen-genre-catalog.mjs）
  'アクション・格闘': ['格闘'],
  '盗撮・のぞき': ['盗撮'],
  '料理・グルメ': ['料理', 'グルメ', '料理/グルメ'],
  '歴史・時代物': ['歴史', '歴史/時代物', '時代モノ', '時代劇'],
  '女王様・お姫様': ['女王様', 'お姫様', '女王様/お姫様'],
  'ゲイ・男同士': ['ゲイ', 'ゲイ/男同士'],
  '体育会系・スポーツ選手': ['体育会系', 'スポーツ選手', '体育会系/スポーツ選手'],
  '幽霊・ゾンビ': ['幽霊', 'ゾンビ'],
  'ロボット・アンドロイド': ['ロボット', 'ロボット/アンドロイド'],
  'デブ・太め': ['デブ', '太め/デブ'],
  'ローション・オイル': ['ローション', 'オイル'],
  '女主人公': ['女主人公のみ'],
  'ボンテージ': ['ボンデージ'],
  '褐色・日焼け': ['褐色肌'],
  'チャイナドレス': ['チャイナ'],
  '従姉妹': ['従姉妹／いとこ'],
  // 公式ジャンルに無い語（主に FANZA 動画の検索語）を、同じ意味の公式ジャンルに寄せる（2026-10-08）
  '中出し': ['なかだし', '中だし', '連続中だし'],
  'キス': ['キス・接吻', 'キス接吻'],
  '手コキ': ['てこき'],
  '淫乱': ['淫乱・ハード系', '淫乱ハード系', 'いんらん'],
  '痴女': ['痴女られ'],
  'ハメ撮り': ['はめどり'],
  '主観視点': ['主観'],
  '潮吹き': ['初潮吹き'],
  '顔射': ['連続顔射'],
  '裏垢女子': ['裏垢'],
  '陰キャ・地味': ['地味'],
  'リフレ': ['マッサージ・リフレ'],
  '巨根': ['デカチン・巨根'],
  '乳首・乳輪': ['乳首'],
  '風俗・ソープ': ['ソープ', 'ソーププレイ', '風俗'],
  'アクメ': ['アクメ・オーガズム'],
  'マニアック・変態': ['変態'],
  // DMM の「ドラッグ」と DLsite の「薬物」は同じ意味
  'ドラッグ・薬物': ['ドラッグ', '薬物', '媚薬', 'キメセク']
};

/**
 * 公式ジャンルに無いが、作品の属性として数える語（主に FANZA 動画の検索語。2026-10-08 に台帳の語から選んだ）。
 * 一覧のそろったフロアでも「公式ジャンルに無い語」として外さない。
 * 同じ意味の公式ジャンルがあるものは、ここではなく TAG_GROUPS でそのジャンルに寄せる
 */
export const PROMOTED_TAGS: string[] = [
  'ノーパン', 'ノーブラ', '女上司', '更衣室', 'トイレ', '公衆トイレ', '小柄', '神乳', '巨尻', '生挿入', '逆流', '懇願', 'オフパコ',
  'ポルチオ開発', 'デート', 'おばさん', 'パンスト・タイツ', '汗だく', '丸見え', '丸出し', '誘惑', '終電'
];

/** 表記ゆれを畳んだ比べるための鍵（NFKC・区切り・カタカナ→ひらがな・小文字） */
export function tagFoldKey(tag: string): string {
  return tag
    .normalize('NFKC')
    .trim()
    .replace(/[・/／、\s]+/g, '/')
    .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .toLowerCase();
}

/** 名寄せの辞典（代表名 → 別名）。既定は TAG_GROUPS。利用者が編集したものは設定に丸ごと持つ */
export type TagGroups = Record<string, string[]>;

export interface TagDictionary {
  groups: TagGroups;
  /** 畳んだ鍵 → 代表名 */
  alias: Map<string, string>;
}

export function buildTagDictionary(groups: TagGroups = TAG_GROUPS): TagDictionary {
  const alias = new Map<string, string>();
  for (const [label, members] of Object.entries(groups)) {
    for (const m of [label, ...members]) {
      const key = tagFoldKey(m);
      // 同じ語が 2 つのグループにあったら先のほうを使う（編集で起きないようにしているが、壊れた設定に備える）
      if (key && !alias.has(key)) alias.set(key, label);
    }
  }
  return { groups, alias };
}

export const DEFAULT_TAG_DICTIONARY = buildTagDictionary(TAG_GROUPS);

/**
 * 名寄せしたタグ。key が同じものは同じタグとして数える。
 * label は辞典の代表名。辞典に無いもの（表記ゆれだけのもの）は null で、数える側が一番多い表記を代表にする。
 */
export function canonicalTag(tag: string, dictionary: TagDictionary = DEFAULT_TAG_DICTIONARY): { key: string; label: string | null } {
  const folded = tagFoldKey(tag);
  const label = dictionary.alias.get(folded) ?? null;
  return { key: label ? `g:${label}` : `t:${folded}`, label };
}

/** 表記ゆれだけのタグを見せるときの形（区切りを「・」にそろえる） */
export function tidyTagLabel(tag: string): string {
  return tag.normalize('NFKC').trim().replace(/\s*[/／]\s*/g, '・');
}

/**
 * 利用者による上書き（設定 `stats.tagRules` に JSON で持つ）。
 * - exclude: 属性でも数えないタグ（名寄せの鍵で持つ）
 * - include: 属性以外に分類されていても数えるタグ（名寄せの鍵で持つ）
 * - groups: 編集した名寄せの辞典。null なら既定の辞典（TAG_GROUPS）
 */
export interface TagRuleOverrides {
  exclude: string[];
  include: string[];
  groups: TagGroups | null;
  /** 名寄せ辞典の「寄せる候補」から外した組（候補の id） */
  dismissed?: string[];
  /**
   * 店舗ページの自由記述の欄（DMM の PC ゲームの「ゲームジャンル」）で見た語。形が何であれ宣伝文句とみなす。
   * 利用者の上書きではないので `stats.tagRules` には保存せず、メインが別の設定（`stats.blurbTags`）から足す
   */
  blurbs?: string[];
}

export const EMPTY_TAG_OVERRIDES: TagRuleOverrides = { exclude: [], include: [], groups: null };

/** 上書きを読み取る（壊れた値・型の違う値は空にする） */
export function parseTagOverrides(json: string | null | undefined): TagRuleOverrides {
  try {
    const value = JSON.parse(json ?? '') as Partial<Record<keyof TagRuleOverrides, unknown>>;
    const strings = (list: unknown): string[] => (Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : []);
    let groups: TagGroups | null = null;
    if (value.groups && typeof value.groups === 'object' && !Array.isArray(value.groups)) {
      groups = {};
      for (const [label, members] of Object.entries(value.groups as Record<string, unknown>)) {
        if (label.trim()) groups[label] = strings(members);
      }
    }
    const dismissed = strings(value.dismissed);
    return { exclude: strings(value.exclude), include: strings(value.include), groups, ...(dismissed.length ? { dismissed } : {}) };
  } catch {
    return { ...EMPTY_TAG_OVERRIDES };
  }
}

/** 上書きが使う辞典 */
export function dictionaryOf(overrides: TagRuleOverrides): TagDictionary {
  return overrides.groups ? buildTagDictionary(overrides.groups) : DEFAULT_TAG_DICTIONARY;
}

/** 統計で数えるタグか（分類と利用者の上書きを合わせる） */
export function countsAsAttribute(tag: string, overrides: TagRuleOverrides = EMPTY_TAG_OVERRIDES): boolean {
  const { key } = canonicalTag(tag, dictionaryOf(overrides));
  if (overrides.exclude.includes(key)) return false;
  if (overrides.include.includes(key)) return true;
  return classifyTag(tag, new Set(overrides.blurbs ?? [])) === 'attribute';
}

/** 名寄せの辞典の編集。1 回の操作ごとに送る */
export type DictionaryEdit =
  | { type: 'addGroup'; label: string }
  | { type: 'renameGroup'; from: string; to: string }
  | { type: 'deleteGroup'; label: string }
  | { type: 'addMember'; label: string; tag: string }
  | { type: 'removeMember'; label: string; tag: string };

/** 編集できなかった理由（画面にそのまま出す） */
export class DictionaryEditError extends Error {}

/**
 * 辞典に編集を 1 つ当てた新しい辞典を返す（元は変えない）。
 * - 1 つの語（畳んだ鍵）は 1 つのグループにしか入らない。別のグループの語を足すと、そちらから移す
 * - 代表名を変えたら、元の代表名は別名として残す（元の名前のタグも同じグループに寄ったままにする）
 */
export function applyDictionaryEdit(groups: TagGroups, edit: DictionaryEdit): TagGroups {
  const next: TagGroups = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, [...v]]));
  // 書いたとおりに残す（全角の括弧などを変えない）。前後と続いた空白だけ整える
  const clean = (text: string): string => text.trim().replace(/\s+/g, ' ');
  const labelOfKey = (key: string): string | undefined => Object.keys(next).find((l) => tagFoldKey(l) === key);
  const removeEverywhere = (key: string): void => {
    for (const label of Object.keys(next)) next[label] = next[label].filter((m) => tagFoldKey(m) !== key);
  };
  const need = (label: string): void => {
    if (!(label in next)) throw new DictionaryEditError(t('グループが見つかりません: {0}', { 0: label }));
  };

  switch (edit.type) {
    case 'addGroup': {
      const label = clean(edit.label);
      if (!label) throw new DictionaryEditError(t('グループの名前を入れてください。'));
      if (labelOfKey(tagFoldKey(label))) throw new DictionaryEditError(t('同じ名前のグループがあります: {0}', { 0: label }));
      removeEverywhere(tagFoldKey(label));
      next[label] = [];
      return next;
    }
    case 'renameGroup': {
      need(edit.from);
      const to = clean(edit.to);
      if (!to) throw new DictionaryEditError(t('グループの名前を入れてください。'));
      const clash = labelOfKey(tagFoldKey(to));
      if (clash && clash !== edit.from) throw new DictionaryEditError(t('同じ名前のグループがあります: {0}', { 0: to }));
      removeEverywhere(tagFoldKey(to));
      const members = next[edit.from].filter((m) => tagFoldKey(m) !== tagFoldKey(to));
      if (tagFoldKey(edit.from) !== tagFoldKey(to)) members.unshift(edit.from);
      // 並びを保ったまま名前だけ変える
      return Object.fromEntries(Object.entries(next).map(([k, v]) => (k === edit.from ? [to, members] : [k, v])));
    }
    case 'deleteGroup': {
      need(edit.label);
      delete next[edit.label];
      return next;
    }
    case 'addMember': {
      need(edit.label);
      const tag = clean(edit.tag);
      if (!tag) throw new DictionaryEditError(t('寄せるタグを入れてください。'));
      const key = tagFoldKey(tag);
      const owner = labelOfKey(key);
      if (owner === edit.label) return next; // 代表名そのもの
      if (owner) throw new DictionaryEditError(t('「{0}」は別のグループの名前です。先にそのグループを消すか、名前を変えてください。', { 0: tag }));
      removeEverywhere(key);
      next[edit.label].push(tag);
      return next;
    }
    case 'removeMember': {
      need(edit.label);
      const key = tagFoldKey(edit.tag);
      next[edit.label] = next[edit.label].filter((m) => tagFoldKey(m) !== key);
      return next;
    }
  }
}
