/**
 * ダウンロード先が HTTP Range（途中から再開）に対応しているかを確かめる。
 * 本体は落とさず、先頭1KBだけ要求して 206 が返るかを見る。
 *
 *   npx electron tools/probe-range-support.js
 * ※ アプリを終了してから実行すること
 */
const path = require('node:path');
const { userDataDir } = require('./app-paths.cjs');
const { app, net, session } = require('electron');

app.setPath('userData', userDataDir(app.getPath('appData')));

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36';

const TARGETS = [
  {
    label: 'DMM 同人',
    partition: 'persist:dmm',
    url: 'https://www.dmm.co.jp/dc/-/proxy/=/transfer_type=download/shop=doujin/product_id=d_100003/'
  },
  {
    label: 'DLsite',
    partition: 'persist:dlsite',
    url: 'https://www.dlsite.com/home/download/=/product_id/RJ01000002.html'
  }
];

/** リダイレクトは追わずに1ホップだけ見る */
function hop(partition, url, headers = {}) {
  return new Promise((resolve) => {
    const req = net.request({
      method: 'GET',
      url,
      session: session.fromPartition(partition),
      useSessionCookies: true,
      redirect: 'manual'
    });
    req.setHeader('User-Agent', UA);
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);

    req.on('redirect', (status, _m, redirectUrl) => {
      req.abort();
      resolve({ kind: 'redirect', status, redirectUrl });
    });
    req.on('response', (res) => {
      const h = res.headers;
      res.on('data', () => undefined);
      res.on('end', () => undefined);
      // 本文は読まずに切る
      setTimeout(() => req.abort(), 0);
      resolve({
        kind: 'response',
        status: res.statusCode,
        acceptRanges: h['accept-ranges'],
        contentRange: h['content-range'],
        contentLength: h['content-length'],
        etag: h['etag'],
        lastModified: h['last-modified'],
        type: h['content-type']
      });
    });
    req.on('error', (err) => resolve({ kind: 'error', message: err.message }));
    req.end();
  });
}

/** リダイレクトを辿って実体のURLまで行く */
async function resolveFinal(partition, url) {
  let current = url;
  for (let i = 0; i < 6; i++) {
    const r = await hop(partition, current);
    if (r.kind !== 'redirect') return { url: current, head: r };
    current = r.redirectUrl;
  }
  return { url: current, head: null };
}

app.whenReady().then(async () => {
  for (const t of TARGETS) {
    console.log(`\n##### ${t.label}`);
    const { url, head } = await resolveFinal(t.partition, t.url);
    console.log('  実体URL:', url.slice(0, 110));
    if (head && head.kind === 'response') {
      console.log(
        `  通常GET : HTTP ${head.status} / ${head.type} / ${head.contentLength} bytes` +
          ` / Accept-Ranges=${head.acceptRanges || 'なし'}`
      );
      console.log(`  ETag=${head.etag || 'なし'} / Last-Modified=${head.lastModified || 'なし'}`);
    } else {
      console.log('  通常GET :', JSON.stringify(head));
    }

    const ranged = await hop(t.partition, url, { Range: 'bytes=0-1023' });
    if (ranged.kind === 'response') {
      const ok = ranged.status === 206;
      console.log(
        `  Range要求: HTTP ${ranged.status} ${ok ? '→ 途中から再開できる' : '→ 再開できない（最初から）'}`
      );
      console.log(`  Content-Range=${ranged.contentRange || 'なし'}`);
    } else {
      console.log('  Range要求:', JSON.stringify(ranged));
    }
  }
  app.quit();
});
