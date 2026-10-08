import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const virtualPython = path.join(root, '.venv', 'bin', 'python');
const python = existsSync(virtualPython) ? virtualPython : 'python3';
const result = spawnSync(python, ['-m', 'scripts.rmp.refresh', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
