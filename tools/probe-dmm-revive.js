/**
 * 「APIセッション(ec_session)だけ切れた」状態を作り、通常ページを1回読むだけで
 * 自動ログインCookie(login_secure_id)からセッションが復活するかを確かめる。
 *
 * 本物の persist:dmm は読み取るだけ。判定は使い捨てパーティションで行う。
 *   npx electron tools/probe-dmm-revive.js
 * ※ アプリを終了してから実行すること
 */
const path = require('node:path');
const { userDataDir } = require('./app-paths.cjs');
const { app, session } = require('electron');

app.setPath('userData', userDataDir(app.getPath('appData')));

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36';
const MYLIB_API =
  'https://www.dmm.co.jp/dc/doujin/api/mylibraries/?page=1&sort=purchasedate_desc&genre=all&limit=1';
const MYLIB_PAGE = 'https://www.dmm.co.jp/dc/-/mylibrary/';

/** 期限切れとみなして落とすCookie（＝2時間で切れるAPIセッション） */
const SESSION_COOKIES = ['ec_session', 'laravel_session', 'INT_SESID', 'XSRF-TOKEN'];

async function probeApi(s) {
  const res = await s.fetch(MYLIB_API, {
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': UA,
      Referer: MYLIB_PAGE
    }
  });
  const text = await res.text();
  let errorCode = null;
  try {
    errorCode = JSON.parse(text).error_code ?? null;
  } catch {
    /* HTML が返ることがある */
  }
  return { status: res.status, errorCode, head: text.slice(0, 90).replace(/\s+/g, ' ') };
}

app.whenReady().then(async () => {
  const real = session.fromPartition('persist:dmm');
  const temp = session.fromPartition(`revive-${Date.now()}`);

  const cookies = await real.cookies.get({});
  let copied = 0;
  let dropped = 0;
  for (const c of cookies) {
    if (SESSION_COOKIES.includes(c.name)) {
      dropped++;
      continue; // 期限切れの再現：APIセッションだけ持っていかない
    }
    const host = (c.domain || '').replace(/^\./, '');
    try {
      await temp.cookies.set({
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
      /* 写せないものは飛ばす */
    }
  }
  console.log(`Cookie ${copied} 個コピー / セッション系 ${dropped} 個を落とした`);
  const before = await temp.cookies.get({ name: 'login_secure_id' });
  console.log('login_secure_id の有無:', before.length > 0);

  console.log('\n1) セッション無しでAPI :', JSON.stringify(await probeApi(temp)));

  const page = await temp.fetch(MYLIB_PAGE, {
    credentials: 'include',
    headers: { Accept: 'text/html', 'User-Agent': UA }
  });
  const html = await page.text();
  console.log(
    `2) 通常ページを1回読む: HTTP ${page.status} / ${html.length} bytes / ログイン画面? ${html.includes('service/login')}`
  );
  const after = await temp.cookies.get({ name: 'ec_session' });
  console.log('   ec_session が再発行されたか:', after.length > 0);

  console.log('3) もう一度API        :', JSON.stringify(await probeApi(temp)));
  app.quit();
});
