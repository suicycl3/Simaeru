// Read metadata only. Never extract or modify the supplied archives.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-encoding-probe-'));
try {
  const modules = {};
  for (const name of ['zipReader', 'sevenZip']) {
    const outfile = path.join(temp, `${name}.cjs`);
    buildSync({ entryPoints: [path.join(root, `src/main/archive/${name}.ts`)], outfile,
      bundle: true, platform: 'node', format: 'cjs', alias: { '@shared': path.join(root, 'src/shared') } });
    modules[name] = require(outfile);
  }
  for (const file of process.argv.slice(2)) {
    const index = await modules.zipReader.readZipIndex(file);
    const listed = await modules.sevenZip.listArchive('C:\\Program Files\\7-Zip\\7z.exe', file);
    const names = new Set(listed.filter(e => !e.isDir).map(e => e.path));
    const entries = index.entries.filter(e => !e.isDir);
    const matches = entries.filter(e => names.has(e.name)).length;
    console.log(JSON.stringify({ file: path.basename(file), codePage: index.legacyCodePage, files: entries.length, matched: matches }));
    if (matches !== entries.length || names.size !== entries.length) process.exitCode = 1;
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
