import assert from 'node:assert/strict';
import { testBuild } from './test-support.mjs';
const build = testBuild();
try {
  const { parseUserbuyPage, parseSerialPage, parsePackPage } = build.load('src/main/sites/dlsite/purchaseParse.ts');
  const kinds = ['download', 'split', 'pack', 'serial', 'none'];
  const urls = ['/home/download/=/product_id/RJ100001.html', '/home/download/split/=/product_id/RJ100002.html', '/home/download/pack/product/=/product_id/RJ100003.html', '/home/serial/=/product_id/VJ100004.html', null];
  const html = '<div class="page_total"><strong>1,234</strong></div><table>' + kinds.map((kind,i) => `<tr><td class="buy_date">2026/9/7 03:04</td><td><a href="/work/=/product_id/${i === 3 ? 'VJ' : 'RJ'}10000${i+1}.html">作品</a></td><td class="re_dl">${urls[i] ? `<a href="${urls[i]}" class="btn_dl">DL</a>` : ''}</td><td class="work_price">1,000円</td><td class="payment_method">カード</td></tr>`).join('') + '</table>';
  const page = parseUserbuyPage(html);
  assert.equal(page.total, 1234);
  assert.deepEqual(page.rows.map(r => r.dlKind), kinds);
  assert.ok(page.rows.every(r => r.buyDate === '2026-09-07 03:04' && r.priceText === '1,000円' && r.paymentMethod === 'カード'));
  assert.deepEqual(parseUserbuyPage('<html>ログイン</html>'), {total:null,rows:[]});
  assert.deepEqual(parseSerialPage('<table><tr><th>ライセンスキー</th><td><strong>TEST-ONLY-KEY</strong></td></tr></table><p class="work_download"><a href="/home/download/=/product_id/VJ100004.html">DL</a></p>'), {licenseKey:'TEST-ONLY-KEY',downloadUrl:urls[3].replace('/serial/', '/download/')});
  assert.deepEqual(parseSerialPage(''), {licenseKey:null,downloadUrl:null});
  const pack = parsePackPage('<tr><td>親</td></tr><tr class="child_item"><td><a href="/work/=/product_id/RJ100002.html">作品</a><dd class="work_name">子 &amp; 作品</dd><div class="work_download"><a href="'+urls[1]+'">DL</a></div></td></tr>');
  assert.deepEqual(pack, [{workno:'RJ100002',title:'子 & 作品',dlKind:'split',dlUrl:urls[1]}]);
  assert.deepEqual(parsePackPage(''), []);
  console.log('OK: purchase kinds, dates, serial, pack, empty pages');
} finally { build.close(); }
