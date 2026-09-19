import { execFileSync } from 'node:child_process';
import path from 'node:path';
execFileSync(process.execPath, [path.join(import.meta.dirname, 'i18n-keys.cjs'), '--check'], {
  cwd: path.resolve(import.meta.dirname, '..'), stdio: 'inherit', windowsHide: true
});
