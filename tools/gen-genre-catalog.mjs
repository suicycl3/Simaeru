/**
 * DMM（FANZA）と DLsite の公式ジャンル一覧から、統計で使う「公式ジャンルの一覧」（src/shared/genreCatalog.ts）を作る。
 *   node tools/gen-genre-catalog.mjs                 … 公開ページを読んで作り直す
 *   node tools/gen-genre-catalog.mjs --from <dir>    … 保存済みの HTML（<dir>/dlsite/<フロア>.html・<dir>/dmm/<フロア>.html）から作る
 *
 * 開発者が手で実行するもの。アプリは通信せず、できあがった一覧を同梱して使う。
 * - 読むのはログインの要らない公開ページだけ。ログイン情報・セッションは使わない
 * - DMM の一覧は年齢確認の先にあるので、年齢確認を済ませた印（age_check_done=1）だけを付ける
 * - 1 ページごとに 1 秒あける
 * DMM の動画・アニメのジャンル一覧は、画面を後から組み立てる作りで HTML に無いので含めない。
 * 電子書籍は「おすすめジャンル」の分だけ（全件は後から読み込まれる）。
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const fromArg = process.argv.indexOf('--from');
const fromDir = fromArg > 0 ? path.resolve(process.argv[fromArg + 1]) : null;

const DLSITE_FLOORS = ['home', 'soft', 'app', 'maniax', 'books', 'pro', 'appx', 'girls', 'girls-pro', 'girls-drama', 'bl', 'bl-pro', 'bl-drama'];
const DMM_FLOORS = {
  doujin: 'https://www.dmm.co.jp/dc/doujin/-/genre/',
  dlsoft: 'https://dlsoft.dmm.co.jp/genre/',
  book: 'https://book.dmm.co.jp/genre/'
};

/**
 * DLsite が名前を言い換えたジャンル。作品管理の API（play.dlsite.com の /api/v3/genres）は元の名前を、
 * 作品ページ・ジャンルのページは言い換えた名前を出す。ジャンル ID のページの見出しで突き合わせた（2026-10-08）。
 * 言い換えたジャンルは公式一覧から外れているので、ここに持つ。
 */
const DLSITE_RENAMED = [
  [113, 'レイプ', '合意なし'], [114, '強制/無理矢理', '命令/無理矢理'], [115, '逆レイプ', '逆レ'], [120, '近親相姦', '近親もの'],
  [121, '輪姦', '回し'], [134, '陵辱', '屈辱'], [139, '痴漢', '秘密さわさわ'], [140, '調教', 'しつけ'], [147, '奴隷', '下僕'],
  [151, '監禁', '閉じ込め'], [154, '鬼畜', '超ひどい'], [157, '催眠', 'トランス/暗示'], [163, '獣姦', '畜えち'], [164, '機械姦', '機械責め'],
  [207, 'ロリ', 'つるぺた'], [324, '異種姦', '異種えっち'], [326, '洗脳', '精神支配'], [495, '睡眠姦', 'すやすやえっち'], [525, 'メスガキ', 'ざぁ～こ♡']
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function page(kind, floor, url) {
  if (fromDir) return fs.readFileSync(path.join(fromDir, kind, `${floor}.html`), 'utf8');
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...(kind === 'dmm' ? { Cookie: 'age_check_done=1' } : {}) } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await sleep(1000);
  return res.text();
}
const decode = (s) =>
  s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&#9660;/g, '').replace(/\s+/g, ' ').trim();

/** サイト → 分類 → ジャンル名の一覧（フロアをまたいで同じ分類はまとめる） */
const catalog = { dlsite: {}, dmm: {} };
const add = (site, category, name) => {
  (catalog[site][category] ??= new Set()).add(name);
};

for (const floor of DLSITE_FLOORS) {
  const html = await page('dlsite', floor, `https://www.dlsite.com/${floor}/genre/list`);
  for (const block of html.split('<h2 class="versatility_linklist_title">').slice(1)) {
    const category = decode(block.slice(0, block.indexOf('</h2>')));
    const body = block.slice(0, block.indexOf('</ul>'));
    for (const m of body.matchAll(/works\/genre\/=\/genre\/\d+[^"]*">([^<]+)<span class="number">/g)) add('dlsite', category, decode(m[1]));
  }
}
{
  const html = await page('dmm', 'doujin', DMM_FLOORS.doujin);
  let section = null;
  let category = null;
  for (const t of html.matchAll(/<h3 id="item\d+" class="d-headline[^"]*">([^<]+)<\/h3>|<p class="ttl-genre[^"]*">([\s\S]*?)<\/p>|article=keyword\/id=\d+\/">([^<]+)<\/a>/g)) {
    if (t[1]) { section = decode(t[1]); category = section; continue; }
    if (t[2] !== undefined) { category = decode(t[2].replace(/<[^>]+>/g, '')); continue; }
    if (t[3] && section) add('dmm', `同人:${section === category ? section : `${section}/${category}`}`, decode(t[3]));
  }
}
{
  const html = await page('dmm', 'dlsoft', DMM_FLOORS.dlsoft);
  const body = html.slice(html.indexOf('area-category'));
  let category = null;
  for (const t of body.matchAll(/<div class="capt02[^"]*">\s*<p>([\s\S]*?)<\/p>|list\/\?keyword=\d+[^"]*">([^<]+)<\/a>/g)) {
    if (t[1] !== undefined) { category = decode(t[1]).replace(/^■\s*/, ''); continue; }
    if (t[2] && category) add('dmm', `PCゲーム:${category}`, decode(t[2]));
  }
}
{
  const html = await page('dmm', 'book', DMM_FLOORS.book);
  for (const m of html.matchAll(/\/list\/\?genre=\d+"[^>]*>([^<]+)</g)) add('dmm', '電子書籍:おすすめジャンル', decode(m[1]));
}

const lines = [];
const total = { dlsite: 0, dmm: 0 };
for (const site of ['dlsite', 'dmm']) {
  lines.push(`  ${site}: {`);
  for (const [category, names] of Object.entries(catalog[site]).sort(([a], [b]) => a.localeCompare(b, 'ja'))) {
    const list = [...names].sort((a, b) => a.localeCompare(b, 'ja'));
    total[site] += list.length;
    lines.push(`    ${JSON.stringify(category)}: ${JSON.stringify(list)},`);
  }
  lines.push('  },');
}
const out = `/**
 * DMM（FANZA）と DLsite の公式ジャンルの一覧。tools/gen-genre-catalog.mjs で作る（手で直さない）。
 * 作った日: ${new Date().toISOString().slice(0, 10)}。DLsite ${total.dlsite} 件（13 フロア）、DMM ${total.dmm} 件（同人・PC ゲーム・電子書籍のおすすめ）。
 * 分類はサイトの一覧の見出しのまま（DMM は「フロア:見出し」）。
 */
export const GENRE_CATALOG: Record<'dlsite' | 'dmm', Record<string, string[]>> = {
${lines.join('\n')}
};

/** DLsite が言い換えたジャンル（ID・作品管理の API の名前・作品ページの名前） */
export const DLSITE_RENAMED_GENRES: Array<[id: number, apiName: string, displayName: string]> = ${JSON.stringify(DLSITE_RENAMED)};
`;
const file = path.join(root, 'src/shared/genreCatalog.ts');
fs.writeFileSync(file, out);
console.log(`wrote ${path.relative(root, file)}: dlsite ${total.dlsite} / dmm ${total.dmm}`);
