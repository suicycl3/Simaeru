/**
 * 動画フロア調査 第2段。JSチャンクから GraphQL のオペレーション本文とフラグメントを
 * 抜き出して組み立て、実際に api.video.dmm.co.jp/graphql へ投げて確かめる。
 *
 *   npx electron tools/probe-video2.js <出力先ディレクトリ>
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
const LIB = 'https://video.dmm.co.jp/mylibrary/';
const GQL = 'https://api.video.dmm.co.jp/graphql';

app.setPath('userData', userDataDir(app.getPath('appData')));

function save(name, data) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    path.join(OUT, name),
    typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    'utf8'
  );
}

async function get(url) {
  const res = await session.fromPartition(PARTITION).fetch(url, {
    credentials: 'include',
    headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en-US;q=0.9' }
  });
  return { status: res.status, text: await res.text() };
}

async function postGraphql(body) {
  const res = await session.fromPartition(PARTITION).fetch(GQL, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      Accept: '*/*',
      Origin: 'https://video.dmm.co.jp',
      Referer: LIB
    },
    body: JSON.stringify(body)
  });
  return { status: res.status, text: await res.text() };
}

/** start にある `{` から対応する `}` までを含めて切り出す */
function sliceBlock(src, startIdx) {
  const open = src.indexOf('{', startIdx);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(startIdx, i + 1);
    }
  }
  return null;
}

function extractOperation(src, kind, name) {
  const re = new RegExp(`\\b${kind}\\s+${name}\\s*[({]`, 'g');
  const m = re.exec(src);
  if (!m) return null;
  return sliceBlock(src, m.index);
}

function extractFragment(src, name) {
  const re = new RegExp(`\\bfragment\\s+${name}\\s+on\\s+[A-Za-z0-9_]+\\s*{`, 'g');
  const m = re.exec(src);
  if (!m) return null;
  return sliceBlock(src, m.index);
}

/** ...FragmentName を再帰的に解決して1つのドキュメントにする */
function assemble(all, rootText) {
  const parts = [rootText];
  const seen = new Set();
  const queue = [...rootText.matchAll(/\.\.\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const frag = extractFragment(all, name);
    if (!frag) continue;
    parts.push(frag);
    for (const m of frag.matchAll(/\.\.\.([A-Za-z0-9_]+)/g)) {
      if (!seen.has(m[1])) queue.push(m[1]);
    }
  }
  return { doc: parts.join('\n\n'), fragments: [...seen] };
}

async function main() {
  const report = [];
  await session.fromPartition(PARTITION).cookies.get({});

  const page = await get(LIB);
  const scripts = [...new Set([...page.text.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]))];
  let all = '';
  for (const src of scripts) {
    const url = src.startsWith('http') ? src : new URL(src, LIB).href;
    try {
      all += (await get(url)).text + '\n';
    } catch {
      /* 取れないチャンクは飛ばす */
    }
  }
  report.push(`chunks: ${scripts.length}, 総文字数: ${all.length}`);
  save('video-chunks-concat.txt', all);

  for (const name of ['Mylibrary', 'LoadMorePurchasedContent', 'MylibrarySearch']) {
    const op = extractOperation(all, 'query', name);
    if (!op) {
      report.push(`${name}: 本文が見つからない`);
      continue;
    }
    const { doc, fragments } = assemble(all, op);
    save(`gql-${name}.graphql`, doc);
    const sig = op.slice(0, op.indexOf('{')).replace(/\s+/g, ' ').trim();
    report.push(`${name}: 定義 ${op.length} 字 / フラグメント ${fragments.length} 個`);
    report.push(`  シグネチャ: ${sig}`);
  }

  save('report-video2.txt', report.join('\n'));
  console.log(report.join('\n'));

  // 変数なしで投げてみて、サーバが要求する変数をエラーから読む
  const doc = fs.existsSync(path.join(OUT, 'gql-Mylibrary.graphql'))
    ? fs.readFileSync(path.join(OUT, 'gql-Mylibrary.graphql'), 'utf8')
    : null;
  if (doc) {
    const res = await postGraphql({ operationName: 'Mylibrary', query: doc, variables: {} });
    save('gql-Mylibrary-novars.json', res.text);
    console.log(`\nMylibrary(変数なし) -> HTTP ${res.status}: ${res.text.slice(0, 600)}`);
  }
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
