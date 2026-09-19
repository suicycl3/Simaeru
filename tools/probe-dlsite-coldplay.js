/**
 * 「www にはログイン済みだが play のセッションだけ無い」状態を作って、
 * ログイン判定の各段（play → 起こし直し → www）がどう返るかを見る。
 *
 * 本物の persist:dlsite は読み取るだけ。判定は使い捨てパーティションで行う。
 *   npx electron tools/probe-dlsite-coldplay.js
 * ※ アプリを終了してから実行すること
 */
const path = require('node:path');
const { userDataDir } = require('./app-paths.cjs');
const { app, session } = require('electron');

app.setPath('userData', userDataDir(app.getPath('appData')));

const PLAY = 'https://play.dlsite.com';
const USERBUY =
  'https://www.dlsite.com/home/mypage/userbuy/=/type/all/start/all/sort/1/order/1/page/1';

async function playAuthorized(s) {
  const res = await s.fetch(`${PLAY}/api/authorize`, {
    credentials: 'include',
    headers: { Accept: 'application/json' }
  });
  const text = await res.text();
  let account = null;
  try {
    account = JSON.parse(text).account_id ?? null;
  } catch {
    /* 配列や HTML が返ることがある */
  }
  return { status: res.status, account, head: text.slice(0, 80).replace(/\s+/g, ' ') };
}

async function wwwLoggedIn(s) {
  const res = await s.fetch(USERBUY, { credentials: 'include', headers: { Accept: 'text/html' } });
  const html = await res.text();
  return {
    status: res.status,
    marker: html.includes('page_total') || html.includes('buy_date'),
    loginPage: html.includes('login.dlsite.com')
  };
}

app.whenReady().then(async () => {
  const real = session.fromPartition('persist:dlsite');
  const cold = session.fromPartition(`cold-${Date.now()}`);

  // play 用以外の Cookie を写す＝「play だけ未確立」の再現
  const cookies = await real.cookies.get({});
  let copied = 0;
  for (const c of cookies) {
    if ((c.domain || '').includes('play.dlsite.com')) continue;
    const host = (c.domain || '').replace(/^\./, '');
    try {
      await cold.cookies.set({
        url: `https://${host}${c.path || '/'}`,
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        expirationDate: c.expirationDate
      });
      copied++;
    } catch {
      /* 写せない Cookie は飛ばす */
    }
  }
  console.log(`Cookie を ${copied}/${cookies.length} 個コピー（play 用は除外）`);

  console.log('\n1) いきなり play:', JSON.stringify(await playAuthorized(cold)));
  const warm = await cold.fetch(`${PLAY}/`, { credentials: 'include', headers: { Accept: 'text/html' } });
  const warmText = await warm.text();
  console.log(`2) play トップで起こす: HTTP ${warm.status} / ${warmText.length} bytes`);
  console.log('3) もう一度 play:', JSON.stringify(await playAuthorized(cold)));
  console.log('4) www 購入履歴  :', JSON.stringify(await wwwLoggedIn(cold)));

  app.quit();
});
