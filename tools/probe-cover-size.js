/**
 * 表紙画像の「もっと大きい版」があるかを実際に取って確かめる。
 *   npx electron tools/probe-cover-size.js
 *
 * 画像は認証不要なので使い捨てのユーザーデータで動かす（アプリ稼働中でも安全）。
 */
const os = require('node:os');
const path = require('node:path');
const { app, nativeImage, session } = require('electron');

// アプリの userData は触らない（同時起動でDBやキャッシュを壊さないため）
app.setPath('userData', path.join(os.tmpdir(), `cover-probe-${Date.now()}`));

const CANDIDATES = [
  // 同人: 一覧APIが返すのは -100x75 の縮小版
  'https://doujin-assets.dmm.co.jp/digital/cg/d_100005/d_100005pl-100x75.jpg',
  'https://doujin-assets.dmm.co.jp/digital/cg/d_100005/d_100005pl.jpg',
  'https://doujin-assets.dmm.co.jp/digital/cg/d_100005/d_100005pl-540x405.jpg',
  'https://doujin-assets.dmm.co.jp/digital/cg/d_100005/d_100005ps.jpg',
  // PCゲーム: ps(小) に対して pl(大) があるか
  'https://pics.dmm.co.jp/digital/pcgame/cuffs_0017pack/cuffs_0017packps.jpg',
  'https://pics.dmm.co.jp/digital/pcgame/cuffs_0017pack/cuffs_0017packpl.jpg'
];

app.whenReady().then(async () => {
  const s = session.fromPartition(`probe-${Date.now()}`);
  for (const url of CANDIDATES) {
    try {
      const res = await s.fetch(url, { headers: { Accept: 'image/*' } });
      const buf = Buffer.from(await res.arrayBuffer());
      const img = nativeImage.createFromBuffer(buf);
      const size = img.isEmpty() ? null : img.getSize();
      console.log(
        `HTTP ${res.status}  ${String(buf.length).padStart(7)} bytes  ` +
          `${size ? `${size.width}x${size.height}` : '画像として読めず'}  ${url.split('/').pop()}`
      );
    } catch (err) {
      console.log(`失敗: ${url} (${err.message})`);
    }
  }
  app.quit();
});
