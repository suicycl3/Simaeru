/**
 * 総集編・詰め合わせの「収録作品」を、説明文から読み取って購入済みの作品と照らし合わせる規則。
 * メインで使い、テストもこれに対して書く。
 */

/** 総集編らしいタグ・タイトル */
const COMPILATION_TAG = /総集編|セット商品/;
const COMPILATION_TITLE = /総集編|詰め合わせ|詰合せ|作品集|全集|まとめセット|おまとめ|[0-9０-９]+\s*(?:作品|本)(?:セット|パック|収録|詰め)|セット[0-9０-９]+作品|パック|BOX|コレクション|合本|アーカイブス/i;

/** 収録作品の見出し（この行より後ろを一覧として読む） */
const HEADER = /^[\s■□◆◇●○★☆▼▽【［\[<＜《『「=＝\-－―]*(?:収録作品|収録タイトル|収録作|収録内容|作品一覧|セット内容|同梱作品|パック内容)(?:一覧|リスト|について)?[\s■□◆◇●○★☆▼▽】］\]>＞》』」:：=＝\-－―]*$/i;
/** 番号つきの行: `01:タイトル` `1.タイトル` `No.3 タイトル` `(4) タイトル` `第5弾：タイトル` */
const NUMBERED = /^\s*(?:No\.?\s*|第\s*)?[(（]?\s*[0-9０-９]{1,3}\s*[)）]?\s*(?:弾|作目|本目)?\s*[:：.．、,)）\-－]\s*(.+)$/i;
/** 記号の箇条書き */
const BULLET = /^\s*[・●○◆◇■□▼▽★☆*＊]\s*(.+)$/;
/** 『タイトル』「タイトル」だけの行 */
const QUOTED = /^[『「][^『「』」]+[』」]$/;
/** 一覧の終わり（注意書き・次の見出し） */
const STOP = /^\s*(?:※|■|【|［|＜|<|注意)/;
/** タイトルではない行（枚数・形式・スタッフなどの説明） */
const NOT_TITLE = /(?:[0-9０-９]+\s*(?:枚|ページ|P|p|点|本|分|秒)(?:$|[^a-zA-Z])|ファイル|形式|解像度|容量|価格|円|作品収録|お得|ご参照|販売ページ|作家|作者|監修|イラスト\s*[:：]|シナリオ\s*[:：]|CV|声優|twitter|@|^(?:収録|CG|画像|差分)?枚数|データ内容|のり修正|モザイク|同梱$|バージョン$|こちら|追加コンテンツ|^【[^】]*】$|ノリ|修正|サイズ|px|制作|JPEG|PNG|PDF版)/i;

export interface CompilationSource {
  title: string;
  tags: string[];
  description: string | null;
  /** 'set' はストアの購入履歴でセット商品と分かっているもの */
  productType?: string | null;
}

export interface CompilationEntry {
  title: string;
  /** 番号・箇条書きの行か。付いていない行は、購入済みの作品と照らし合わせられたときだけ収録作品とみなす */
  listed: boolean;
}

/** タイトルとして使える形に整える（前後の記号・受理番号・発売年を落とす） */
function cleanTitle(raw: string): string {
  return raw
    .replace(/[◆◇■□▼▽]?\s*【ソフ倫.*$/, '')
    // 末尾のページ数・枚数・時間（「（57ページ）」「(120枚)」「（約30分）」）
    .replace(/\s*[（(][^（）()]*[0-9０-９]+\s*(?:ページ|P|p|枚|分|秒|トラック)[^（）()]*[)）]\s*$/, '')
    // 先頭の「【初収録】」「【描き下ろし】」などの印
    .replace(/^\s*【(?:初収録|新規?収録|描き?下ろし|書き下ろし|新作|特典|おまけ)】\s*/, '')
    .replace(/[（(][^（）()]*(?:発売|年)[^（）()]*[)）]\s*$/, '')
    // 全体を囲む括弧（『タイトル』）だけを外す。途中の「副題」の閉じ括弧は残す
    .replace(/^\s*[「『“"]([^「『“"]*(?:[「『][^」』]*[」』][^「『“"]*)*)[」』”"]\s*$/, '$1')
    .replace(/^[\s□■◇◆]+|[\s□■◇◆]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function acceptable(title: string): boolean {
  return titleCore(title).length >= 4 && title.length <= 120 && !NOT_TITLE.test(title);
}

/**
 * 説明文から収録作品のタイトルを読み取る。
 * 1. 「収録作品」などの見出しがあれば、その後ろの行を、注意書きや次の見出しまで読む（番号・箇条書きでない行も候補にする）
 * 2. 見出しが無ければ、番号つきの行が 2 行以上あるときだけ、それを読む
 */
export function parseCompilationEntries(description: string | null): CompilationEntry[] {
  if (!description) return [];
  const lines = description.split(/\r?\n/);
  const headerAt = lines.findIndex((l) => HEADER.test(l.trim()));
  if (headerAt >= 0) {
    const out: CompilationEntry[] = [];
    for (const line of lines.slice(headerAt + 1)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const item = NUMBERED.exec(trimmed)?.[1] ?? BULLET.exec(trimmed)?.[1];
      if (!item && STOP.test(trimmed)) break;
      const title = cleanTitle(item ?? trimmed);
      // 『』「」で囲んだ行や、ソフ倫の受理番号が付いた行は、印が無くてもタイトルとみなす
      if (acceptable(title)) out.push({ title, listed: !!item || QUOTED.test(trimmed) || /【ソフ倫/.test(trimmed) });
    }
    if (out.length >= 2) return out;
  }
  const numbered = lines
    .map((l) => NUMBERED.exec(l.trim())?.[1])
    .filter((v): v is string => !!v)
    .map(cleanTitle)
    .filter(acceptable)
    .map((title) => ({ title, listed: true }));
  return numbered.length >= 2 ? numbered : [];
}

/** 総集編・セットらしい手がかりがあるか（タグ「総集編」「セット商品」、セット商品、タイトルの言葉） */
export function hasCompilationSignal(p: CompilationSource): boolean {
  return p.productType === 'set' || p.tags.some((tag) => COMPILATION_TAG.test(tag)) || COMPILATION_TITLE.test(p.title);
}

/** 総集編として収録作品を探す対象か（手がかりがあり、収録作品らしい行が 2 つ以上ある） */
export function isCompilationLike(p: CompilationSource): boolean {
  return hasCompilationSignal(p) && parseCompilationEntries(p.description).length >= 2;
}

/** 比べるための形: NFKC・小文字・文字と数字だけ（伏せ字の ● ○ ◯ 〇 * も落ちる） */
export function titleCore(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/[^\p{Letter}\p{Number}]/gu, '');
}

/** 照らし合わせる相手。key は作品 ID など、呼び出し側で決めた印 */
export interface PoolItem {
  key: string;
  title: string;
  /** 総集編と同じサークル・ブランドの作品か（サークルの作品一覧から取ったものは true） */
  sameMaker: boolean;
}

export interface CompilationMatch {
  position: number;
  title: string;
  /** 近い順。同じ作品の版違い（通常版・廉価版など）が並ぶことがある */
  matches: Array<{ key: string; score: number }>;
}

/** 同じサークルの作品を候補にする近さ */
export const SAME_MAKER_MIN = 0.72;
/** 別のサークルの作品は、ほぼ同じタイトルのときだけ */
export const OTHER_MAKER_MIN = 0.92;

/**
 * タイトルの近さ。どちらかがもう一方を含むとき（説明文のタイトルが省略されている・版の表記が付いている）は高めに見る。
 */
export function entrySimilarity(entryCore: string, titleCoreValue: string): number {
  if (!entryCore || !titleCoreValue) return 0;
  if (entryCore === titleCoreValue) return 1;
  const shorter = entryCore.length < titleCoreValue.length ? entryCore : titleCoreValue;
  const longer = shorter === entryCore ? titleCoreValue : entryCore;
  if (shorter.length >= 6 && longer.includes(shorter)) return 0.7 + 0.3 * (shorter.length / longer.length);
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const a = grams(entryCore);
  const b = grams(titleCoreValue);
  let hit = 0;
  for (const [g, n] of a) hit += Math.min(n, b.get(g) ?? 0);
  return (2 * hit) / Math.max(1, entryCore.length - 1 + titleCoreValue.length - 1);
}

/** 1 つの収録作品に並べる近いものの数 */
export const MAX_MATCHES = 3;

/**
 * 読み取ったタイトルを、作品の一覧と照らし合わせる。
 * - 同じサークル（sameMaker）の作品は SAME_MAKER_MIN 以上、ほかは OTHER_MAKER_MIN 以上
 * - いちばん近いものから 0.05 以内のものを、MAX_MATCHES まで並べる（通常版と廉価版など）
 * - 番号も記号も無い行（あらすじの文かもしれない）は、照らし合わせられたものだけ残す
 */
export function matchCompilationEntries(entries: CompilationEntry[], pool: PoolItem[]): CompilationMatch[] {
  const prepared = pool.map((p) => ({ key: p.key, core: titleCore(p.title), sameMaker: p.sameMaker }));
  const results = entries.map(({ title, listed }) => {
    const core = titleCore(title);
    const scored: Array<{ key: string; score: number }> = [];
    for (const p of prepared) {
      // 別のサークルは、含む・含まれるか完全一致だけを見る（全作品と細かく比べると重い）
      if (!p.sameMaker && !(p.core === core || (core.length >= 6 && (p.core.includes(core) || core.includes(p.core))))) continue;
      const score = entrySimilarity(core, p.core);
      if (score >= (p.sameMaker ? SAME_MAKER_MIN : OTHER_MAKER_MIN)) scored.push({ key: p.key, score: Math.round(score * 100) / 100 });
    }
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0]?.score ?? 0;
    return { title, listed, matches: scored.filter((x) => x.score >= best - 0.05).slice(0, MAX_MATCHES) };
  });
  return results
    .filter((r) => r.listed || r.matches.length > 0)
    .map((r, i) => ({ position: i + 1, title: r.title, matches: r.matches }));
}
