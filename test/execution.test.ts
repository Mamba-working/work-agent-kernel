import test from 'node:test';
import assert from 'node:assert/strict';
import { EchoHarness, ScriptedRouter } from '../src/adapters.ts';
import { WorkflowSchema } from '../src/domain.ts';
import { createDecision, createWork, event, ready, running, setup } from './support.ts';

test('followup resumes provider session after kernel reopen', async t => {
  const f = setup(t); const k = f.open(); const id = await createWork(k); const first = running(await k.dispatch(id));
  f.harness.complete(first.receipt.runId, ready); await k.poll(first.id);
  const restored = f.open(); restored.ingest(event({ externalId: 'm2' })); await restored.routeNext();
  const second = running(await restored.dispatch(id)); assert.equal(second.receipt.sessionId, first.receipt.sessionId);
});
test('same task queues followups instead of creating simultaneous session writers', async t => {
  const f = setup(t); const k = f.open(); const id = await createWork(k); const first = running(await k.dispatch(id));
  const key = k.ingest(event({ externalId: 'm2' })); await k.routeNext(); assert.equal(await k.dispatch(id), null);
  f.harness.complete(first.receipt.runId, ready); await k.poll(first.id);
  const second = running(await k.dispatch(id)); assert.deepEqual(second.request.inputs.map(input => input.key), [key]);
});
test('independent tasks have separate active sessions', async t => {
  const k = setup(t).open(); const a = await createWork(k, { thread: 'a' }); const b = await createWork(k, { externalId: 'm2', thread: 'b' });
  const first = running(await k.dispatch(a)); const second = running(await k.dispatch(b));
  assert.notEqual(first.receipt.sessionId, second.receipt.sessionId); assert.equal(k.work(a).execution.kind, 'running');
});
test('switching harness retains work and evidence but creates a new session lineage', async t => {
  const f = setup(t); const k = f.open(); k.harnesses.set('echo', new EchoHarness());
  const id = await createWork(k); const first = running(await k.dispatch(id)); assert.throws(() => k.rebind(id, 'echo'), /Settle/);
  f.harness.complete(first.receipt.runId, ready); await k.poll(first.id); k.rebind(id, 'echo');
  const second = running(await k.dispatch(id)); assert.equal(second.request.sessionId, null);
  assert.deepEqual(second.request.priorResults[0]?.report, ready); assert.equal(second.workId, id);
  assert(second.receipt.sessionId.startsWith('echo:'));
});
test('missing harness does not consume pending inputs', async t => {
  const k = setup(t).open(); const id = await createWork(k, {}, { harness: 'missing' });
  await assert.rejects(k.dispatch(id), /registered/); assert.equal(k.work(id).pendingInputs.length, 1);
});
test('lost admission acknowledgement reconciles to one existing execution', async t => {
  const f = setup(t); f.harness.loseNextAck = true; const k = f.open(); const id = await createWork(k); const run = await k.dispatch(id); assert(run);
  assert.equal(run.state.kind, 'uncertain'); assert.equal(await k.dispatch(id), null);
  await f.open().reconcile(run.id); assert.equal(k.work(id).execution.kind, 'running'); assert.equal(f.harness.requests.length, 1);
});
test('unknown admission is not blindly resubmitted', async t => {
  let submissions = 0;
  const k = setup(t).open({ harnesses: { recording: { async submit() { submissions++; throw new Error('Timeout'); }, async lookup() { return null; }, async poll() { return null; } } } });
  const id = await createWork(k); const run = await k.dispatch(id); assert(run); await k.reconcile(run.id); await k.dispatch(id);
  assert.equal(submissions, 1); assert.equal(k.work(id).execution.kind, 'uncertain'); assert.equal(k.work(id).pendingInputs.length, 1);
});
test('ready requires evidence and does not mean externally published', async t => {
  const f = setup(t); const k = f.open(); const id = await createWork(k); const run = running(await k.dispatch(id));
  f.harness.complete(run.receipt.runId, { kind: 'ready', summary: 'Done', evidence: [] }); await assert.rejects(k.poll(run.id));
  assert.equal(k.work(id).execution.kind, 'running'); f.harness.complete(run.receipt.runId, ready); await k.poll(run.id);
  assert.equal(k.work(id).execution.kind, 'ready');
});
test('unrelated thread input can be returned to router', async t => {
  const f = setup(t); const k = f.open(); const id = await createWork(k); const run = running(await k.dispatch(id));
  f.harness.complete(run.receipt.runId, { kind: 'reroute', summary: 'Different topic' }); await k.poll(run.id);
  k.router = new ScriptedRouter([createDecision({ goal: 'Other work' })]); const targets = await k.routeNext(); assert(targets?.[0]); assert.notEqual(targets[0], id);
});
test('workflow version is pinned when task is created', async t => {
  const f = setup(t); const profile = WorkflowSchema.parse({ name: 'research', version: 'v1', instructions: 'Read primary sources', skills: ['research'], acceptance: ['Cite sources'] });
  const k = f.open({ workflows: [profile] }); const id = await createWork(k, {}, { workflow: 'research' });
  k.workflows.set('research', { ...profile, version: 'v2' }); const run = running(await k.dispatch(id));
  assert.equal(run.request.workflow.version, 'v1'); assert.deepEqual(run.request.workflow.skills, ['research']);
});
test('adapter may not silently replace a bound session', async t => {
  const f = setup(t); const k = f.open(); const id = await createWork(k); const first = running(await k.dispatch(id));
  f.harness.complete(first.receipt.runId, ready); await k.poll(first.id); k.ingest(event({ externalId: 'm2' })); await k.routeNext();
  k.harnesses.set('recording', { async submit() { return { sessionId: 'wrong', runId: 'other' }; }, async lookup() { return null; }, async poll() { return null; } });
  const run = await k.dispatch(id); assert.equal(run?.state.kind, 'uncertain'); assert.equal(k.work(id).sessionId, first.receipt.sessionId);
});
