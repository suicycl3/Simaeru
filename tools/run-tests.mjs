import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const mode = process.argv[2] ?? 'all';
if (!['all', 'unit', 'integration'].includes(mode)) throw new Error(`Unknown test mode: ${mode}`);
const integration = new Set(['test-credentials.js', 'test-library-local.js', 'test-postprocess.js', 'test-ui-review.js', 'test-library-backup.js', 'test-repository.js', 'test-download-parallel.js']);
const source = import.meta.dirname;
const names = fs.readdirSync(source).filter(n => /^test-.*\.(?:js|mjs)$/.test(n) && n !== 'test-support.mjs')
  .filter(n => mode === 'unit' ? !integration.has(n) : mode === 'integration' ? integration.has(n) : true).sort();
const logDir = path.join(root, 'out', 'test-results', mode);
fs.mkdirSync(logDir, { recursive: true });
const results = [];
// 既存テストの一時出力やツールキャッシュが衝突しないよう、順番に実行する。
for (const name of names) {
  const started = Date.now();
  const runtime = integration.has(name) ? require('electron') : process.execPath;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise(resolve => {
    const child = spawn(runtime, [path.join(source, name)], { cwd: root, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let output = '', timedOut = false;
    child.stdout.on('data', b => { output += b; });
    child.stderr.on('data', b => { output += b; });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    }, 300_000);
    child.on('error', err => { clearTimeout(timer); resolve({code: null, output: output + err.stack, timedOut}); });
    child.on('close', code => { clearTimeout(timer); resolve({code, output, timedOut}); });
  });
  const skipped = result.output.split(/\r?\n/).filter(line => /飛ばします|検証用HTMLなし|キャプチャなし|キャプチャにありません/.test(line));
  const status = result.timedOut ? 'TIMEOUT' : result.code !== 0 ? 'FAIL' : skipped.length ? 'PARTIAL' : 'PASS';
  fs.writeFileSync(path.join(logDir, `${name}.log`), result.output);
  results.push({name,status,exitCode:result.code,seconds:Math.round((Date.now()-started)/100)/10,skipped});
  console.log(`${status} ${name} (${results.at(-1).seconds}s)`);
  if (status !== 'PASS') console.log(result.output.slice(-3500));
}
fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify({ mode, at: new Date().toISOString(), results }, null, 2));
console.log(`\n${results.filter(r=>r.status==='PASS').length}/${results.length} passed; results: ${path.relative(root,logDir)}`);
if (!results.length || results.some(r=>r.status!=='PASS')) process.exitCode = 1;
