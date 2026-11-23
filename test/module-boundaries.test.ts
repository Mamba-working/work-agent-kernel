import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Ask the same compiler as typecheck, so type-only imports and re-exports count too.
const repo = fileURLToPath(new URL('../', import.meta.url));
const compiler = join(repo, 'node_modules/typescript/bin/tsc');
for (const [layer, allowed] of [
  ['core', ['core']],
  ['adapters', ['core', 'adapters']],
  ['hooks', ['core', 'adapters', 'hooks']],
] as const) {
  test(layer + ' depends only on its declared source layers', () => {
    const root = join(repo, 'src', layer);
    const entries = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(root, name));
    assert(entries.length);
    const files = execFileSync(
      process.execPath,
      [compiler, '--ignoreConfig', '--module', 'nodenext', '--listFilesOnly', ...entries],
      { cwd: repo, encoding: 'utf8' },
    );
    for (const path of files.trim().split(/\r?\n/)) {
      const name = relative(repo, resolve(repo, path));
      if (name.split(sep).includes('node_modules')) continue;
      assert(
        allowed.some((dir) => name.startsWith(join('src', dir) + sep)),
        layer + ' depends on ' + name,
      );
    }
  });
}
