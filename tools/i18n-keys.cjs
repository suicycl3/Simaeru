/**
 * t('…') に渡している文言を集め、辞書（src/shared/i18n/en.ts・zh.ts）に無いものを出す。
 *   node tools/i18n-keys.cjs            … 辞書に無い文言の一覧
 *   node tools/i18n-keys.cjs --unused   … 辞書にあるが使っていない文言
 *   node tools/i18n-keys.cjs --check    … 足りない文言・差し込み名の食い違いがあれば失敗（テスト用）
 *
 * t(変数) で訳すもの（区分・種別の表、版のラベル、保存済みの呼び名）は EXTRA に並べる。
 */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const EXTRA = [
  // @shared/types の表（画面で t() を通す）
  ...Object.values(require('./i18n-extra.json'))
].flat();

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/devMock|\.d\.ts$|i18n[\\/](en|zh)\.ts$/.test(full)) out.push(full);
  }
  return out;
}

const keys = new Map();
for (const file of walk(path.join(root, 'src'))) {
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(sf) === 't' && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      const key = node.arguments[0].text;
      if (!keys.has(key)) keys.set(key, `${path.relative(root, file)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
for (const k of EXTRA) if (!keys.has(k)) keys.set(k, 'extra');

// 辞書を読む（TS をそのまま require できないので、オブジェクトの部分だけを取り出して評価する）
const readDict = (lang) => {
  const src = fs.readFileSync(path.join(root, `src/shared/i18n/${lang}.ts`), 'utf8');
  const body = src.slice(src.indexOf('{', src.indexOf(`export const ${lang}`)), src.lastIndexOf('}') + 1);
  return Function(`return (${body});`)();
};
const dicts = { en: readDict('en'), zh: readDict('zh') };
const langArg = process.argv.find((a) => a.startsWith('--lang='));
const langs = langArg ? [langArg.slice(7)] : Object.keys(dicts);

const args = process.argv.slice(2);
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
if (args.includes('--unused')) {
  for (const lang of langs) for (const k of Object.keys(dicts[lang])) if (!keys.has(k)) console.log(`${lang} ${JSON.stringify(k)}`);
} else {
  let failed = false;
  for (const lang of langs) {
    const dict = dicts[lang];
    const missing = [...keys].filter(([k]) => !(k in dict));
    const mismatched = [...keys].filter(([k]) => k in dict && placeholders(k) !== placeholders(dict[k]));
    if (args.includes('--check')) {
      for (const [k, where] of missing) console.log(`[${lang}] 訳が無い: ${JSON.stringify(k)}  (${where})`);
      for (const [k] of mismatched) console.log(`[${lang}] 差し込み名が違う: ${JSON.stringify(k)} → ${JSON.stringify(dict[k])}`);
      console.log(`[${lang}] 文言 ${keys.size} / 訳が無い ${missing.length} / 差し込み名の食い違い ${mismatched.length}`);
      if (missing.length || mismatched.length) failed = true;
    } else {
      for (const [k, where] of missing) console.log(`  ${JSON.stringify(k)}: '', // [${lang}] ${where}`);
      console.error(`[${lang}] 文言 ${keys.size} / 訳が無い ${missing.length}`);
    }
  }
  if (args.includes('--check')) process.exit(failed ? 1 : 0);
}
