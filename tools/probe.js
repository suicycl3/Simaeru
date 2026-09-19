/**
 * 調査用スクリプト。アプリ本体と同じ userData / Cookie パーティションを使って
 * DMM の API を叩き、生レスポンスを保存する。API仕様の確認専用で、DBには一切書かない。
 *
 *   npx electron tools/probe.js <出力先ディレクトリ>
 *
 * アプリ本体が起動中だと userData が競合するので、必ず終了させてから実行すること。
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
  const file = path.join(OUT, name);
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8');
  return file;
}

async function get(url, referer) {
  const res = await session.fromPartition(PARTITION).fetch(url, {
    credentials: 'include',
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'ja,en-US;q=0.9',
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      ...(referer ? { Referer: referer } : {})
    }
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* HTML が返ることもある */
  }
  return { status: res.status, url: res.url, text, json };
}

const SHELF = 'https://book.dmm.co.jp/shelf/';

async function main() {
  const report = [];

  // このセッションが実際に Cookie を見えているかを最初に確かめる
  const cookies = await session.fromPartition(PARTITION).cookies.get({});
  report.push(`cookies: ${cookies.length} 件`);
  report.push(
    `  login_secure_id: ${cookies.some((c) => c.name === 'login_secure_id') ? 'あり' : 'なし'}`
  );
  save('cookies.txt', cookies.map((c) => `${c.domain}\t${c.name}`).join('\n'));

  const point = await get('https://accounts.dmm.co.jp/api/v1/point', 'https://accounts.dmm.co.jp/settings');
  report.push(`accounts point: HTTP ${point.status} ${point.text.slice(0, 120)}`);

  const dlsoftPage = await get('https://dlsoft.dmm.co.jp/library/');
  const hasCsrf = /<meta\s+name="csrf-token"/i.test(dlsoftPage.text);
  report.push(`dlsoft /library/: HTTP ${dlsoftPage.status} csrf=${hasCsrf ? 'あり' : 'なし'}`);

  const facets = await get(
    'https://book.dmm.co.jp/ajax/bff/library/facets/?shop_name=all&show_expired=0',
    SHELF
  );
  save('book-facets.json', facets.json ?? facets.text);
  report.push(`facets: HTTP ${facets.status}`);

  // 期限切れを含める / 含めないで件数が変わるかを確認する
  for (const showExpired of [0, 1]) {
    const first = await get(
      'https://book.dmm.co.jp/ajax/bff/library/' +
        `?shop_name=all&page=1&order=added_desc&show_expired=${showExpired}&format_webp=1`,
      SHELF
    );
    save(`book-page1-expired${showExpired}.json`, first.json ?? first.text);
    const total = first.json?.pager?.total_count;
    const perPage = first.json?.pager?.per_page;
    report.push(
      `library show_expired=${showExpired}: HTTP ${first.status} total_count=${total} per_page=${perPage} items=${
        first.json?.series_books?.length
      }`
    );

    if (showExpired === 0 && typeof total === 'number' && typeof perPage === 'number') {
      const all = [...(first.json.series_books ?? [])];
      const pages = Math.ceil(total / perPage);
      for (let page = 2; page <= pages; page++) {
        const res = await get(
          'https://book.dmm.co.jp/ajax/bff/library/' +
            `?shop_name=all&page=${page}&order=added_desc&show_expired=0&format_webp=1`,
          SHELF
        );
        all.push(...(res.json?.series_books ?? []));
        await new Promise((r) => setTimeout(r, 350));
      }
      save('book-all-series.json', all);
      report.push(`全ページ取得: ${all.length} 件`);
    }
  }

  save('report.txt', report.join('\n'));
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
