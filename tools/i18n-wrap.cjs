/**
 * 画面の日本語の文言を t('…') で包む（多言語化の一括変換。変換したあとは人が差分を確かめる）。
 *   node tools/i18n-wrap.cjs [--dry] <file...>
 *
 * - JSX の文字と式のひと続き（`WAV {n} 件（{size}）`）は1つの文にまとめて t('WAV {n} 件（{size}）', { n, size }) にする
 * - 文字列・テンプレート文字列は t('…') / t('…{0}…', { 0: 式 }) にする
 * - 比較・includes/test などの照合、import、型、オブジェクトのキー、console は変えない
 * 翻訳の辞書（src/shared/i18n/en.ts）のキーは、この日本語そのもの。
 */
const fs = require('node:fs');
const ts = require('typescript');

const JA = /[぀-ヿ㐀-鿿！-｠]/;
const MATCH_METHODS = new Set(['includes', 'startsWith', 'endsWith', 'test', 'match', 'replace', 'split', 'indexOf', 'lastIndexOf', 'has', 'search', 'localeCompare']);
const SKIP_ATTRS = new Set(['key', 'className', 'value', 'id', 'type', 'name', 'htmlFor', 'role']);

const args = process.argv.slice(2);
const dry = args.includes('--dry');
// --user: 画面に出る文（エラー・進捗・message などの値）だけを包む（メインプロセス向け。サイトのデータの日本語は包まない）
const userOnly = args.includes('--user');
// --lines=12,34: その行で始まる文字列だけを包む（1ファイルずつ指定する）
const onlyLines = (args.find((a) => a.startsWith('--lines=')) ?? '').slice(8).split(',').filter(Boolean).map(Number);
const USER_PROPS = new Set(['message', 'error', 'title', 'reason', 'label', 'notes', 'displayName', 'text', 'detail']);
const USER_CALLS = /(^|\.)(progress|onProgress|showErrorBox|updateJob)$/;
const files = args.filter((a) => !a.startsWith('--'));

function quote(s) {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n')}'`;
}

/** JSX の文字の空白の扱い（React と同じ: 改行を含む空白は詰める） */
function jsxTextValue(raw) {
  const lines = raw.split(/\r?\n/);
  if (lines.length === 1) return raw;
  const out = [];
  lines.forEach((line, i) => {
    let l = line;
    if (i > 0) l = l.replace(/^\s+/, '');
    if (i < lines.length - 1) l = l.replace(/\s+$/, '');
    if (l) out.push(l);
  });
  // 日本語の文の途中で改行しているときは、空白を挟まずにつなぐ
  return out.reduce((acc, l) => (acc && /[^ -~]$/.test(acc) && /^[^ -~]/.test(l) ? acc + l : acc ? `${acc} ${l}` : l), '');
}

function hasJsx(node) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

let changedFiles = 0;
let wrapped = 0;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let count = 0;

  const isT = (call) => ts.isCallExpression(call) && call.expression.getText(sf) === 't';

  /** 画面に出る文の場所か（--user のとき） */
  const userFacing = (node) => {
    for (let n = node.parent; n && !ts.isSourceFile(n); n = n.parent) {
      if (ts.isNewExpression(n) && /Error$/.test(n.expression.getText(sf))) return true;
      if (ts.isCallExpression(n) && USER_CALLS.test(n.expression.getText(sf))) return true;
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && USER_PROPS.has(n.name.text)) return true;
      if (ts.isReturnStatement(n)) {
        const fn = ts.findAncestor(n, (a) => ts.isFunctionDeclaration(a) || ts.isArrowFunction(a) || ts.isFunctionExpression(a) || ts.isMethodDeclaration(a));
        const name = fn && fn.name ? fn.name.getText(sf) : fn && ts.isVariableDeclaration(fn.parent) ? fn.parent.name.getText(sf) : '';
        if (/(Error|Reason|Message)$/i.test(name)) return true;
      }
      if (ts.isBlock(n) || ts.isSourceFile(n)) return false;
    }
    return false;
  };

  const skipLiteral = (node) => {
    const p = node.parent;
    if (!p) return true;
    for (let n = p; n && !ts.isSourceFile(n); n = n.parent) {
      if (ts.isCallExpression(n) && /^console\./.test(n.expression.getText(sf))) return true;
    }
    if (userOnly && !userFacing(node)) return true;
    if (onlyLines.length && !onlyLines.includes(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1)) return true;
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
    if (ts.isLiteralTypeNode(p)) return true;
    if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)) && p.name === node) return true;
    if (ts.isComputedPropertyName(p) || ts.isElementAccessExpression(p)) return true;
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return true;
    if (ts.isCaseClause(p)) return true;
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
      if (isT(p)) return true;
      const callee = p.expression.getText(sf);
      if (/^console\./.test(callee) || callee === 'RegExp' || callee === 'require') return true;
      if (ts.isPropertyAccessExpression(p.expression) && MATCH_METHODS.has(p.expression.name.text)) return true;
    }
    if (ts.isJsxAttribute(p) && SKIP_ATTRS.has(p.name.getText(sf))) return true;
    return false;
  };

  /** 式を「名前付きの差し込み」にするときの名前 */
  const nameOf = (expr, used, index) => {
    let name = null;
    if (ts.isIdentifier(expr)) name = expr.text;
    else if (ts.isPropertyAccessExpression(expr)) name = expr.name.text;
    if (!name || !/^[A-Za-z_]\w*$/.test(name)) name = String(index);
    let n = name;
    let k = 2;
    while (used.has(n)) n = `${name}${k++}`;
    used.add(n);
    return n;
  };

  const varsText = (pairs) =>
    `{ ${pairs.map(([n, e]) => (n === e ? n : `${/^\d/.test(n) ? n : n}: ${e}`)).join(', ')} }`;

  /** node の書き換え後の文字列（node の前の空白・コメントも含む＝ full text） */
  const emit = (node) => {
    const lead = src.slice(node.getFullStart(), node.getStart(sf));
    // 文字列
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && JA.test(node.text) && !skipLiteral(node)) {
      count++;
      const call = `t(${quote(node.text)})`;
      return lead + (ts.isJsxAttribute(node.parent) ? `{${call}}` : call);
    }
    // テンプレート文字列
    if (ts.isTemplateExpression(node) && !skipLiteral(node)) {
      const texts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
      if (texts.some((x) => JA.test(x))) {
        count++;
        const used = new Set();
        const pairs = [];
        let msg = node.head.text;
        node.templateSpans.forEach((span, i) => {
          const name = nameOf(span.expression, used, i);
          pairs.push([name, emit(span.expression).trim()]);
          msg += `{${name}}${span.literal.text}`;
        });
        return `${lead}t(${quote(msg)}, ${varsText(pairs)})`;
      }
    }
    // JSDoc は最初の子の前のコメントとして出るので、子として数えない
    const children = node.getChildren(sf).filter((c) => !ts.isJSDoc(c));
    if (children.length === 0) return src.slice(node.getFullStart(), node.getEnd());
    let pos = node.getFullStart();

    // JSX の子要素: 文字と式のひと続きを1つの文にまとめる
    if (node.kind === ts.SyntaxKind.SyntaxList && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      let out = '';
      let i = 0;
      const groupable = (n) => ts.isJsxText(n) || (ts.isJsxExpression(n) && !!n.expression && !hasJsx(n.expression));
      while (i < children.length) {
        const c = children[i];
        if (!groupable(c)) {
          out += src.slice(pos, Math.max(pos, c.getFullStart())) + emit(c);
          pos = c.getEnd();
          i++;
          continue;
        }
        let j = i;
        while (j < children.length && groupable(children[j])) j++;
        const run = children.slice(i, j);
        const hasJa = run.some((n) => ts.isJsxText(n) && JA.test(n.getText(sf)));
        if (!hasJa) {
          for (const n of run) {
            out += src.slice(pos, Math.max(pos, n.getFullStart())) + emit(n);
            pos = n.getEnd();
          }
          i = j;
          continue;
        }
        let head = '';
        let tail = '';
        const parts = [];
        const used = new Set();
        const pairs = [];
        run.forEach((n, k) => {
          const full = src.slice(Math.max(pos, n.getFullStart()), n.getEnd());
          if (ts.isJsxText(n)) {
            let raw = full;
            if (k === 0) {
              head = raw.match(/^\s*/)[0];
              raw = raw.slice(head.length);
            }
            if (k === run.length - 1) {
              tail = raw.match(/\s*$/)[0];
              raw = raw.slice(0, raw.length - tail.length);
            }
            parts.push(jsxTextValue(raw));
          } else {
            if (k === 0) head = src.slice(Math.max(pos, n.getFullStart()), n.getStart(sf));
            const name = nameOf(n.expression, used, pairs.length);
            pairs.push([name, emit(n.expression).trim()]);
            parts.push(`{${name}}`);
          }
          pos = n.getEnd();
        });
        count++;
        const msg = parts.join('');
        out += `${head}{t(${quote(msg)}${pairs.length ? `, ${varsText(pairs)}` : ''})}${tail}`;
        i = j;
      }
      return out;
    }

    let out = '';
    for (const c of children) {
      out += src.slice(pos, Math.max(pos, c.getFullStart())) + emit(c);
      pos = Math.max(pos, c.getEnd());
    }
    return out;
  };

  // SourceFile の子（文の並びと EOF）の前の空白・コメントも emit が含むので、これで全体になる
  let result = emit(sf);
  if (count === 0) continue;

  // import { t } を足す
  if (!/import \{[^}]*[{,\s]t[,\s}][^}]*\}? ?from '@shared\/i18n';|import \{ t \} from '@shared\/i18n';/.test(result)) {
    const imports = [...result.matchAll(/^import [\s\S]*?;\s*$/gm)];
    const lastImport = imports[imports.length - 1];
    const at = lastImport ? lastImport.index + lastImport[0].length : -1;
    result = at >= 0 ? `${result.slice(0, at)}
import { t } from '@shared/i18n';${result.slice(at)}` : `import { t } from '@shared/i18n';

${result}`;
  }
  wrapped += count;
  changedFiles++;
  console.log(`${String(count).padStart(4)}  ${file}`);
  if (!dry) fs.writeFileSync(file, result, 'utf8');
}
console.log(`合計 ${wrapped} 箇所 / ${changedFiles} ファイル${dry ? '（dry run）' : ''}`);
