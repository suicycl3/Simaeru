/**
 * 配布用のポータブル版を作る。
 *   npm run package
 *
 * 展開してそのまま `Simaeru.exe` を実行できる形にする（インストール不要）。
 * 中身は `out/`（electron-vite の成果物）と、実行時に要る node_modules だけ。
 * ソース・道具・文書は入れない（`ignore` で外す）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { packager } from '@electron/packager';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outDir = path.join(root, 'dist');

// out/ が無い・古いまま配るのを防ぐ
const mainFile = path.join(root, 'out', 'main', 'index.js');
if (!fs.existsSync(mainFile)) {
  console.error('out/ がありません。先に `npm run build` を実行してください。');
  process.exit(1);
}

/** 配布物に入れないもの。node_modules は packager が devDependencies を落としてくれる */
const ignore = [
  /^\/src($|\/)/,
  /^\/tools($|\/)/,
  /^\/docs($|\/)/,
  /^\/dist($|\/)/,
  /^\/\.git($|\/)/,
  /^\/\.vscode($|\/)/,
  /^\/\.claude($|\/)/,
  /^\/out\/test($|\/)/,
  /^\/out\/test-results($|\/)/,
  /^\/out\/private-tests($|\/)/,
  /^\/tsconfig.*\.json$/,
  /^\/electron\.vite\.config\.ts$/,
  /^\/Simaeru\.bat$/,
  /\.tsbuildinfo$/,
  /^\/README\.zh-CN\.md$/
];

const appPaths = await packager({
  dir: root,
  out: outDir,
  name: pkg.productName,
  appVersion: pkg.version,
  platform: 'win32',
  arch: 'x64',
  overwrite: true,
  prune: true,
  asar: false, // better-sqlite3 のネイティブモジュールをそのまま置く
  ignore,
  appCopyright: 'Copyright (c) 2026 suicycl3',
  win32metadata: {
    CompanyName: 'suicycl3',
    FileDescription: pkg.description,
    ProductName: pkg.productName
  }
});

const appDir = appPaths[0];
const modules = path.join(appDir, 'resources', 'app', 'node_modules');
const drop = (target, why) => {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`外した: ${path.relative(appDir, target)}（${why}）`);
};

// pdf.js は画面側の束ね（vite）に入っている。cmaps と標準フォントも out/renderer に書き出し済みなので、
// node_modules の実体は実行時に要らない。@napi-rs/canvas はその pdfjs-dist の依存（Node 用の描画）
drop(path.join(modules, 'pdfjs-dist'), '画面側に束ねてある');
drop(path.join(modules, '@napi-rs'), 'pdfjs-dist の Node 用依存');

// better-sqlite3 は出来上がった .node だけあればよい。中間生成物とソースは外す
const sqlite = path.join(modules, 'better-sqlite3');
if (fs.existsSync(sqlite)) {
  drop(path.join(sqlite, 'deps'), 'SQLite のソース');
  drop(path.join(sqlite, 'src'), 'ソース');
  const release = path.join(sqlite, 'build', 'Release');
  for (const entry of fs.existsSync(release) ? fs.readdirSync(release, { withFileTypes: true }) : []) {
    if (entry.isFile() && entry.name.endsWith('.node')) continue;
    drop(path.join(release, entry.name), 'ビルドの中間生成物');
  }
  for (const entry of fs.readdirSync(path.join(sqlite, 'build'), { withFileTypes: true })) {
    if (entry.name === 'Release') continue;
    drop(path.join(sqlite, 'build', entry.name), 'ビルドの中間生成物');
  }
}

// 入っていないと「このアプリについて」のライセンス一覧が出ない
for (const name of ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.en.md', 'LICENSE', 'README.md']) {
  const from = path.join(root, name);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(appDir, 'resources', 'app', name));
}

const size = (dir) => {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? size(full) : fs.statSync(full).size;
  }
  return total;
};
console.log(`できました: ${appDir}（${Math.round(size(appDir) / 1024 / 1024)} MB）`);
