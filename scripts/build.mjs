import { execFileSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], {
  stdio: 'inherit',
});
cpSync('src/adapters/feishu/skills', 'dist/adapters/feishu/skills', { recursive: true });
