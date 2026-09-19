/**
 * 画面の日本語の文言を数える／一覧にする（多言語化の作業用）。
 *   node tools/i18n-scan.cjs [--list] <file...>
 * コメントは数えない。t('…') の中身は「対応済み」として別に数える。
 */
const fs = require('node:fs');
const ts = require('typescript');

const JA = /[぀-ヿ㐀-鿿！-｠]/;
const args = process.argv.slice(2);
const list = args.includes('--list');
const files = args.filter((a) => !a.startsWith('--'));

let total = 0;
let done = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let n = 0;
  let d = 0;
  const visit = (node) => {
    const isText =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node) || ts.isTemplateExpression(node);
    if (isText) {
      const text = node.getText(sf);
      if (JA.test(text)) {
        const parent = node.parent;
        const translated = parent && ts.isCallExpression(parent) && parent.expression.getText(sf) === 't';
        if (translated) d++;
        else {
          n++;
          if (list) console.log(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${text.trim().slice(0, 100)}`);
        }
      }
      if (!ts.isTemplateExpression(node)) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  total += n;
  done += d;
  if (!list) console.log(`${String(n).padStart(4)} 未対応 / ${String(d).padStart(4)} 対応済み  ${file}`);
}
console.log(`合計: 未対応 ${total} / 対応済み ${done}`);
