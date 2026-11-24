import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const adapters = readdirSync(join(root, 'src/adapters'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => 'adapters/' + e.name);
const layers = ['core', ...adapters, 'cli.ts'];

test('every source entry belongs to a guarded layer', () => {
  for (const name of readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' }).filter((n) =>
    n.endsWith('.ts'),
  )) {
    const file = name.split(sep).join('/');
    assert(
      layers.some((layer) => file === layer || file.startsWith(layer + '/')),
      'unguarded source: ' + file,
    );
  }
});
for (const layer of layers) {
  test(layer + ' may depend only on itself and core', () => {
    const dir = join(root, 'src', layer);
    const entries =
      layer === 'cli.ts'
        ? [dir]
        : readdirSync(dir, { recursive: true, encoding: 'utf8' })
            .filter((n) => n.endsWith('.ts'))
            .map((n) => join(dir, n));
    const files = execFileSync(
      process.execPath,
      [
        join(root, 'node_modules/typescript/bin/tsc'),
        '--ignoreConfig',
        '--module',
        'nodenext',
        '--listFilesOnly',
        ...entries,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    for (const file of files.trim().split(/\r?\n/)) {
      const name = relative(root, file).split(sep).join('/');
      if (name.split('/').includes('node_modules')) continue;
      assert(
        name.startsWith('src/core/') || name.startsWith('src/' + layer + '/') || name === 'src/' + layer,
        layer + ' depends on ' + name,
      );
    }
  });
}
