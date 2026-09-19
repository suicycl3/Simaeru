/**
 * 使っているソフトウェアのライセンス一覧（THIRD_PARTY_NOTICES.md / THIRD_PARTY_NOTICES.en.md）を
 * node_modules の LICENSE から作り直す。
 *   node tools/gen-notices.js
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const deps = [
  ['electron', 'アプリの実行環境（Chromium・Node.js を含む）', 'App runtime (includes Chromium and Node.js)'],
  ['better-sqlite3', 'ライブラリ（SQLite）', 'Library database (SQLite)'],
  ['bindings', 'better-sqlite3 の読み込み', 'Loads better-sqlite3'],
  ['file-uri-to-path', 'bindings の依存', 'Dependency of bindings'],
  ['react', '画面', 'User interface'],
  ['react-dom', '画面', 'User interface'],
  ['scheduler', 'react-dom の依存', 'Dependency of react-dom'],
  ['pdfjs-dist', 'PDF の表示（台本・PDF ビューア）', 'PDF rendering (scripts and PDF viewer)']
];

const TEXT = {
  ja: {
    file: 'THIRD_PARTY_NOTICES.md',
    title: '# 使っているソフトウェアのライセンス（THIRD_PARTY_NOTICES）',
    intro: [
      'Simaeru が組み込んで配布・実行するソフトウェアと、そのライセンスです。',
      'このファイルは `node tools/gen-notices.js` で node_modules の LICENSE から作り直せます。'
    ],
    bundled: '## 組み込んでいるもの',
    bundledHead: '| パッケージ | 版 | ライセンス | 用途 |',
    noLicense: '(LICENSE ファイルなし)',
    chromium: [
      'Electron に含まれる Chromium などのライセンスは、Electron 本体の `LICENSES.chromium.html`',
      '（`node_modules/electron/dist/LICENSES.chromium.html`、配布物では実行ファイルと同じフォルダ）にあります。'
    ],
    external: '## 組み込んでいないもの（外部ツール）',
    externalIntro: [
      '次のツールはアプリに**同梱していません**。PC に入っているものを使うか、設定画面の「ツール」から',
      'ユーザーの操作で配布元より取得して `%APPDATA%/simaeru/tools` に置きます。',
      'アプリはこれらを別プロセスとして呼び出すだけで、リンクしていません。各ツールのライセンス文書は、取得したフォルダに一緒に置かれます。'
    ],
    externalHead: '| ツール | ライセンス | 取得元 | 用途 |',
    tools: [
      '| 7-Zip | GNU LGPL 2.1 以降（unRAR コードは unRAR ライセンスの制限あり、一部 BSD 3-clause） | https://github.com/ip7z/7zip | 展開・zip の作り直し・rar/7z の読み出し |',
      '| FFmpeg（LGPL ビルド） | GNU LGPL 2.1 以降 | https://github.com/BtbN/FFmpeg-Builds | WAV → FLAC 変換と検証 |',
      '| NeeView | MIT | https://github.com/neelabo/NeeView | 漫画・CG 集の外部ビューア |'
    ],
    texts: '## ライセンス本文'
  },
  en: {
    file: 'THIRD_PARTY_NOTICES.en.md',
    title: '# Third-party software licenses (THIRD_PARTY_NOTICES)',
    intro: [
      'Software that Simaeru includes and runs, and its licenses.',
      'This file is regenerated from the LICENSE files in node_modules with `node tools/gen-notices.js`.'
    ],
    bundled: '## Included software',
    bundledHead: '| Package | Version | License | Used for |',
    noLicense: '(no LICENSE file)',
    chromium: [
      'Licenses for Chromium and other components bundled with Electron are in Electron\'s `LICENSES.chromium.html`',
      '(`node_modules/electron/dist/LICENSES.chromium.html`; in the distribution it sits next to the executable).'
    ],
    external: '## Not included (external tools)',
    externalIntro: [
      'The following tools are **not bundled** with the app. A copy already installed on the PC is used, or the user downloads it',
      'from the official release via Settings > Tools into `%APPDATA%/simaeru/tools`.',
      'The app only runs them as separate processes and does not link to them. Each tool\'s license documents are placed in the same folder.'
    ],
    externalHead: '| Tool | License | Source | Used for |',
    tools: [
      '| 7-Zip | GNU LGPL 2.1 or later (unRAR code under the unRAR license restriction, parts BSD 3-clause) | https://github.com/ip7z/7zip | Extracting, rebuilding zips, reading rar/7z |',
      '| FFmpeg (LGPL build) | GNU LGPL 2.1 or later | https://github.com/BtbN/FFmpeg-Builds | WAV → FLAC conversion and verification |',
      '| NeeView | MIT | https://github.com/neelabo/NeeView | External viewer for manga and CG collections |'
    ],
    texts: '## License texts'
  }
};

const packages = deps.map(([name, ja, en]) => {
  const dir = path.join(root, 'node_modules', name);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const license = typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license);
  const file = fs.readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
  return { name, version: pkg.version, license, purpose: { ja, en }, text: file ? fs.readFileSync(path.join(dir, file), 'utf8').trim() : null };
});

for (const [lang, T] of Object.entries(TEXT)) {
  const lines = [T.title, '', ...T.intro, '', T.bundled, '', T.bundledHead, '|---|---|---|---|'];
  for (const p of packages) lines.push(`| ${p.name} | ${p.version} | ${p.license} | ${p.purpose[lang]} |`);
  lines.push('', ...T.chromium, '', T.external, '', ...T.externalIntro, '', T.externalHead, '|---|---|---|---|', ...T.tools, '', T.texts);
  for (const p of packages) {
    lines.push('', `### ${p.name} ${p.version}`, '', '```', p.text ?? T.noLicense, '```');
  }
  fs.writeFileSync(path.join(root, T.file), lines.join('\n') + '\n');
  console.log('written', T.file, lines.length);
}
