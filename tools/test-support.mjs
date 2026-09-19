import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
export function testBuild() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mylibrary-test-'));
  const stub = path.join(dir, 'electron.cjs');
  fs.writeFileSync(stub, 'module.exports = { session: {}, protocol: {}, shell: {}, app: {} };');
  let n = 0;
  return {
    load(entry) {
      const outfile = path.join(dir, `${n++}.cjs`);
      buildSync({ entryPoints: [path.join(root, entry)], outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
        alias: { '@shared': path.join(root, 'src/shared'), electron: stub }, logLevel: 'error' });
      return require(outfile);
    },
    close() { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}
