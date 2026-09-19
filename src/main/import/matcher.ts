import { t } from '@shared/i18n';

/**
 * 手元のファイルと購入済み作品の突き合わせ。
 *
 * 通信もファイルアクセスも持たない純粋関数にしてある（tools/test-import-match.mjs で検証）。
 * 方針は「確実なものだけ自動で決める」。作品IDが1件だけ一致したとき以外は候補を出すだけで、
 * 確定はユーザーに任せる（同名タイトルでも購入元が違えば別物、という当初からの方針）。
 */

/** 突き合わせに使う作品側の最小情報 */
export interface CandidateProduct {
  id: number;
  productId: string;
  contentId: string | null;
  title: string;
  siteId: string;
  category: string;
}

export type MatchConfidence = 'id' | 'high' | 'medium';

/**
 * 作品側をあらかじめ畳んだ索引。
 *
 * ファイル1件ごとに全作品のタイトルを正規化し直すと、作品数×ファイル数だけ NFKC と正規表現が走って
 * 走査が何分もかかる。正規化は作品ごとに1回でよいので、走査の前に1度だけ作ってすべてのフォルダで使い回す。
 */
export interface MatchIndex {
  /** 作品ID・コンテンツID（小文字）→ 作品 */
  byId: Map<string, CandidateProduct[]>;
  /** 正規化したタイトルを持つ作品（タイトル照合はこの並びを見る） */
  titled: Array<{ product: CandidateProduct; key: string; mask: number }>;
  /** 同じ名前の並びを二度照合しないための記憶 */
  cache: Map<string, MatchResult>;
}

/** 走査の前に1度だけ作る。以降のファイルはこれを見る */
export function buildMatchIndex(products: CandidateProduct[]): MatchIndex {
  const byId = new Map<string, CandidateProduct[]>();
  const titled: MatchIndex['titled'] = [];
  const addId = (raw: string | null, product: CandidateProduct): void => {
    const key = raw?.toLowerCase();
    if (!key) return;
    const list = byId.get(key);
    if (list) {
      if (!list.includes(product)) list.push(product);
    } else {
      byId.set(key, [product]);
    }
  };
  for (const product of products) {
    addId(product.productId, product);
    addId(product.contentId, product);
    const key = normalizeTitle(product.title);
    if (key) titled.push({ product, key, mask: charMask(key) });
  }
  return { byId, titled, cache: new Map() };
}

export interface MatchResult {
  /** 自動で確定してよいか（作品IDがちょうど1件一致したときだけ true） */
  decided: boolean;
  candidates: Array<{ product: CandidateProduct; confidence: MatchConfidence; reason: string }>;
}

/**
 * ファイル名・フォルダ名から作品IDを拾う。
 * 前後が英数字でないことを条件にして、他の文字列の一部を誤って拾わないようにする。
 */
const ID_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /(?<![a-z0-9])(d_[0-9]{5,7})(?![a-z0-9])/gi, label: 'DMM同人' },
  { re: /(?<![a-z0-9])([VR]J[0-9]{6,8})(?![a-z0-9])/gi, label: 'DLsite' },
  { re: /(?<![a-z0-9])(BJ[0-9]{6,8})(?![a-z0-9])/gi, label: 'DLsite書籍' },
  { re: /(?<![a-z0-9])(b[a-z0-9]{3}[a-z]+[0-9]{5})(?![a-z0-9])/gi, label: 'DMM電子書籍' },
  { re: /(?<![a-z0-9])([a-z]{2,}_[0-9]{4})(?![a-z0-9])/gi, label: 'DMM PCゲーム' }
];

/** パス（ファイル名＋親フォルダ）から作品IDらしき文字列を全部拾う */
export function extractIds(pathParts: string[]): string[] {
  const found = new Set<string>();
  for (const raw of pathParts) {
    // 全角で書かれた作品ID（ｄ＿１００００３ など）も拾えるよう、幅をそろえてから探す
    const part = raw.normalize('NFKC');
    for (const { re } of ID_PATTERNS) {
      re.lastIndex = 0;
      for (const m of part.matchAll(re)) found.add(m[1]);
    }
  }
  return [...found];
}

/**
 * 売り方の違いを表す語。作品そのものは同じなので、比べる前に落とす。
 * 購入履歴は「ダウンロード版」、手元のフォルダは「DL版」と書かれていることが多い。
 * 末尾とは限らない（「_DL版_インストなし」のように後ろに何か付くこともある）ので、どこにあっても落とす。
 * 「完全版」「体験版」のように中身が変わる語は落とさない（別の作品として扱う）。
 */
const EDITION_WORDS = /ダウンロード版|ダウンロードバン|dl版|dlバン/g;

/**
 * 区切り（空白・_・-）で切ったとき、いちばん後ろの塊が使い捨ての印かどうか。
 *
 * 記号を落としたあとの文字列で「dl」のような短い語を消すと、ふつうの語の一部まで壊す。
 * 区切りの単位で見れば、それが語の一部でないと分かるので安全に落とせる。
 * 比較の単位そのものを単語にはしない（日本語の題名は区切りが無く、1かたまりになるため）。
 * 版数は「ver1.07」「1.02」のように版と分かる形だけ。「V3」は題名の一部のことがあるので残す。
 */
const DISPOSABLE_TAIL =
  /^(?:dl|dl版|ダウンロード|ダウンロード版|インスト(?:ー?ル)?(?:ー)?(?:な|無)し|ver\.?[0-9]+(?:\.[0-9]+)*|v\.?[0-9]+\.[0-9]+|[0-9]+\.[0-9]+(?:\.[0-9]+)*)$/;

/** 末尾の使い捨ての塊を落とす。いくつ並んでいても落とす（「_DL版_インストなし」） */
function trimDisposableTail(text: string): string {
  const parts = text.split(/[ _-]+/).filter(Boolean);
  while (parts.length > 1 && DISPOSABLE_TAIL.test(parts[parts.length - 1])) parts.pop();
  return parts.join(' ');
}

/**
 * 比較用にタイトルを潰す。
 * NFKC → 小文字化 → 括弧とその中身を落とす → 末尾の使い捨ての塊を落とす
 *   → 記号と空白を落とす → ひらがなをカタカナへ → 売り方を表す語を落とす。
 */
export function normalizeTitle(raw: string): string {
  const noBrackets = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[【［\[（(].*?[】］\]）)]/g, ' ')
    // 閉じていない括弧が末尾に残ることがある（使えない文字を消した・名前が切れた）。そこから先は宣伝文句とみなす
    .replace(/[【［\[（(][^】］\]）)]*$/, ' ');
  const kana = trimDisposableTail(noBrackets).replace(/[ぁ-ゖ]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) + 0x60)
  );
  return kana.replace(/[^\p{Letter}\p{Number}]/gu, '').replace(EDITION_WORDS, '');
}

/** 拡張子を落とす。落とさないと "zip" が比較キーに混ざる */
export function stripExtension(name: string): string {
  return name.replace(/\.[a-z0-9]{1,5}$/i, '');
}

/**
 * short の文字が long の中に同じ順で全部出てくるか。
 * 「おてんばお嬢様_レッスン」のように**途中を省いた**名前を拾うための判定。
 * 部分一致（連続）では拾えないが、順序は保たれているので飛ばし読みで一致する。
 */
function isSubsequence(short: string, long: string): boolean {
  let i = 0;
  for (const ch of long) {
    if (ch === short[i]) i++;
    if (i === short.length) return true;
  }
  return i === short.length;
}

/**
 * 文字の種類を32ビットに畳んだ印。
 *
 * 「部分一致」も「飛ばし読み」も、短い側の文字が長い側にすべて含まれていないと成立しない。
 * そこで先にビットで確かめ、成立しえない相手は文字列を見る前に落とす（答えは変わらない。速さだけの話）。
 */
function charMask(s: string): number {
  let mask = 0;
  for (const ch of s) mask |= 1 << (ch.codePointAt(0)! % 31);
  return mask;
}

/**
 * 1ファイルぶんの突き合わせ。
 * @param pathParts ファイル名と親フォルダ名（浅い方から3階層ぶんくらい）
 * @param source 作品の一覧、または作り置きの索引。走査のように何度も呼ぶときは索引を渡す
 */
export function matchFile(pathParts: string[], source: CandidateProduct[] | MatchIndex): MatchResult {
  const index = Array.isArray(source) ? buildMatchIndex(source) : source;

  // 第1段: 作品IDの完全一致
  const ids = extractIds(pathParts).map((v) => v.toLowerCase()).sort();
  // 作品IDで決まったときの答えはIDだけで決まる（決まらなかったときは下のタイトル側で覚える）
  const cacheKey = ids.length > 0 ? `#${ids.join(',')}` : null;
  if (cacheKey) {
    const remembered = index.cache.get(cacheKey);
    if (remembered) return remembered;
  }
  if (ids.length > 0) {
    const hits: CandidateProduct[] = [];
    for (const id of ids) {
      for (const product of index.byId.get(id) ?? []) if (!hits.includes(product)) hits.push(product);
    }
    let result: MatchResult | null;
    if (hits.length === 1) {
      result = {
        decided: true,
        candidates: [{ product: hits[0], confidence: 'id', reason: t('作品ID一致') }]
      };
    } else if (hits.length > 1) {
      result = {
        decided: false,
        candidates: hits.map((product) => ({
          product,
          confidence: 'id' as const,
          reason: t('作品IDが複数の作品に一致')
        }))
      };
    } else {
      result = null;
    }
    if (result) {
      if (cacheKey) index.cache.set(cacheKey, result);
      return result;
    }
    // IDらしき文字列が購入履歴に無い。未購入のこともあるが、data_0001 のような
    // 作品IDでない名前を拾っただけのこともある。ここで打ち切らずタイトルでも探す
  }

  // 第2段: タイトルの正規化一致
  const keys = [...new Set(pathParts.map((part) => normalizeTitle(stripExtension(part))))].filter(
    (k) => k.length >= 4
  );
  if (keys.length === 0) return { decided: false, candidates: [] };
  // 同じフォルダのファイルは名前の並びが似る。一度出した答えは使い回す
  const titleKey = keys.join('|');
  const remembered = index.cache.get(titleKey);
  if (remembered) return remembered;

  const masks = keys.map((k) => charMask(k));
  // 近さ（短い側が長い側のどれだけを占めるか）も持っておき、近い順に並べる
  const scored: Array<MatchResult['candidates'][number] & { score: number }> = [];
  for (const { product, key, mask } of index.titled) {
    if (keys.includes(key)) {
      scored.push({ product, confidence: 'high', reason: t('タイトル一致'), score: 1 });
      continue;
    }
    // どちらの向きにも文字が足りないなら、部分一致も飛ばし読みも成立しない
    if (!masks.some((m) => (m & ~mask) === 0 || (mask & ~m) === 0)) continue;
    let best = 0;
    let reason: string | null = null;
    for (const k of keys) {
      const [short, long] = k.length <= key.length ? [k, key] : [key, k];
      const ratio = short.length / long.length;
      // 短すぎる手がかりは使わない。「anim」「game」のような親フォルダ名が
      // 長い題名に含まれるだけで候補になってしまうため
      if (short.length < 8 && ratio < 0.5) continue;
      if (long.includes(short)) {
        if (ratio > best) { best = ratio; reason = t('タイトルが部分一致'); }
      } else if (short.length >= 6 && ratio >= 0.4 && isSubsequence(short, long)) {
        // 途中を省いたファイル名。候補には出すが確定はしない
        if (ratio > best) { best = ratio; reason = t('タイトルの一部が省かれた形で一致'); }
      }
    }
    if (reason) scored.push({ product, confidence: 'medium', reason, score: best });
  }
  // 高い方を先に、同じ確度なら近い順に。多すぎるときは上位だけ
  scored.sort((a, b) =>
    a.confidence === b.confidence ? b.score - a.score : a.confidence === 'high' ? -1 : 1
  );
  const candidates: MatchResult['candidates'] = scored.map(({ product, confidence, reason }) => ({
    product,
    confidence,
    reason
  }));
  const result: MatchResult = { decided: false, candidates: candidates.slice(0, 8) };
  index.cache.set(titleKey, result);
  return result;
}

/**
 * 作品そのものではなく、ゲームに同梱されている実行環境（ランタイム）のフォルダ。
 * DirectX や VC++ 再頒布可能パッケージはどの作品にも同じ名前で入っているので、
 * 取り込みの候補に出しても選びようがない。走査ごと飛ばす。
 */
const RUNTIME_DIRS = new Set([
  'directx', 'dxredist', 'dxsetup', 'redist', 'redistributable', 'redistributables',
  'commonredist', '_commonredist', 'vcredist', 'vc_redist', 'dotnet', 'dotnetfx',
  'openal', 'runtime', 'ucrt', 'ucrtx86', 'ucrtx64'
]);

/** DirectX9c・vc_redist2019 のように版が付いた名前も同じ扱いにする */
const RUNTIME_DIR_PREFIXES = [/^directx/i, /^dxsetup/i, /^vc_?redist/i, /^_?commonredist/i, /^dotnetfx/i];

/** そのフォルダの中を見ないか（同梱のランタイム） */
export function isRuntimeDir(dirName: string): boolean {
  const name = dirName.trim().toLowerCase();
  return RUNTIME_DIRS.has(name) || RUNTIME_DIR_PREFIXES.some((re) => re.test(name));
}

/** ランタイムのインストーラそのもの。フォルダ分けされずに置かれていることもある */
const RUNTIME_FILES = [
  /^dxwebsetup\.exe$/i,
  /^dxsetup\.exe$/i,
  /^directx[-_.a-z0-9]*\.(?:exe|msi)$/i,
  /^vc_?redist[-_.a-z0-9]*\.(?:exe|msi)$/i,
  /^oalinst\.exe$/i,
  /^dotnetfx[-_.a-z0-9]*\.exe$/i,
  /^ndp[0-9][-_.a-z0-9]*\.exe$/i,
  /^ue[0-9]?prereqsetup[-_.a-z0-9]*\.exe$/i
];

/** 取り込み対象にする拡張子 */
export const SCAN_EXTENSIONS = [
  '.zip', '.7z', '.rar', '.tar', '.lzh',
  '.exe', '.msi',
  '.pdf', '.epub',
  '.mp4', '.mkv', '.wmv', '.avi',
  '.mp3', '.wav', '.flac', '.m4a', '.ogg',
  '.txt'
];

export function isScanTarget(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (RUNTIME_FILES.some((re) => re.test(lower))) return false;
  return SCAN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
