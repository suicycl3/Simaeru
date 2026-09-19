/**
 * 電子書籍の店舗ページが取れない原因の切り分け。
 * アプリのプロファイルには触れず、一時 userData で年齢確認クッキーだけ入れて試す。
 *
 *   npx electron tools/probe-book-store.js https://book.dmm.com/product/1000000/b111abcd00002/
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, session } = require('electron');

const URL_ = process.argv[2] || 'https://book.dmm.com/product/1000000/b111abcd00002/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36';

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'book-probe-')));

async function attempt(label, headers) {
  const s = session.defaultSession;
  try {
    const res = await s.fetch(URL_, { credentials: 'include', headers });
    const text = await res.text();
    const hasLd = text.includes('application/ld+json');
    const hasDl = /<dt[^>]*>/.test(text);
    const testids = (text.match(/data-testid="volume-detail-info/g) || []).length;
    console.log(
      `${label}: HTTP ${res.status} / ${text.length} bytes / ld+json:${hasLd} / dt:${hasDl} / testid:${testids}`
    );
    console.log('   content-type:', res.headers.get('content-type'));
    if (!hasLd) console.log('   先頭:', text.slice(0, 200).replace(/\s+/g, ' '));
    return text;
  } catch (err) {
    console.log(`${label}: 失敗 ${err.message}`);
    return null;
  }
}

app.whenReady().then(async () => {
  try {
    const s = session.defaultSession;
    const expires = Date.now() / 1000 + 3600;
    for (const domain of ['.dmm.co.jp', '.dmm.com']) {
      await s.cookies
        .set({
          url: `https://www${domain}/`,
          name: 'age_check_done',
          value: '1',
          domain,
          path: '/',
          secure: true,
          expirationDate: expires
        })
        .catch(() => undefined);
    }

    console.log('URL:', URL_);
    // 本体と同じヘッダ構成（fetchText 相当）
    await attempt('A) UA+Accept-Language のみ（現状）', {
      'User-Agent': UA,
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8'
    });
    // ブラウザと同じく Accept を明示
    const html = await attempt('B) Accept: text/html を追加', {
      'User-Agent': UA,
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    });
    // ヘッダなし
    await attempt('C) ヘッダなし', {});

    if (html) {
      const out = path.join(os.tmpdir(), 'book-store-probe.html');
      fs.writeFileSync(out, html, 'utf8');
      console.log('保存:', out);
    }
  } catch (err) {
    console.error('PROBE_ERROR', err && err.stack ? err.stack : err);
  } finally {
    app.quit();
  }
});
