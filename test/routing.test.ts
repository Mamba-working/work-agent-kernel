import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualSource, ScriptedRouter } from '../src/adapters.ts';
import { createDecision, createWork, event, setup } from './support.ts';

test('source checkpoint persists across reopen', async t => {
  const f = setup(t); const source = new ManualSource('manual', [event(), event({ externalId: 'm2' })]);
  assert.equal(await f.open().collect(source), 2);
  const restored = f.open();
  assert.equal(await restored.collect(source), 0);
  assert.equal(restored.cursor('manual'), '2');
});
test('invalid source batch neither advances cursor nor partially inserts events', async t => {
  const k = setup(t).open();
  await assert.rejects(k.collect({ name: 'manual', async fetch() { return { events: [event(), event({ source: 'spoofed' })], cursor: '2' }; } }), /identity/);
  assert.deepEqual(k.events(), []); assert.equal(k.cursor('manual'), null);
});
test('malformed event is rejected at ingress', t => {
  const k = setup(t).open(); assert.throws(() => k.ingest({ ...event(), actor: null })); assert.equal(k.events().length, 0);
});
test('followup subscription bypasses router while retaining both inputs', async t => {
  const router = new ScriptedRouter([createDecision()]); const k = setup(t).open({ router });
  const first = k.ingest(event()); const targets = await k.routeNext(); assert(targets?.[0]);
  const second = k.ingest(event({ externalId: 'm2' }));
  assert.deepEqual(await k.routeNext(), targets);
  assert.deepEqual(k.work(targets[0]).pendingInputs, [first, second]); assert.equal(router.contexts.length, 1);
});
test('router attaches cross-source context to an existing work item', async t => {
  const k = setup(t).open(); const id = await createWork(k);
  k.router = new ScriptedRouter([{ kind: 'attach', reason: 'Same request in document', workId: id }]);
  k.ingest(event({ source: 'document', externalId: 'c1', thread: 'comment' }));
  assert.deepEqual(await k.routeNext(), [id]);
  k.ingest(event({ source: 'document', externalId: 'c2', thread: 'comment' }));
  assert.deepEqual(await k.routeNext(), [id]); assert.equal(k.works().length, 1);
});
test('one source thread can inform two distinct tasks', async t => {
  const k = setup(t).open(); const a = await createWork(k, { thread: 'a' }); const b = await createWork(k, { externalId: 'm2', thread: 'b' });
  k.subscribe(b, 'manual', 'a'); k.ingest(event({ externalId: 'm3', thread: 'a' }));
  assert.deepEqual(new Set(await k.routeNext()), new Set([a, b]));
});
test('unauthorized scope is not converted into executable work', async t => {
  const k = setup(t).open({ router: new ScriptedRouter([createDecision({ scope: 'execute' })]) });
  const key = k.ingest(event()); await assert.rejects(k.routeNext(), /authorized/);
  assert.equal(k.works().length, 0); assert.equal(k.event(key).disposition, 'pending');
});
test('invalid model response is rejected and leaves event pending', async t => {
  const k = setup(t).open({ router: new ScriptedRouter([{ kind: 'invented-action' }]) });
  const key = k.ingest(event()); await assert.rejects(k.routeNext()); assert.equal(k.event(key).disposition, 'pending');
});
test('router failure can be retried without losing input', async t => {
  const router = new ScriptedRouter([]); const k = setup(t).open({ router }); const key = k.ingest(event());
  await assert.rejects(k.routeNext()); router.decisions.push({ kind: 'ignore', reason: 'Reference only' });
  assert.deepEqual(await k.routeNext(), []); assert.equal(k.event(key).disposition, 'ignored');
});
test('context preview is bounded but full source remains recallable', async t => {
  const router = new ScriptedRouter([{ kind: 'ignore', reason: 'Reference only' }]); const k = setup(t).open({ router });
  const original = 'A'.repeat(3000) + ' important ending'; const key = k.ingest(event({ text: original })); await k.routeNext();
  assert.equal(router.contexts[0]?.event.truncated, true); assert.equal(router.contexts[0]?.event.text.length, 800);
  assert.equal(k.recall().event(key).text, original);
});
test('same raw ID in different sources does not collide', t => {
  const k = setup(t).open(); assert.notEqual(k.ingest(event()), k.ingest(event({ source: 'document' }))); assert.equal(k.events().length, 2);
});
test('input can be persisted while router awaits external inference', async t => {
  let release: (value: unknown) => void = () => { throw new Error('Router not waiting'); };
  const wait = new Promise<unknown>(resolve => { release = resolve; });
  const k = setup(t).open({ router: { async decide() { return wait; } } });
  k.ingest(event()); const routing = k.routeNext();
  k.ingest(event({ externalId: 'm2' })); await assert.rejects(k.routeNext(), /already/);
  release(createDecision()); await routing;
  assert.equal(k.events().length, 2); assert.equal(k.events()[1]?.disposition, 'pending');
});
