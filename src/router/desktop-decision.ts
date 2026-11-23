import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { instructions, formatSchema } from './policy.ts';
import type { DecisionInput } from './routing.ts';

export function desktopDecision(codexExecutable: string, timeoutMs = 120_000) {
  return async (input: DecisionInput) => {
    const temp = await mkdtemp(join(tmpdir(), 'router-decision-'));
    try {
      const schemaFile = join(temp, 'schema.json'),
        output = join(temp, 'decision.json');
      await writeFile(schemaFile, JSON.stringify(formatSchema));
      const args = [
        'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--output-schema',
        schemaFile,
        '-o',
        output,
        '-',
      ];
      const child = spawn(codexExecutable, args, {
        cwd: temp,
        stdio: ['pipe', 'ignore', 'ignore'],
        timeout: timeoutMs,
      });
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) =>
          code === 0
            ? resolve()
            : reject(
                new Error(
                  signal
                    ? 'Codex route interrupted (' + signal + ', timeout ' + timeoutMs + 'ms)'
                    : 'Codex route failed: ' + code,
                ),
              ),
        );
        child.stdin.on('error', () => {});
        child.stdin.end(
          instructions +
            '\nWhen present, projectMessages are background for interpreting the current event. Do not dispatch old messages as new requests. Include relevant facts in a new work goal.\nUse no tools. Return only the routing decision.\n' +
            JSON.stringify(input),
        );
      });
      return JSON.parse(await readFile(output, 'utf8')).decision;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  };
}
