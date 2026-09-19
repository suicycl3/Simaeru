/**
 * 動画フロア調査用。アプリ本体と同じ Cookie パーティションで video.dmm.co.jp を読み、
 *  - マイライブラリのHTMLに何が埋まっているか（RSC / __NEXT_DATA__）
 *  - JSチャンクの中の GraphQL クエリ定義とオペレーション名
 * を洗い出す。DBには一切書かない。
 *
 *   npx electron tools/probe-video.js <出力先ディレクトリ>
 */
const fs = require('node:fs');
const { userDataDir } = require('./app-paths.cjs');
const path = require('node:path');
const { app, session } = require('electron');

const OUT = process.argv[2] || path.join(__dirname, 'probe-out');
const PARTITION = 'persist:dmm';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36';

app.setPath('userData', userDataDir(app.getPath('appData')));

function save(name, data) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    path.join(OUT, name),
    typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    'utf8'
  );
}

async function get(url, extraHeaders) {
  const res = await session.fromPartition(PARTITION).fetch(url, {
    credentials: 'include',
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'ja,en-US;q=0.9',
      ...(extraHeaders || {})
    }
  });
  return { status: res.status, url: res.url, text: await res.text() };
}

const LIB = 'https://video.dmm.co.jp/mylibrary/';

async function main() {
  const report = [];

  // Cookie ストアをディスクから読ませてから最初のリクエストを出す
  const cookies = await session.fromPartition(PARTITION).cookies.get({});
  report.push(`cookies: ${cookies.length}`);

  const page = await get(LIB);
  save('video-mylibrary.html', page.text);
  report.push(`GET ${LIB} -> HTTP ${page.status}, ${page.text.length} bytes, final=${page.url}`);
  report.push(`  __NEXT_DATA__: ${page.text.includes('__NEXT_DATA__') ? 'あり' : 'なし'}`);
  report.push(`  self.__next_f (RSC): ${page.text.includes('__next_f') ? 'あり' : 'なし'}`);
  report.push(`  "graphql" 出現: ${(page.text.match(/graphql/gi) || []).length} 回`);

  // 作品IDらしき文字列がHTMLに直接埋まっているか（RSCならここに出る）
  const contentIds = [...new Set((page.text.match(/[a-z0-9]{2,}[0-9]{3,}[a-z]{0,3}/gi) || []))];
  report.push(`  ID候補: ${contentIds.length} 種`);

  // JSチャンクを集めて GraphQL 定義を探す
  const scripts = [...new Set([...page.text.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]))];
  report.push(`script tags: ${scripts.length}`);

  const found = [];
  let scanned = 0;
  for (const src of scripts) {
    const url = src.startsWith('http') ? src : new URL(src, LIB).href;
    let js;
    try {
      js = await get(url);
    } catch (err) {
      continue;
    }
    scanned++;
    // GraphQL のオペレーション定義（query Xxx / fragment Xxx on Yyy）
    for (const m of js.text.matchAll(/\b(query|mutation)\s+([A-Za-z0-9_]+)\s*[({]/g)) {
      found.push({ kind: m[1], name: m[2], chunk: url });
    }
  }
  report.push(`scanned chunks: ${scanned}`);

  const byName = new Map();
  for (const f of found) if (!byName.has(f.name)) byName.set(f.name, f);
  save('video-graphql-operations.json', [...byName.values()]);
  report.push(`GraphQL オペレーション: ${byName.size} 種`);
  const libraryOps = [...byName.keys()].filter((n) => /librar|shelf|purchas|owned|mylist/i.test(n));
  report.push(`  ライブラリ関連らしき名前: ${libraryOps.join(', ') || '(なし)'}`);

  save('report-video.txt', report.join('\n'));
  console.log(report.join('\n'));
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (err) {
    console.error('PROBE_ERROR', err && err.stack ? err.stack : err);
  } finally {
    app.quit();
  }
});
