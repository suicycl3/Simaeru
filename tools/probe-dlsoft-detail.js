/**
 * PCゲーム詳細APIの疎通確認。アプリ本体と同じ Cookie パーティションで
 * single / set 両方を叩き、注文日とダウンロード情報が取れるかを見る。
 *
 *   npx electron tools/probe-dlsoft-detail.js <productId> [set]
 */
const path = require('node:path');
const { userDataDir } = require('./app-paths.cjs');
const { app, session } = require('electron');

const PARTITION = 'persist:dmm';
const LIBRARY_PAGE = 'https://dlsoft.dmm.co.jp/library/';
const PRODUCT = process.argv[2] || 'sample_0001';
const KIND = process.argv[3] === 'set' ? 'set' : 'single';

app.setPath('userData', userDataDir(app.getPath('appData')));

async function get(url, headers) {
  const res = await session.fromPartition(PARTITION).fetch(url, {
    credentials: 'include',
    headers: { Referer: LIBRARY_PAGE, ...(headers || {}) }
  });
  return { status: res.status, url: res.url, text: await res.text() };
}

const AJAX = { Accept: 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest' };

app.whenReady().then(async () => {
  try {
    await session.fromPartition(PARTITION).cookies.get({});

    const page = await get(LIBRARY_PAGE);
    const csrf = page.text.match(/<meta\s+name="csrf-token"[^>]*content="([^"]+)"/i)?.[1];
    console.log(`/library/ : HTTP ${page.status}, ${page.text.length} bytes, csrf=${csrf ? 'あり' : 'なし'}`);
    if (!csrf) {
      console.log('  title:', (page.text.match(/<title>([^<]*)<\/title>/i) || [])[1]);
      console.log('  head :', page.text.slice(0, 300).replace(/\s+/g, ' '));
    }
    if (!csrf) throw new Error('csrf-token が取れない（未ログインの可能性）');

    const url = `https://dlsoft.dmm.co.jp/ajax/v1/library/detail/${KIND}/?productId=${encodeURIComponent(PRODUCT)}`;
    const res = await get(url, { ...AJAX, 'X-CSRF-TOKEN': csrf });
    console.log(`detail/${KIND} : HTTP ${res.status}`);
    const json = JSON.parse(res.text);
    if (json.error) {
      console.log('error:', JSON.stringify(json.error).slice(0, 300));
    } else if (KIND === 'set') {
      console.log('  title    :', json.body?.product?.title);
      console.log('  orderDate:', json.body?.order?.orderDate, '/ 注文番号', json.body?.order?.orderItemNo);
      console.log('  収録作品 :', (json.body?.childProducts || []).length, '本');
      const first = (json.body?.childProducts || [])[0];
      if (first) {
        console.log('   例:', first.product?.title);
        console.log('   dl:', JSON.stringify(first.download).slice(0, 200));
      }
    } else {
      const d = json.body?.productDetail;
      console.log('  title            :', d?.product?.title);
      console.log('  deliveryBeginDate:', d?.product?.deliveryBeginDate);
      console.log('  orderDate        :', json.body?.order?.orderDate, '/ 注文番号', json.body?.order?.orderItemNo);
      console.log('  download         :', JSON.stringify(d?.download).slice(0, 320));
      console.log('  browser          :', d?.browser ? `canPlay=${d.browser.canPlay} url=${d.browser.playPageUrl}` : 'null');
    }
  } catch (err) {
    console.error('PROBE_ERROR', err && err.stack ? err.stack : err);
  } finally {
    app.quit();
  }
});
