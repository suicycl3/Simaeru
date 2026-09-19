/**
 * 電子書籍まわりの認証状態を確認する。
 *   npx electron tools/probe-book-auth.js
 * ※ アプリを終了してから実行すること
 */
const path = require('node:path');
const { userDataDir } = require('./app-paths.cjs');
const { app, session } = require('electron');

app.setPath('userData', userDataDir(app.getPath('appData')));

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36';

async function get(url, referer) {
  const res = await session.fromPartition('persist:dmm').fetch(url, {
    credentials: 'include',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': UA,
      Referer: referer
    }
  });
  const text = await res.text();
  return { status: res.status, finalUrl: res.url, head: text.slice(0, 160).replace(/\s+/g, ' ') };
}

app.whenReady().then(async () => {
  try {
    const s = session.fromPartition('persist:dmm');
    for (const domain of ['book.dmm.co.jp', 'www.dmm.co.jp', 'accounts.dmm.co.jp']) {
      const cookies = await s.cookies.get({ domain });
      console.log(`\n[${domain}] Cookie ${cookies.length} 個`);
      console.log('  ', cookies.map((c) => c.name).join(', ').slice(0, 400));
    }

    for (const [label, url, ref] of [
      ['本棚一覧', 'https://book.dmm.co.jp/ajax/bff/library/?shop_name=all&page=1&order=added_desc&show_expired=0&format_webp=1', 'https://book.dmm.co.jp/shelf/'],
      ['同人一覧', 'https://www.dmm.co.jp/dc/doujin/api/mylibraries/?page=1&sort=purchasedate_desc&genre=all&limit=1', 'https://www.dmm.co.jp/dc/-/mylibrary/']
    ]) {
      const res = await get(url, ref);
      console.log(`\n${label}: HTTP ${res.status}`);
      console.log('  final:', res.finalUrl);
      console.log('  body :', res.head);
    }
  } catch (err) {
    console.error('PROBE_ERROR', err && err.stack ? err.stack : err);
  } finally {
    app.quit();
  }
});
