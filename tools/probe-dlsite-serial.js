/**
 * DLsite のシリアルコード / ダウンロードページの構造調査。
 * アプリと同じ Cookie パーティション（persist:dlsite）を使う。
 *
 *   npx electron tools/probe-dlsite-serial.js VJ000006
 * ※ アプリを終了してから実行すること（userData を共有するため）
 */
const fs = require('node:fs');
const { userDataDir } = require('./app-paths.cjs');
const os = require('node:os');
const path = require('node:path');
const { app, session } = require('electron');

const PARTITION = 'persist:dlsite';
const WORKNO = process.argv[2] || 'VJ000006';

app.setPath('userData', userDataDir(app.getPath('appData')));

async function get(url) {
  const res = await session.fromPartition(PARTITION).fetch(url, {
    credentials: 'include',
    headers: { Referer: 'https://www.dlsite.com/home/mypage/userbuy' }
  });
  return { status: res.status, finalUrl: res.url, text: await res.text() };
}

app.whenReady().then(async () => {
  try {
    await session.fromPartition(PARTITION).cookies.get({});

    for (const [label, url] of [
      ['シリアル', `https://www.dlsite.com/home/serial/=/product_id/${WORKNO}.html`],
      ['ダウンロード', `https://www.dlsite.com/home/download/=/product_id/${WORKNO}.html`]
    ]) {
      const res = await get(url);
      console.log(`\n##### ${label}: HTTP ${res.status} / ${res.text.length} bytes`);
      console.log('  final:', res.finalUrl || '(なし)');
      if (res.text.length < 1000) {
        console.log('  本文:', res.text.replace(/\s+/g, ' ').slice(0, 600));
      }
      const out = path.join(os.tmpdir(), `dlsite-${label}-${WORKNO}.html`);
      fs.writeFileSync(out, res.text, 'utf8');
      console.log('  保存:', out);

      // ページ内でシリアルらしき文字列を探す
      const body = res.text.slice(res.text.indexOf('<body'));
      for (const kw of ['シリアル', 'serial', 'ライセンス', 'プロダクトキー']) {
        const n = (body.match(new RegExp(kw, 'g')) || []).length;
        if (n) console.log(`  「${kw}」: ${n} 回`);
      }
      const codes = body.match(/[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8}){2,5}/g);
      if (codes) console.log('  コード形式らしき文字列:', [...new Set(codes)].slice(0, 5));
    }
  } catch (err) {
    console.error('PROBE_ERROR', err && err.stack ? err.stack : err);
  } finally {
    app.quit();
  }
});
