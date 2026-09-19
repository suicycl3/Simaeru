// Read only the split HTML page; never request the file links.
const { app, session } = require('electron');
const { userDataDir } = require('./app-paths.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
app.setPath('userData', userDataDir(app.getPath('appData')));
app.whenReady().then(async () => {
  try {
    const res = await session.fromPartition('persist:dlsite').fetch(
      'https://www.dlsite.com/home/download/split/=/product_id/RJ370677.html',
      { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(20000) }
    );
    if (!res.headers.get('content-type')?.includes('text/html')) {
      await res.body?.cancel();
      throw new Error('Not HTML');
    }
    const html = await res.text();
    fs.writeFileSync(path.join(os.tmpdir(), 'dlsite-split-RJ370677.html'), html);
    console.log(JSON.stringify({ status: res.status, login: res.url.includes('login.dlsite.com'), anchors: html.match(/<a\b[^>]*href=[^>]+>[\s\S]*?<\/a>/gi)?.filter(a => /download/.test(a)).slice(-30) }));
  } catch (err) { console.error(err.message); process.exitCode = 1; }
  finally { app.quit(); }
});
