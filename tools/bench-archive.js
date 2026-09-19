/**
 * アーカイブから直接読むときの速さを測る（読むだけ。ライブラリには書かない）。
 *   npx electron tools/bench-archive.js [zipのパス ...]
 * 引数が無ければ、ライブラリの zip のうち画像か音声が入っているものを小さい順に最大5本使う。
 *
 * 比べるもの:
 *  - 一覧:   7-Zip（l -slt）  /  自前の zip 読み取り（初回・2回目）
 *  - 1ファイル: 7-Zip を毎回起動（e -so）  /  自前（無圧縮はそのまま・deflate は zlib）
 *  - 参考:   全体を作業フォルダへ展開（x）
 * 結果は %TEMP%\bench-archive.txt にも出す。
 */
const fs = require('node:fs');
const { userDataDir } = require('./app-paths.cjs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { app } = require('electron');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'out', 'test');
fs.mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, 'zipReader.bench.cjs');
esbuild.buildSync({ entryPoints: [path.join(root, 'src/main/archive/zipReader.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'error' });
const { readZipIndex, openEntry, isReadable } = require(outfile);

const SEVEN = ['C:/Program Files/7-Zip/7z.exe', path.join(userDataDir(app.getPath('appData')), 'tools', '7zip', '7z.exe')].find((p) => fs.existsSync(p));
const lines = [];
const log = (s) => {
  console.log(s);
  lines.push(s);
};

const time = async (fn) => {
  const t = process.hrtime.bigint();
  const r = await fn();
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, r };
};

const drain = (stream) =>
  new Promise((resolve, reject) => {
    let n = 0;
    stream.on('data', (c) => (n += c.length));
    stream.on('end', () => resolve(n));
    stream.on('error', reject);
  });

const sevenRead = (zip, entry) =>
  new Promise((resolve, reject) => {
    const child = spawn(SEVEN, ['e', '-so', '-spd', '-bso0', '-bsp0', '-mcp=932', '--', zip, entry.replace(/\//g, '\\')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    drain(child.stdout).then(resolve, reject);
  });

function findZips() {
  const lib = [path.join(os.homedir(), 'Documents', 'Simaeru'), path.join(os.homedir(), 'Documents', 'MyLibrary')].find((p) => fs.existsSync(p)) ?? path.join(os.homedir(), 'Documents', 'Simaeru');
  const out = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.zip$/i.test(e.name)) out.push({ full, size: fs.statSync(full).size });
    }
  };
  if (fs.existsSync(lib)) walk(lib, 0);
  return out.sort((a, b) => a.size - b.size).map((x) => x.full);
}

app.whenReady().then(async () => {
  try {
    const args = process.argv.slice(2).filter((a) => a.toLowerCase().endsWith('.zip'));
    const zips = args.length ? args : findZips();
    log(`7-Zip: ${SEVEN}`);
    let used = 0;
    for (const zip of zips) {
      if (used >= 5) break;
      const cold = await time(() => readZipIndex(zip));
      const index = cold.r;
      const media = index.entries.filter((e) => !e.isDir && /\.(jpe?g|png|webp|gif|wav|mp3|flac|m4a|mp4)$/i.test(e.name) && isReadable(e));
      if (media.length === 0) continue;
      used++;
      const size = fs.statSync(zip).size;
      log(`\n== ${path.basename(path.dirname(zip))} / ${path.basename(zip)}（${(size / 1048576).toFixed(1)} MB・${index.entries.length} エントリ・読み対象 ${media.length}）`);

      const warm = await time(() => readZipIndex(zip));
      const sevenList = await time(() => spawnSync(SEVEN, ['l', '-slt', '-ba', '-sccUTF-8', '-mcp=932', zip], { windowsHide: true, maxBuffer: 1 << 28 }));
      log(`  一覧: 7-Zip ${sevenList.ms.toFixed(0)} ms / 自前 初回 ${cold.ms.toFixed(1)} ms・2回目 ${warm.ms.toFixed(2)} ms`);

      // 画像ビューアでページをめくるのと同じ「1ファイルずつ」を最大20件
      const sample = media.slice(0, 20);
      const bytes = sample.reduce((s, e) => s + e.size, 0);
      const methods = [...new Set(sample.map((e) => (e.method === 0 ? '無圧縮' : 'deflate')))].join('/');
      const viaSeven = await time(async () => {
        for (const e of sample) await sevenRead(zip, e.name);
      });
      const native = await time(async () => {
        let n = 0;
        for (const e of sample) n += await drain(await openEntry(zip, e));
        return n;
      });
      check(native.r === bytes, `自前で読んだバイト数が一致（${native.r} / ${bytes}）`);
      log(`  1ファイルずつ ${sample.length} 件（${(bytes / 1048576).toFixed(1)} MB・${methods}）: 7-Zip 起動 ${viaSeven.ms.toFixed(0)} ms（1件 ${(viaSeven.ms / sample.length).toFixed(1)} ms） / 自前 ${native.ms.toFixed(0)} ms（1件 ${(native.ms / sample.length).toFixed(1)} ms）・${(viaSeven.ms / native.ms).toFixed(1)} 倍速`);

      // 途中から読む（シーク）: 無圧縮ならそのまま切り出せる
      const big = media.filter((e) => e.method === 0).sort((a, b) => b.size - a.size)[0];
      if (big && big.size > 4 * 1048576) {
        const seek = await time(async () => drain(await openEntry(zip, big, { start: big.size - 1048576, end: big.size - 1 })));
        log(`  無圧縮 ${(big.size / 1048576).toFixed(1)} MB の末尾 1MB を読む: ${seek.ms.toFixed(1)} ms`);
      }

      const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-extract-'));
      const extract = await time(() => spawnSync(SEVEN, ['x', '-y', '-bso0', '-bsp0', '-mcp=932', `-o${dest}`, zip], { windowsHide: true }));
      log(`  参考: 全体を展開 ${extract.ms.toFixed(0)} ms`);
      fs.rmSync(dest, { recursive: true, force: true });
    }
    if (used === 0) log('画像や音声の入った zip が見つかりませんでした');
  } catch (err) {
    log(`ERROR ${err && err.stack ? err.stack : err}`);
  } finally {
    fs.writeFileSync(path.join(os.tmpdir(), 'bench-archive.txt'), lines.join('\n'));
    setTimeout(() => app.exit(0), 200);
  }
});

function check(ok, label) {
  log(`  ${ok ? 'ok' : 'NG'} ${label}`);
}
