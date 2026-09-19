/**
 * DLsite の作品ページを実セッションで取得し、パーサの結果を見る。
 *   npx electron tools/probe-dlsite-store.js pro VJ000007
 * ※ アプリを終了してから実行すること（userData を共有するため）
 *
 * 取得したHTMLは %TEMP%\dlsite-work-<workno>.html に残るので、
 * そのあと node tools/test-dlsite-store.mjs でも一緒に検証される。
 */
const fs = require('node:fs');
const { userDataDir } = require('./app-paths.cjs');
const os = require('node:os');
const path = require('node:path');
const { app, session } = require('electron');
const esbuild = require('esbuild');

const SITE = process.argv[2] || 'pro';
const WORKNO = process.argv[3] || 'VJ000007';

app.setPath('userData', userDataDir(app.getPath('appData')));

const outFile = path.join(os.tmpdir(), 'dlsiteStore.probe.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'main', 'sites', 'dlsite', 'storeParse.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'error'
});
const { parseDlsiteWorkPage } = require(outFile);

app.whenReady().then(async () => {
  try {
    const url = `https://www.dlsite.com/${SITE}/work/=/product_id/${WORKNO}.html`;
    const res = await session.fromPartition('persist:dlsite').fetch(url, {
      credentials: 'include',
      headers: { Accept: 'text/html', Referer: 'https://www.dlsite.com/' }
    });
    const html = await res.text();
    const file = path.join(os.tmpdir(), `dlsite-work-${WORKNO}.html`);
    fs.writeFileSync(file, html, 'utf8');
    console.log(`\n== ${url}\n   HTTP ${res.status} / ${html.length} bytes / 保存: ${file}`);

    const meta = parseDlsiteWorkPage(html);
    console.log('  説明文  :', meta.description ? `${meta.description.length}文字` : '(なし)');
    if (meta.description) console.log('    ', meta.description.slice(0, 120).replace(/\n/g, ' '));
    console.log('  スタッフ:', meta.creators.map((c) => `${c.role}=${c.name}`).join(' / ') || '(なし)');
    console.log('  ジャンル:', meta.tags.join('・') || '(なし)');
    console.log('  容量    :', meta.fileSizeText ?? '(なし)');
    console.log('  販売日  :', meta.releasedAt ?? '(なし)');
    console.log('  シリーズ:', meta.seriesName ?? '(なし)');
  } catch (err) {
    console.error('PROBE_ERROR', err && err.stack ? err.stack : err);
  } finally {
    app.quit();
  }
});
