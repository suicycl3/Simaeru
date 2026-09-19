/**
 * 同人の店舗ページHTMLの構造調査。
 * アプリのプロファイルには触れず、一時 userData で年齢確認クッキーだけ入れて取得する
 * （店舗ページはログイン不要）。
 *
 *   npx electron tools/probe-doujin-store.js d_100006
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, session } = require('electron');

const CID = process.argv[2] || 'd_100006';
const OUT = path.join(os.tmpdir(), `doujin-${CID}.html`);

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'doujin-probe-')));

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

    const url = `https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=${CID}/`;
    const res = await s.fetch(url, { credentials: 'include' });
    const html = await res.text();
    fs.writeFileSync(OUT, html, 'utf8');
    console.log(`HTTP ${res.status} / ${html.length} bytes -> ${OUT}`);

    const title = html.match(/<title>([^<]*)<\/title>/i)?.[1];
    console.log('title:', title);
    console.log('ld+json:', (html.match(/application\/ld\+json/g) || []).length, '個');

    // 「ジャンル」「作者」などのラベルがどんなマークアップで出てくるかを見る
    for (const label of ['ジャンル', '作者', '配信開始日', '作品形式', 'シリーズ', 'ファイル容量']) {
      const i = html.indexOf(`>${label}`) >= 0 ? html.indexOf(`>${label}`) : html.indexOf(label);
      if (i < 0) {
        console.log(`--- ${label}: 見つからない`);
        continue;
      }
      console.log(`--- ${label} 周辺 ---`);
      console.log('   ', html.slice(Math.max(0, i - 220), i + 420).replace(/\s+/g, ' '));
    }
  } catch (err) {
    console.error('PROBE_ERROR', err && err.stack ? err.stack : err);
  } finally {
    app.quit();
  }
});
