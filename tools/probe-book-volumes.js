/**
 * 電子書籍のシリーズ内の巻一覧（所持巻の列挙）を調べる。
 *   npx electron tools/probe-book-volumes.js 6102818 adult
 * ※ アプリを終了してから実行すること（userData を共有するため）
 *
 * JSチャンクから読み取った呼び出し:
 *   /ajax/bff/contents_book/?shop_name=&series_id=&page=&per_page=
 *     &last_read_position=0&order=asc&purchase_status=all&format_webp=1
 * purchase_status に何が効くのかは実物で確かめる（all / purchased を比較）。
 */
const path = require('node:path');
const { userDataDir } = require('./app-paths.cjs');
const { app, session } = require('electron');

const SERIES = process.argv[2] || '6102818';
const SHOP = process.argv[3] || 'adult';
const HOST = SHOP === 'general' ? 'book.dmm.com' : 'book.dmm.co.jp';

app.setPath('userData', userDataDir(app.getPath('appData')));

async function getJson(url) {
  const res = await session.fromPartition('persist:dmm').fetch(url, {
    credentials: 'include',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `https://${HOST}/product/${SERIES}/`
    }
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: null, text: text.slice(0, 200) };
  }
}

function summarize(label, body) {
  const books = body?.volume_books ?? [];
  const owned = books.filter((b) => b.purchased);
  console.log(`\n== ${label} ==`);
  console.log('  pager:', JSON.stringify(body?.pager));
  console.log(`  巻数: ${books.length} / うち所持: ${owned.length}`);
  for (const b of books.slice(0, 4)) {
    console.log(
      `   ${b.volume_number}巻 ${b.content_id} 所持=${b.purchased ? 'o' : 'x'}`,
      b.purchased ? `stream=${!!b.purchased.streaming_url} dl=${!!b.purchased.download_url}` : '',
      String(b.title).slice(0, 30)
    );
  }
  if (owned[0]) console.log('  所持巻のキー:', Object.keys(owned[0]).join(','));
  if (owned[0]?.purchased) console.log('  purchased:', JSON.stringify(owned[0].purchased).slice(0, 300));
}

app.whenReady().then(async () => {
  try {
    for (const status of ['all', 'purchased']) {
      const url =
        `https://${HOST}/ajax/bff/contents_book/?shop_name=${SHOP}&series_id=${SERIES}` +
        `&page=1&per_page=50&last_read_position=0&order=asc&purchase_status=${status}&format_webp=1`;
      const res = await getJson(url);
      console.log(`\n### purchase_status=${status} HTTP ${res.status}`);
      if (!res.body) {
        console.log('  JSONではない:', res.text);
        continue;
      }
      summarize(`purchase_status=${status}`, res.body);
    }
  } catch (err) {
    console.error('PROBE_ERROR', err && err.stack ? err.stack : err);
  } finally {
    app.quit();
  }
});
