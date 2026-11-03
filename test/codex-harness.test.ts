import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { RequestSchema } from '../src/domain.ts';
import type { WorkRequest } from '../src/domain.ts';
import { CodexHarness } from '../src/live/codex-harness.ts';

const executable = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));
const submissionSchema = z.object({ threadId: z.string(), goal: z.string() });

function setup(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), 'codex-harness-'));
  const active = new Set<CodexHarness>();
  t.after(async () => {
    await Promise.all([...active].map(harness => harness.close()));
    rmSync(cwd, { recursive: true, force: true });
  });
  return {
    open() {
      const harness = new CodexHarness({ executable, cwd, directory: cwd, baseUrl: 'https://example.invalid/v1', apiKey: 'fixture-api-key', model: 'fixture-model' });
      active.add(harness);
      return harness;
    },
    async close(harness: CodexHarness) {
      await harness.close();
      active.delete(harness);
    },
    submissions() {
      return readFileSync(join(cwd, 'native-submissions.jsonl'), 'utf8').trim().split('\n')
        .map(line => submissionSchema.parse(JSON.parse(line)));
    },
  };
}

function request(requestId: string, goal: string, changes: Partial<WorkRequest> = {}): WorkRequest {
  return RequestSchema.parse({
    requestId, workId: 'work-1', goal, scope: 'prepare', sessionId: null,
    workflow: { name: 'general', version: '1', instructions: 'Prepare a draft' },
    inputs: [], decisions: [], priorResults: [], ...changes,
  });
}

test('Codex harness reopens the same native thread and persists the model-authored artifact', async t => {
  const fixture = setup(t);
  const first = fixture.open();
  const initial = request('request-1', 'draft');
  const receipt = await first.submit(initial);
  assert.deepEqual(await first.submit(initial), receipt);
  await fixture.close(first);

  const resumed = fixture.open();
  assert.deepEqual(await resumed.lookup(initial.requestId), receipt);
  assert.deepEqual(await resumed.poll(receipt.runId), {
    kind: 'needs_input', summary: 'Scope choice needed', question: 'Include the failure state?', options: ['Yes', 'No'],
  });
  const next = RequestSchema.parse({
    ...request('request-2', 'draft', { sessionId: receipt.sessionId }),
    decisions: [{
      id: 'attention-1', workId: initial.workId, runId: initial.requestId, question: 'Include the failure state?',
      options: ['Yes', 'No'], state: { kind: 'resolved', actor: 'owner', choice: 'Yes' },
    }],
  });
  const followup = await resumed.submit(next);
  assert.equal(followup.sessionId, receipt.sessionId);
  assert.notEqual(followup.runId, receipt.runId);
  const report = await resumed.poll(followup.runId);
  assert(report?.kind === 'ready');
  const [uri] = report.evidence;
  assert(uri && uri.startsWith('file:'));
  assert.equal(readFileSync(new URL(uri), 'utf8'), '# Draft\n\nOwner choice: Yes\n');
  assert.deepEqual(await resumed.poll(followup.runId), report);
  assert.deepEqual(fixture.submissions(), [
    { threadId: receipt.sessionId, goal: 'draft' }, { threadId: receipt.sessionId, goal: 'draft' },
  ]);
});

test('Codex harness reconciles a lost acknowledgment by marker and never replays unknown admission', async t => {
  const fixture = setup(t);
  const first = fixture.open();
  const lost = request('request-lost', 'lost acknowledgment');
  const unknown = request('request-unknown', 'unconfirmed');
  await assert.rejects(first.submit(lost));
  await assert.rejects(first.submit(unknown));
  await fixture.close(first);

  const resumed = fixture.open();
  const recovered = await resumed.lookup(lost.requestId);
  assert(recovered);
  assert.deepEqual(await resumed.submit(lost), recovered);
  assert.equal((await resumed.poll(recovered.runId))?.kind, 'ready');
  assert.equal(await resumed.lookup(unknown.requestId), null);
  await assert.rejects(resumed.submit(unknown));
  assert.deepEqual(fixture.submissions().map(submission => submission.goal), ['lost acknowledgment', 'unconfirmed']);
});

test('Codex harness only admits preparation and maps invalid, failed or interrupted outcomes to failure', async t => {
  const fixture = setup(t);
  const harness = fixture.open();
  await assert.rejects(harness.submit(request('request-execute', 'unconfirmed', { scope: 'execute' })));
  for (const goal of ['malformed', 'failed', 'interrupted']) {
    const receipt = await harness.submit(request(`request-${goal}`, goal));
    assert.equal((await harness.poll(receipt.runId))?.kind, 'failed');
  }
  assert.deepEqual(fixture.submissions().map(submission => submission.goal), ['malformed', 'failed', 'interrupted']);
});
