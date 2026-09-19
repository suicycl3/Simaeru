/**
 * DLsite の購入履歴・まとめ買い(パック)・シリアルを、実セッションで確認する。
 *   npx electron tools/probe-dlsite-pack.js VJ000004 VJ000005
 * ※ アプリを終了してから実行すること（userData を共有するため）
 *
 * 注意: /home/download/=/ は実ファイルが流れてくるので絶対に取りに行かないこと。
 */
const os = require('node:os');
const { userDataDir } = require('./app-paths.cjs');
const path = require('node:path');
const { app, session } = require('electron');
const esbuild = require('esbuild');

const PACK = process.argv[2] || 'VJ000004';
const SERIAL = process.argv[3] || 'VJ000005';

app.setPath('userData', userDataDir(app.getPath('appData')));

const outFile = path.join(os.tmpdir(), 'dlsitePurchase.probe.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'main', 'sites', 'dlsite', 'purchaseParse.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'error'
});
const { parseUserbuyPage, parsePackPage, parseSerialPage } = require(outFile);

async function get(url) {
  const res = await session.fromPartition('persist:dlsite').fetch(url, {
    credentials: 'include',
    headers: { Accept: 'text/html', Referer: 'https://www.dlsite.com/' }
  });
  return { status: res.status, text: await res.text() };
}

app.whenReady().then(async () => {
  try {
    const buy = await get(
      'https://www.dlsite.com/home/mypage/userbuy/=/type/all/start/all/sort/1/order/1/page/1'
    );
    const page = parseUserbuyPage(buy.text);
    const kinds = {};
    for (const r of page.rows) kinds[r.dlKind] = (kinds[r.dlKind] || 0) + 1;
    console.log(`\n== 購入履歴 HTTP ${buy.status} ==`);
    console.log('  総件数:', page.total, '/ 行数:', page.rows.length, '/ 種別:', JSON.stringify(kinds));
    console.log('  例:', JSON.stringify(page.rows[0]));

    const pack = await get(
      `https://www.dlsite.com/home/download/pack/product/=/product_id/${PACK}.html`
    );
    console.log(`\n== パック ${PACK} HTTP ${pack.status} (${pack.text.length} bytes) ==`);
    for (const c of parsePackPage(pack.text)) {
      console.log('  ', c.workno, '|', c.dlKind, '|', c.title, '|', c.dlUrl);
    }

    const serial = await get(`https://www.dlsite.com/home/serial/=/product_id/${SERIAL}.html`);
    const info = parseSerialPage(serial.text);
    console.log(`\n== シリアル ${SERIAL} HTTP ${serial.status} ==`);
    console.log('  ライセンスキー:', info.licenseKey);
    console.log('  ダウンロード  :', info.downloadUrl);
  } catch (err) {
    console.error('PROBE_ERROR', err && err.stack ? err.stack : err);
  } finally {
    app.quit();
  }
});
