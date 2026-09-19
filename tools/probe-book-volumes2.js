/**
 * 巻一覧APIの生レスポンスを見る（所持フラグがどこに出るのかの確認）。
 *   npx electron tools/probe-book-volumes2.js 1000001 adult b111abcd00001
 * ※ アプリを終了してから実行すること
 */
const fs = require('node:fs');
const { userDataDir } = require('./app-paths.cjs');
const os = require('node:os');
const path = require('node:path');
const { app, session } = require('electron');

const SERIES = process.argv[2] || '6102818';
const SHOP = process.argv[3] || 'adult';
const CONTENT = process.argv[4] || '';
const HOST = SHOP === 'general' ? 'book.dmm.com' : 'book.dmm.co.jp';

app.setPath('userData', userDataDir(app.getPath('appData')));

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36';

/** アプリ本体と同じ前提を揃える（年齢確認Cookieが無いとAPIまで到達しないことがある） */
async function ensureAgeCheck() {
  const s = session.fromPartition('persist:dmm');
  const expires = Date.now() / 1000 + 60 * 60 * 24 * 365;
  for (const domain of ['.dmm.co.jp', '.dmm.com']) {
    await s.cookies
      .set({ url: `https://${domain.slice(1)}/`, name: 'age_check_done', value: '1', domain, path: '/', secure: true, expirationDate: expires })
      .catch(() => undefined);
  }
}

async function getJson(url) {
  const res = await session.fromPartition('persist:dmm').fetch(url, {
    credentials: 'include',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': UA,
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      Referer: `https://${HOST}/product/${SERIES}/${CONTENT}/`
    }
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: null, text: text.slice(0, 300) };
  }
}

app.whenReady().then(async () => {
  const base = `shop_name=${SHOP}&series_id=${SERIES}`;
  const targets = [
    ['contents_book', `https://${HOST}/ajax/bff/contents_book/?${base}&page=1&per_page=5&last_read_position=0&order=asc&purchase_status=all&format_webp=1`],
    ['contents', `https://${HOST}/ajax/bff/contents/?${base}&page=1&per_page=5&last_read_position=0&order=asc&purchase_status=all&format_webp=1`],
    ['product_volume', `https://${HOST}/ajax/bff/product_volume/?${base}&content_id=${CONTENT}&format_webp=1`],
    ['product_volume_purchased', `https://${HOST}/ajax/bff/product_volume_purchased/?${base}&content_id=${CONTENT}`],
    ['series_purchased', `https://${HOST}/ajax/bff/series_purchased/?${base}`]
  ];
  try {
    await ensureAgeCheck();
    for (const [name, url] of targets) {
      const res = await getJson(url);
      console.log(`\n##### ${name}  HTTP ${res.status}`);
      if (!res.body) {
        console.log('  JSONではない:', res.text);
        continue;
      }
      const file = path.join(os.tmpdir(), `book-${name}.json`);
      fs.writeFileSync(file, JSON.stringify(res.body, null, 1), 'utf8');
      const json = JSON.stringify(res.body);
      console.log('  保存:', file, `(${json.length} bytes)`);
      console.log('  トップキー:', Object.keys(res.body).join(','));
      const first = res.body.volume_books?.[0];
      if (first) console.log('  volume_books[0] キー:', Object.keys(first).join(','));
      // 所持らしきキーを総当たりで探す
      for (const kw of ['purchas', 'owned', 'is_have', 'streaming_url', 'download_url']) {
        const n = (json.match(new RegExp(kw, 'g')) || []).length;
        if (n) console.log(`   「${kw}」 ${n} 回`);
      }
    }
  } catch (err) {
    console.error('PROBE_ERROR', err && err.stack ? err.stack : err);
  } finally {
    app.quit();
  }
});
