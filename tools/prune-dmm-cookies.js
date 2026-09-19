/**
 * www.dmm.co.jp/dc に溜まった巨大Cookieを整理する。
 *
 * `/dc` パスにはランダム名（英数40文字）・800バイト級のCookieが溜まり続け、
 * 合計15KBを超えると nginx が「400 Request Header Or Cookie Too Large」を返す。
 * 認証用（login_secure_id / ec_session など）は名前が決まっているので触らない。
 *
 *   npx electron tools/prune-dmm-cookies.js --dry     … 数えるだけ
 *   npx electron tools/prune-dmm-cookies.js           … 実際に消す（先にバックアップを取る）
 * ※ アプリを終了してから実行すること
 */
const fs = require('node:fs');
const { userDataDir } = require('./app-paths.cjs');
const os = require('node:os');
const path = require('node:path');
const { app, session } = require('electron');

app.setPath('userData', userDataDir(app.getPath('appData')));

const TARGET = 'https://www.dmm.co.jp/dc/-/mylibrary/';
const DRY = process.argv.includes('--dry');
/** 名前が英数40文字だけ = 用途不明の使い捨てCookie。認証系は別名なので巻き込まない */
const JUNK_NAME = /^[A-Za-z0-9]{40}$/;

app.whenReady().then(async () => {
  const s = session.fromPartition('persist:dmm');
  const before = await s.cookies.get({ url: TARGET });
  const size = (list) => list.map((c) => `${c.name}=${c.value}`).join('; ').length;
  console.log(`整理前: ${before.length} 個 / ${size(before)} バイト`);

  const junk = before.filter((c) => JUNK_NAME.test(c.name) && c.value.length > 200);
  console.log(`対象（ランダム名・200バイト超）: ${junk.length} 個 / ${size(junk)} バイト`);

  if (DRY) {
    app.quit();
    return;
  }

  // 戻せるように全部書き出しておく
  const backup = path.join(os.tmpdir(), `dmm-cookies-backup-${Date.now()}.json`);
  fs.writeFileSync(backup, JSON.stringify(await s.cookies.get({}), null, 1), 'utf8');
  console.log('バックアップ:', backup);

  let removed = 0;
  for (const c of junk) {
    const host = (c.domain || '').replace(/^\./, '');
    const url = `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`;
    try {
      await s.cookies.remove(url, c.name);
      removed++;
    } catch (err) {
      console.log(`  消せず: ${c.name} (${err.message})`);
    }
  }
  await s.cookies.flushStore();

  const after = await s.cookies.get({ url: TARGET });
  console.log(`整理後: ${after.length} 個 / ${size(after)} バイト（${removed} 個削除）`);
  app.quit();
});
