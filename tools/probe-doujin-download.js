/**
 * 同人のダウンロード導線（proxy URL）の先が何なのかを、**本体を落とさずに**調べる。
 *   npx electron tools/probe-doujin-download.js d_100003
 * ※ アプリを終了してから実行すること（userData を共有するため）
 *
 * `fetch()` で取ると実ファイルが丸ごとメモリに載って落ちる危険がある（DLsiteで実際に踏んだ）。
 * ここでは net.request を使い、リダイレクト先とレスポンスヘッダだけ見て中断する。
 * HTML（案内ページ）だったときだけ、先頭を少しだけ読む。
 */
const path = require('node:path');
const { userDataDir } = require('./app-paths.cjs');
const { app, net, session } = require('electron');

app.setPath('userData', userDataDir(app.getPath('appData')));

const PRODUCT = process.argv[2] || 'd_100003';
const URL_ =
  `https://www.dmm.co.jp/dc/-/proxy/=/transfer_type=download/shop=doujin/product_id=${PRODUCT}/`;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36';

/** 1回ぶんのリクエスト。リダイレクトは追わずに教えてもらう */
function inspect(url, referer, headers = true) {
  return new Promise((resolve) => {
    const req = net.request({
      method: 'GET',
      url,
      session: session.fromPartition('persist:dmm'),
      useSessionCookies: true,
      redirect: 'manual'
    });
    // UAは常に送る（無いと400になるサーバがある）。
    // Referer は accounts へのトークン受け渡しでは ERR_BLOCKED_BY_CLIENT を招くので切り替える。
    req.setHeader('User-Agent', UA);
    req.setHeader('Accept', 'text/html,application/xhtml+xml,*/*');
    if (headers && referer) req.setHeader('Referer', referer);

    req.on('redirect', (status, _method, redirectUrl) => {
      req.abort();
      resolve({ kind: 'redirect', status, redirectUrl });
    });

    req.on('response', (res) => {
      const h = res.headers;
      const type = String(h['content-type'] || '');
      const length = Number(h['content-length'] || 0);
      const disposition = String(h['content-disposition'] || '');
      const isHtml = /text\/html/i.test(type);

      // HTML（案内ページ）のときだけ中身を少しだけ見る。
      // 実ファイルなら読まずに切る。
      if (!isHtml) {
        res.destroy?.();
        req.abort();
        resolve({ kind: 'file', status: res.statusCode, type, length, disposition });
        return;
      }
      let body = '';
      res.on('data', (chunk) => {
        body += chunk.toString('utf8');
        if (body.length > 60_000) {
          res.destroy?.();
          req.abort();
        }
      });
      res.on('end', () =>
        resolve({ kind: 'html', status: res.statusCode, type, length, disposition, body })
      );
      res.on('aborted', () =>
        resolve({ kind: 'html', status: res.statusCode, type, length, disposition, body })
      );
    });

    req.on('error', (err) => resolve({ kind: 'error', message: err.message }));
    req.end();
  });
}

app.whenReady().then(async () => {
  let url = URL_;
  const referer = `https://www.dmm.co.jp/dc/-/mylibrary/detail/=/product_id=${PRODUCT}/`;

  for (let hop = 1; hop <= 6; hop++) {
    // 2ホップ目以降（accounts へのトークン受け渡し）はヘッダを足さない
    // 1ホップ目だけ Referer を付ける（作品ページから押した形にする）
    let r = await inspect(url, referer, hop === 1 || hop === 3);
    if (r.kind === 'error' && r.message.includes('BLOCKED')) {
      console.log(`  （ヘッダ有りで ${r.message} → ヘッダ無しで再試行）`);
      r = await inspect(url, null, false);
    }
    console.log(`\n--- ${hop}. ${url.slice(0, 120)}`);
    if (r.kind === 'redirect') {
      console.log(`  HTTP ${r.status} → ${r.redirectUrl}`);
      url = r.redirectUrl;
      continue;
    }
    if (r.kind === 'error') {
      console.log('  エラー:', r.message);
      break;
    }
    console.log(
      `  HTTP ${r.status} / type=${r.type} / length=${r.length || '不明'} / disposition=${r.disposition || 'なし'}`
    );
    if (r.kind === 'file') {
      console.log('  → 実ファイル。ここは fetch せず、ディスクへ流す形で落とすこと。');
      break;
    }
    // 案内ページなら、中のダウンロードリンクを拾う
    const links = [...new Set(r.body.match(/href="[^"]*(?:download|proxy|transfer)[^"]*"/gi) || [])];
    console.log(`  HTMLの長さ: ${r.body.length}`);
    if (r.body.length < 4000) {
      console.log('  本文:', r.body.replace(/\s+/g, ' ').slice(0, 600));
    }
    console.log('  ダウンロードらしきリンク:');
    for (const l of links.slice(0, 12)) console.log('   ', l.slice(6, -1));
    const forms = r.body.match(/<form[^>]*>/gi) || [];
    if (forms.length) console.log('  フォーム:', forms.slice(0, 3));
    break;
  }
  app.quit();
});
