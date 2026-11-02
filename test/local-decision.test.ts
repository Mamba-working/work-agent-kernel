import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { StateSchema } from '../src/domain.ts';
import { Kernel } from '../src/kernel.ts';

const snapshotSchema = z.object({
  works: z.array(StateSchema.shape.works.valueType),
  attentions: z.array(StateSchema.shape.attentions.valueType).default([]),
  notices: z.array(StateSchema.shape.outbox.valueType),
});

test('local owner decision survives CLI exits and continues the same session into a readable draft', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'local-decision-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  const cli = (...args: string[]) => {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args, '--db', path], {
      encoding: 'utf8', env: { ...process.env, WORK_AGENT_DEMO_DIRECTORY: directory },
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return snapshotSchema.parse(JSON.parse(child.stdout));
  };
  const tick = () => cli('run', '--plugins', fileURLToPath(new URL('../examples/local-decision/plugin.ts', import.meta.url)), '--ticks', '1');

  const admitted = tick();
  assert.equal(admitted.works.length, 1);
  assert.equal(admitted.works[0]?.execution.kind, 'running');
  tick();
  const waiting = cli('inspect');
  assert.equal(waiting.works[0]?.execution.kind, 'waiting_input');
  assert.equal(waiting.attentions.length, 1);
  const attention = waiting.attentions[0];
  assert(attention);
  assert.equal(attention.state.kind, 'pending');
  assert.deepEqual(attention.options, ['Loading only', 'Both']);

  const answered = cli('answer', '--attention', attention.id, '--choice', 'Both');
  assert.equal(answered.works[0]?.execution.kind, 'queued');
  assert.deepEqual(answered.attentions[0]?.state, { kind: 'resolved', choice: 'Both', actor: 'owner' });
  assert.deepEqual(answered.works[0]?.pendingDecisions, [attention.id]);
  assert.deepEqual(cli('answer', '--attention', attention.id, '--choice', 'Both'), answered);

  const continued = tick();
  assert.equal(continued.works[0]?.execution.kind, 'running');
  assert.equal(continued.works[0]?.sessionId, admitted.works[0]?.sessionId);
  tick();
  const finished = cli('inspect');
  assert.equal(finished.works.length, 1);
  const work = finished.works[0];
  assert(work);
  assert.equal(work.execution.kind, 'ready');
  assert.equal(work.results.length, 1);
  assert.deepEqual(work.pendingDecisions, []);
  const result = work.results[0];
  assert(result?.report.kind === 'ready');
  const artifact = result.report.evidence[0];
  assert(artifact);
  const draft = readFileSync(fileURLToPath(artifact), 'utf8');
  assert.match(draft, /Chosen scope: Both/);
  assert.match(draft, /Can the comparison card support loading states\?/);
  assert.equal(finished.notices.find(row => row.notice.body.kind === 'ready')?.state.kind, 'delivered');

  const kernel = new Kernel({ path });
  try {
    const firstRun = kernel.run(attention.runId);
    const continuation = kernel.run(result.runId);
    assert(firstRun.state.kind === 'finished');
    assert(continuation.state.kind === 'finished');
    assert.notEqual(continuation.id, firstRun.id);
    assert.equal(continuation.state.receipt.sessionId, firstRun.state.receipt.sessionId);
    assert.deepEqual(continuation.request.decisions.map(decision => decision.state), [{ kind: 'resolved', choice: 'Both', actor: 'owner' }]);
    const { DurableDemoHarness } = await import('../examples/local-decision/harness.ts');
    const reopened = new DurableDemoHarness({ directory });
    assert.deepEqual(await reopened.lookup(firstRun.request.requestId), firstRun.state.receipt);
    assert.deepEqual(await reopened.poll(continuation.state.receipt.runId), continuation.state.report);
    kernel.ingest({ source: 'synthetic-chat', externalId: 'm2', revision: '1', thread: 'topic-7', actor: 'colleague', text: 'Keep the existing image while loading', uri: 'example://chat/m2' });
  } finally { kernel.close(); }

  tick(); tick();
  const afterFollowup = cli('inspect');
  assert.equal(afterFollowup.works[0]?.execution.kind, 'ready');
  assert.equal(afterFollowup.attentions.length, 1);
  const latest = afterFollowup.works[0]?.results.at(-1)?.report;
  assert(latest?.kind === 'ready' && latest.evidence[0]);
  const updatedDraft = readFileSync(fileURLToPath(latest.evidence[0]), 'utf8');
  assert.match(updatedDraft, /Chosen scope: Both/);
  assert.match(updatedDraft, /Keep the existing image while loading/);
});
