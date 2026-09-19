/**
 * 翻訳関数 t と同じ名前のローカル変数・引数（`(t) => …` や `const t = setTimeout(…)`）を別名にする。
 *   node tools/i18n-unshadow.cjs <tsconfig> <file...>
 * 名前の付け替えは TypeScript の言語サービスで行うので、参照先だけが変わる。
 */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const [tsconfigPath, ...targets] = process.argv.slice(2);
const cfg = ts.getParsedCommandLineOfConfigFile(path.resolve(tsconfigPath), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
const files = new Map(cfg.fileNames.map((f) => [path.resolve(f), { version: 0, text: fs.readFileSync(f, 'utf8') }]));
const host = {
  getScriptFileNames: () => [...files.keys()],
  getScriptVersion: (f) => String(files.get(path.resolve(f))?.version ?? 0),
  getScriptSnapshot: (f) => {
    const entry = files.get(path.resolve(f));
    const text = entry ? entry.text : fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined;
    return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
  },
  getCurrentDirectory: () => process.cwd(),
  getCompilationSettings: () => cfg.options,
  getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories
};
const service = ts.createLanguageService(host, ts.createDocumentRegistry());

let renamed = 0;
for (const target of targets.map((f) => path.resolve(f))) {
  for (let guard = 0; guard < 200; guard++) {
    const entry = files.get(target);
    const sf = service.getProgram().getSourceFile(target);
    let found = null;
    const visit = (node) => {
      if (found) return;
      const isDecl =
        (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 't';
      if (isDecl) {
        found = node.name;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (!found) break;
    const locs = service.findRenameLocations(target, found.getStart(sf), false, false, { providePrefixAndSuffixTextForRename: false }) ?? [];
    const edits = locs.filter((l) => path.resolve(l.fileName) === target).sort((a, b) => b.textSpan.start - a.textSpan.start);
    let text = entry.text;
    for (const e of edits) text = text.slice(0, e.textSpan.start) + 'tItem' + text.slice(e.textSpan.start + e.textSpan.length);
    files.set(target, { version: entry.version + 1, text });
    renamed++;
  }
  fs.writeFileSync(target, files.get(target).text, 'utf8');
}
console.log(`付け替え ${renamed} 件`);
