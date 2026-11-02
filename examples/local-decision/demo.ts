import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { StateSchema } from '../../src/domain.ts';

const snapshotSchema = z.object({
  works: z.array(StateSchema.shape.works.valueType),
  attentions: z.array(StateSchema.shape.attentions.valueType).default([]),
  notices: z.array(StateSchema.shape.outbox.valueType),
});

function main(): void {
  const { values } = parseArgs({ options: { directory: { type: 'string' } } });
  const directory = resolve(values.directory ?? mkdtempSync(join(tmpdir(), 'local-decision-demo-')));
  mkdirSync(directory, { recursive: true });
  if (readdirSync(directory).length) throw new Error('Demo requires an empty directory; existing files are never overwritten');
  const database = join(directory, 'state.sqlite');
  const cli = (...args: string[]) => {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../../src/cli.ts', import.meta.url)), ...args, '--db', database], {
      encoding: 'utf8', env: { ...process.env, WORK_AGENT_DEMO_DIRECTORY: directory },
    });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(child.stderr || child.stdout || `CLI exited with ${child.status}`);
    return snapshotSchema.parse(JSON.parse(child.stdout));
  };
  const tick = () => cli('run', '--plugins', fileURLToPath(new URL('./plugin.ts', import.meta.url)), '--ticks', '1');
  const admitted = tick();
  tick();
  const waiting = cli('inspect');
  const attention = waiting.attentions[0];
  assert(attention?.state.kind === 'pending');
  assert.equal(waiting.works[0]?.execution.kind, 'waiting_input');
  const choice = 'Loading only';
  const answered = cli('answer', '--attention', attention.id, '--choice', choice);
  assert.equal(answered.works[0]?.execution.kind, 'queued');
  assert.deepEqual(cli('answer', '--attention', attention.id, '--choice', choice), answered);
  tick();
  tick();
  const finished = cli('inspect');
  assert.equal(finished.works.length, 1);
  const work = finished.works[0];
  assert(work?.execution.kind === 'ready');
  assert.equal(work.sessionId, admitted.works[0]?.sessionId);
  assert.equal(work.results.length, 1);
  const report = work.results[0]?.report;
  assert(report?.kind === 'ready');
  const evidence = report.evidence[0];
  assert(evidence);
  const artifact = fileURLToPath(evidence);
  const draft = readFileSync(artifact, 'utf8');
  assert(draft.includes(`Chosen scope: ${choice}`));
  assert(draft.includes('Can the comparison card support loading states?'));
  assert.equal(finished.notices.find(row => row.notice.body.kind === 'ready')?.state.kind, 'delivered');
  process.stdout.write(JSON.stringify({
    mode: 'offline synthetic provider, separate CLI processes', directory, database,
    providerDatabase: join(directory, 'provider.sqlite'), workId: work.id, sessionId: work.sessionId,
    choice, status: work.execution.kind, artifact, draft,
  }, null, 2) + '\n');
}

try { main(); }
catch (error) {
  process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown failure' }) + '\n');
  process.exitCode = 1;
}
