/**
 * 作品の中身をどう見せるかの規則。メインでもレンダラでも使い、テストもこれに対して書く。
 * （DESIGN-download.md §6-5 / §8）
 */

export const AUDIO_EXTS = ['.wav', '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma'];
export const DOC_EXTS = ['.pdf', '.txt', '.rtf', '.html', '.htm', '.md'];
export const SUBTITLE_EXTS = ['.lrc', '.vtt', '.srt', '.ass', '.ssa'];
export const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'];
export const VIDEO_EXTS = ['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.wmv', '.avi', '.mpg', '.mpeg'];
export const BOOK_EXTS = ['.epub', '.mobi', '.azw3', '.fb2', '.cbz'];

/** Chromium の <audio>/<video> で再生できるもの。それ以外は既定のアプリへ回す */
export const PLAYABLE_AUDIO = ['.wav', '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus'];
export const PLAYABLE_VIDEO = ['.mp4', '.webm', '.m4v', '.mov'];

export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}

export function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

export function dirName(rel: string): string {
  const parts = rel.split('/');
  parts.pop();
  return parts.join('/');
}

/** 台本・読み物が入っていそうなフォルダ名 */
const SCRIPT_FOLDER = /台本|script|シナリオ|scenario|テキスト|text|セリフ|原稿/i;

export type EntryClass = 'audio' | 'document' | 'subtitle' | 'image' | 'scriptImage' | 'video' | 'book' | 'other';

export function classifyEntry(relPath: string): EntryClass {
  const ext = extOf(relPath);
  if (AUDIO_EXTS.includes(ext)) return 'audio';
  if (SUBTITLE_EXTS.includes(ext)) return 'subtitle';
  if (DOC_EXTS.includes(ext)) return 'document';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  if (BOOK_EXTS.includes(ext)) return 'book';
  if (IMAGE_EXTS.includes(ext)) return SCRIPT_FOLDER.test(dirName(relPath)) ? 'scriptImage' : 'image';
  return 'other';
}

// ── 版のラベル（SEあり/なし・特典など） ───────────────────────

const VERSION_RULES: Array<[RegExp, string]> = [
  // 「なし」を先に見る（「SEなし」に「SE」も含まれるため）
  [/(?:SE|効果音)\s*[(（\[【]?\s*(?:なし|無し|無|off|ナシ)|no\s*SE|without\s*SE/i, 'SEなし'],
  [/(?:SE|効果音)\s*[(（\[【]?\s*(?:あり|有り|有|on|アリ)|with\s*SE/i, 'SEあり'],
  [/BGM\s*[(（\[【]?\s*(?:なし|無し|無|off)|no\s*BGM/i, 'BGMなし'],
  [/BGM\s*[(（\[【]?\s*(?:あり|有り|有|on)|with\s*BGM/i, 'BGMあり'],
  [/特典|おまけ|オマケ|bonus|omake|extra|購入者限定/i, '特典'],
  [/ハイレゾ|hi-?res|96\s*k(?:hz)?|192\s*k(?:hz)?|24\s*bit/i, 'ハイレゾ'],
  [/(?:^|[^a-z])mp3(?:$|[^a-z])/i, 'MP3'],
  [/(?:^|[^a-z])wav(?:$|[^a-z])/i, 'WAV'],
  [/(?:^|[^a-z])flac(?:$|[^a-z])/i, 'FLAC'],
  [/(?:^|[^a-z])(?:m4a|aac)(?:$|[^a-z])/i, 'AAC'],
  [/バイノーラル|binaural|ダミーヘッド/i, 'バイノーラル']
];

/** フォルダのパス（全階層）から版のラベルを推定する */
export function versionTags(folder: string): string[] {
  const tags: string[] = [];
  for (const [re, label] of VERSION_RULES) {
    if (re.test(folder) && !tags.includes(label)) tags.push(label);
  }
  // 「SEあり」と「SEなし」が両方付くのは、親に「SEあり」子に「SEなし」のような並びのとき。
  // 近い階層（末尾）の方を優先する
  if (tags.includes('SEあり') && tags.includes('SEなし')) {
    const leaf = folder.split('/').pop() ?? '';
    const drop = VERSION_RULES[0][0].test(leaf) ? 'SEあり' : 'SEなし';
    tags.splice(tags.indexOf(drop), 1);
  }
  return tags;
}

/**
 * 同じトラックの別版を束ねるためのキー。
 * `01_おはよう.wav` と `SEなし/01_おはよう（SEなし）.mp3` が同じキーになるようにする。
 */
export function trackKey(fileName: string): string {
  let s = baseName(fileName).normalize('NFKC').toLowerCase();
  s = s.replace(/\.[a-z0-9]{2,5}$/, '');
  // 版を表す語はキーから外す
  s = s.replace(/[(（\[【]?\s*(?:se|効果音|bgm)\s*(?:あり|なし|有り|無し|有|無|on|off)\s*[)）\]】]?/g, '');
  s = s.replace(/[(（\[【]?\s*(?:no|with|without)\s*(?:se|bgm)\s*[)）\]】]?/g, '');
  s = s.replace(/[(（\[【]\s*(?:mp3|wav|flac|ハイレゾ|hi-?res)\s*[)）\]】]/g, '');
  s = s.replace(/[\s_\-.・、,。~〜!！?？'"「」『』()（）[\]【】]+/g, '');
  return s;
}

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

/** 01, 2, 10 の順に並べる */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b);
}

// ── ゲームの型（§8） ──────────────────────────────────────

const INSTALLER_NAME = /(?:^|[^a-z])(?:setup|install|installer)(?:[^a-z]|$)|インストール|セットアップ/i;
const NOT_MAIN_EXE =
  /setup|install|uninst|unins\d*|vcredist|vc_redist|dxsetup|dxwebsetup|directx|dotnet|netfx|crash|report|config|設定|update|patch|launcher_setup|UnityCrashHandler|notification_helper|ffmpeg|7z|unzip/i;
const GAME_DATA_EXT = [
  '.dat', '.arc', '.xp3', '.pak', '.pck', '.wolf', '.rgssad', '.rgss2a', '.rgss3a', '.pfs', '.mrg',
  '.ypf', '.int', '.npa', '.cpk', '.assets', '.bundle', '.nwa', '.ogv', '.fpk', '.dlc'
];
/** 本体ではなく、導入済みの本体に当てるもの（追加ディスク・パッチ） */
const PATCHER_NAME = /update|patch|アップデート|パッチ|dlc|追加/i;
const GAME_DATA_DIR = /^(?:data|www|resources|.*_data|game|assets|pack|archive)$/i;
const README = /readme|read_me|お読み|はじめに|説明書|manual|マニュアル/i;
const RUNTIME = /vcredist|vc_redist|dxsetup|directx|dotnet|netfx|redist|runtime/i;

export interface FileFact {
  /** 解析するフォルダからの相対パス（'/' 区切り） */
  rel: string;
  size: number;
  isDir: boolean;
}

export interface InstallJudgement {
  type: 'installer' | 'installer_with_files' | 'portable' | 'patch' | 'unknown';
  reasons: string[];
  installers: FileFact[];
  executables: Array<FileFact & { depth: number }>;
  htmlEntries: string[];
  readmes: string[];
}

/**
 * 展開したフォルダの中身から、要インストール(A) / setupと実体が並ぶ(B) / そのまま動く(C) を推定する。
 * **決めるのはユーザー**。ここで出すのは初期値と、その理由。
 */
export function judgeInstall(facts: FileFact[]): InstallJudgement {
  const files = facts.filter((f) => !f.isDir);
  const depthOf = (rel: string): number => rel.split('/').length - 1;
  const exes = files.filter((f) => ['.exe', '.msi'].includes(extOf(f.rel)));
  const installers = exes.filter((f) => extOf(f.rel) === '.msi' || INSTALLER_NAME.test(baseName(f.rel)));
  const candidates = exes
    .filter((f) => extOf(f.rel) === '.exe' && !NOT_MAIN_EXE.test(baseName(f.rel)) && !RUNTIME.test(f.rel))
    .map((f) => ({ ...f, depth: depthOf(f.rel) }))
    // 浅い階層を先に、同じ深さなら大きいものを先に（§8-2）
    .sort((a, b) => a.depth - b.depth || b.size - a.size);
  const dataFiles = files.filter((f) => GAME_DATA_EXT.includes(extOf(f.rel)));
  const dataDirs = facts.filter((f) => f.isDir && GAME_DATA_DIR.test(baseName(f.rel)));
  const htmlEntries = files
    .filter((f) => /^index\.html?$/i.test(baseName(f.rel)))
    .map((f) => f.rel)
    .sort((a, b) => depthOf(a) - depthOf(b));
  const readmes = files
    .filter((f) => README.test(baseName(f.rel)) && ['.txt', '.pdf', '.html', '.htm', '.md', ''].includes(extOf(f.rel)))
    .map((f) => f.rel);

  const reasons: string[] = [];
  const hasData = dataFiles.length > 0 || dataDirs.length > 0;
  let type: InstallJudgement['type'];
  if (installers.length > 0 && candidates.length === 0 && !hasData) {
    type = 'installer';
    reasons.push(`インストーラ（${installers.map((i) => baseName(i.rel)).join('、')}）だけがあり、本体やデータが見えません`);
  } else if (installers.length > 0) {
    type = 'installer_with_files';
    reasons.push(`インストーラ（${installers.map((i) => baseName(i.rel)).join('、')}）があります`);
    if (candidates.length > 0) reasons.push(`本体らしい実行ファイル（${baseName(candidates[0].rel)}）も並んでいます`);
    if (hasData) reasons.push('ゲームのデータファイルも見えるため、コピーするだけのインストーラかもしれません');
  } else if (candidates.length === 0 && exes.some((f) => PATCHER_NAME.test(baseName(f.rel)))) {
    // 追加ストーリーなど: Update.exe と .fpk だけ。本体の導入先に当てて使う
    const patchers = exes.filter((f) => PATCHER_NAME.test(baseName(f.rel)));
    type = 'patch';
    reasons.push(`本体は入っておらず、アップデータ（${patchers.map((p) => baseName(p.rel)).join('、')}）${hasData ? 'と追加データ' : ''}があります`);
    reasons.push('導入済みの本体に当てる追加ディスク・パッチのようです。お読みくださいの手順に従ってください');
    installers.push(...patchers.filter((p) => !installers.includes(p)));
  } else if (candidates.length > 0 || htmlEntries.length > 0) {
    type = 'portable';
    if (candidates.length > 0) reasons.push(`インストーラが無く、実行ファイル（${baseName(candidates[0].rel)}）がそのまま置かれています`);
    else reasons.push(`実行ファイルは無く、ブラウザで開く入口（${baseName(htmlEntries[0])}）があります`);
  } else {
    type = 'unknown';
    reasons.push('実行ファイルが見つかりませんでした');
  }
  return { type, reasons, installers, executables: candidates, htmlEntries, readmes };
}

/** タイトルの近さ（導入済みプログラムの候補を並べるため）。0..1 */
export function titleSimilarity(a: string, b: string): number {
  const norm = (s: string): string =>
    s
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s　_\-・:：!！?？~〜「」『』()（）[\]【】]+/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return Math.min(x.length, y.length) / Math.max(x.length, y.length) * 0.5 + 0.5;
  // 2文字の組の一致率（Dice 係数）
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let hit = 0;
  for (const [g, n] of gx) hit += Math.min(n, gy.get(g) ?? 0);
  const total = Math.max(1, x.length - 1 + y.length - 1);
  return (2 * hit) / total;
}

// ── MP3 などがある作品で、WAV / FLAC を消して軽くする ─────────────

export const LOSSLESS_EXTS = ['.wav', '.flac', '.aif', '.aiff'];
export const LOSSY_EXTS = ['.mp3', '.m4a', '.aac', '.ogg', '.opus'];
/** 版の見分けに使わない形式のラベル（WAV 版と MP3 版は「同じ版の別形式」） */
const FORMAT_TAGS = ['MP3', 'WAV', 'FLAC', 'AAC', 'ハイレゾ'];

export interface LossyOnlyPlan {
  /** 消す WAV / FLAC（同じ版・同じトラックの MP3 などがあるもの） */
  remove: Array<{ path: string; size: number }>;
  removeBytes: number;
  /** MP3 などが見つからないので残す WAV / FLAC */
  kept: string[];
  lossyCount: number;
}

/**
 * WAV / FLAC のうち、**同じ版（SEあり/なし・特典…）で同じトラックの MP3 など**があるものを選ぶ。
 * 例: `01_WAV/トラック01.wav` ↔ `02_MP3 (320kbps)/トラック01.mp3`、
 *     `03_SEなし/WAV/トラックEX.wav` ↔ `03_SEなし/MP3/トラックEX.mp3`（SEありの MP3 とは組にしない）。
 * 組が見つからないものは消さない。
 */
export function planLossyOnly(files: Array<{ path: string; size: number }>): LossyOnlyPlan {
  const keyOf = (p: string): string => {
    const rel = p.split('\\').join('/');
    const withoutExt = rel.replace(/\.[^./]+$/, '');
    const tags = versionTags(withoutExt)
      .filter((t) => !FORMAT_TAGS.includes(t))
      .sort()
      .join('+');
    return `${tags}|${trackKey(rel)}`;
  };
  const lossy = files.filter((f) => LOSSY_EXTS.includes(extOf(f.path)));
  const lossyKeys = new Set(lossy.map((f) => keyOf(f.path)));
  const remove: LossyOnlyPlan['remove'] = [];
  const kept: string[] = [];
  for (const f of files) {
    if (!LOSSLESS_EXTS.includes(extOf(f.path))) continue;
    if (lossyKeys.has(keyOf(f.path))) remove.push(f);
    else kept.push(f.path);
  }
  return { remove, removeBytes: remove.reduce((s, f) => s + f.size, 0), kept, lossyCount: lossy.length };
}

// ── CG 集などで、画像と同じ内容の PDF（スマホ向けなど）を消して軽くする ─────────────

export interface PdfStripPlan {
  /** 消す PDF */
  remove: Array<{ path: string; size: number }>;
  removeBytes: number;
  /** 残す PDF（おまけ・説明書など、画像と別の内容らしいもの） */
  kept: string[];
  imageCount: number;
}

/** 画像と同じ内容を PDF にまとめたものらしい名前（フォルダ名を含む） */
const PDF_COPY_NAME = /(スマホ|スマートフォン|smart\s*phone|mobile|モバイル|携帯|タブレット|tablet|pdf\s*版|pdf\s*ver|閲覧用)/i;
/** 画像とは別の内容らしい名前。名前でスマホ向けとわかるもの以外は消さない */
const PDF_EXTRA_NAME = /(おまけ|オマケ|特典|設定資料|資料集|あとがき|後書き|readme|read_me|説明|注意|manual|マニュアル|台本|シナリオ|script|クレジット|credit)/i;
/** 画像がこれより少ない作品は、PDF が本体かもしれないので触らない */
const MIN_IMAGES = 10;

/** 名前の比べ方: 番号・記号・空白・括弧を落として小文字に */
function nameCore(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^[\d\s._\-]+/, '')
    .replace(/[\s._\-『』「」【】（）()\[\]]/g, '');
}

/**
 * 画像と、同じ内容の PDF（スマホで読む用など）が両方入っている作品で、消してよい PDF を選ぶ。
 * - 画像が 10 枚以上あり、音声・動画が入っていない（ボイス作品の台本 PDF を巻き込まない）
 * - 名前（フォルダ名を含む）に「スマホ」「PDF版」などがある PDF は消す
 * - それ以外は、おまけ・説明書らしい名前でないもののうち、次のどちらかに当たる PDF を消す
 *   - 名前が画像のフォルダ名と重なる（例: `本編.pdf` と `01_本編/`・`02_本編(文字なしver)/`）
 *   - いちばん大きい画像フォルダの 1 割以上の大きさがある（画像を丸ごと PDF にしたもの。
 *     文字あり・なしの 2 版を画像で持ち、PDF は 1 版ぶんということがあるので、画像の合計ではなくフォルダごとに比べる。
 *     実例では画像 508 枚 584MB を 2 フォルダに分けて持ち、PDF は 69MB）
 */
export function planPdfStrip(files: Array<{ path: string; size: number }>): PdfStripPlan {
  const norm = (p: string): string => p.split('\\').join('/');
  const images = files.filter((f) => IMAGE_EXTS.includes(extOf(f.path)));
  const pdfs = files.filter((f) => extOf(f.path) === '.pdf');
  const empty: PdfStripPlan = { remove: [], removeBytes: 0, kept: pdfs.map((f) => f.path), imageCount: images.length };
  if (pdfs.length === 0 || images.length < MIN_IMAGES) return empty;
  if (files.some((f) => AUDIO_EXTS.includes(extOf(f.path)) || VIDEO_EXTS.includes(extOf(f.path)))) return empty;
  const folderBytes = new Map<string, number>();
  for (const f of images) {
    const dir = dirName(norm(f.path));
    folderBytes.set(dir, (folderBytes.get(dir) ?? 0) + f.size);
  }
  const largestFolder = Math.max(...folderBytes.values());
  const folderNames = [...folderBytes.keys()].flatMap((d) => d.split('/')).map(nameCore).filter((n) => n.length > 0);
  const remove: PdfStripPlan['remove'] = [];
  const kept: string[] = [];
  for (const f of pdfs) {
    const name = norm(f.path).replace(/\.pdf$/i, '');
    const core = nameCore(baseName(name));
    const extra = PDF_EXTRA_NAME.test(name);
    const copyByName = PDF_COPY_NAME.test(name);
    const copyByFolder = !extra && core.length >= 2 && folderNames.some((n) => n.includes(core) || core.includes(n));
    const copyBySize = !extra && f.size >= largestFolder * 0.1;
    if (copyByName || copyByFolder || copyBySize) remove.push(f);
    else kept.push(f.path);
  }
  return { remove, removeBytes: remove.reduce((s, f) => s + f.size, 0), kept, imageCount: images.length };
}
