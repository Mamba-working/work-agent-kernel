import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('a packed consumer imports ESM, declarations and the Feishu skill through public subpaths', (t) => {
  const repo = fileURLToPath(new URL('../', import.meta.url)),
    dir = mkdtempSync(join(tmpdir(), 'wak-consumer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const [tar] = JSON.parse(
    execFileSync(
      'npm',
      [
        'pack',
        '--ignore-scripts',
        '--offline',
        '--cache',
        join(dir, 'cache'),
        '--json',
        '--pack-destination',
        dir,
      ],
      { cwd: repo, encoding: 'utf8' },
    ),
  );
  assert(!tar.files.some((f: { path: string }) => /^(examples|plugins|test|src)\//.test(f.path)));
  const [dep] = JSON.parse(
    execFileSync(
      'npm',
      [
        'pack',
        './node_modules/zod',
        '--ignore-scripts',
        '--offline',
        '--cache',
        join(dir, 'cache'),
        '--json',
        '--pack-destination',
        dir,
      ],
      { cwd: repo, encoding: 'utf8' },
    ),
  );
  execFileSync(
    'npm',
    [
      'install',
      '--offline',
      '--no-audit',
      '--no-fund',
      '--cache',
      join(dir, 'cache'),
      join(dir, dep.filename),
      join(dir, tar.filename),
    ],
    { cwd: dir },
  );
  symlinkSync(join(repo, 'node_modules/@types'), join(dir, 'node_modules/@types'), 'dir');
  writeFileSync(
    join(dir, 'check.mts'),
    `import {createRouterApplication,type ApplicationOptions} from 'work-router-kit';
import {codexPlanner} from 'work-router-kit/adapters/codex';
import {feishuIncomingContext} from 'work-router-kit/adapters/feishu';
const runtime: ApplicationOptions['runtime']=codexPlanner('codex');
if(typeof runtime!=='function'||typeof createRouterApplication!=='function'||typeof feishuIncomingContext!=='function')throw Error('missing API');
`,
  );
  execFileSync(process.execPath, ['check.mts'], { cwd: dir });
  execFileSync(
    process.execPath,
    [
      join(repo, 'node_modules/typescript/bin/tsc'),
      '--ignoreConfig',
      '--module',
      'nodenext',
      '--target',
      'es2023',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      'check.mts',
    ],
    { cwd: dir },
  );
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
await assert.rejects(import('work-router-kit/dist/core/store.js'), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
await Promise.all(['file','responses','local'].map(id=>import('work-router-kit/adapters/'+id)));`,
    ],
    { cwd: dir },
  );
});
