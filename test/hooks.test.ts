import { loadBusinessHooks } from '../src/core/hooks/load.ts';
import { NoticeSchema } from '../src/core/domain.ts';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Lifecycle } from '../src/core/hooks/lifecycle.ts';
import type { LifecycleHook, HookInput, HookEffect } from '../src/core/hooks/lifecycle.ts';
import { createManualTestApplication as createRouterApplication } from '../src/core/application.ts';
import { RecordingHarness } from '../examples/support/adapters.ts';
import { RouterInbox } from '../src/adapters/feishu/inbox.ts';
import { feishuIngress } from '../examples/feishu-codex/profile.ts';
import { feishuResultNotice } from '../src/adapters/feishu/hooks/result-notice.ts';
import type { AdmissionChannel } from '../src/adapters/feishu/admission-store.ts';
import type { PlanningRequest } from '../src/core/planning/contracts.ts';
import { event, ready, running } from './support.ts';

function directory(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const input: HookInput = {
  phase: 'beforeRoute',
  kind: 'owner',
  id: 'example',
  description: 'demo',
  sources: [],
};
const options = {
  signal: new AbortController().signal,
  catalog: { defaultHarness: 'local', projects: [] },
  sinks: {},
  harnesses: { local: new RecordingHarness('local') },
};
const analysis = () => ({ answer: 'ok', actions: [], evidence: [] });

test('waiting survives reopen and resumes after the original hook; callback is idempotent and scoped', async (t) => {
  const dir = directory(t),
    path = join(dir, 'hooks.sqlite');
  const calls: string[] = [];
  const hooks: LifecycleHook[] = [
    {
      id: 'lookup',
      phase: 'beforeRoute',
      run() {
        calls.push('lookup');
        return { kind: 'continue', context: { project: 'p' } };
      },
    },
    {
      id: 'review',
      phase: 'beforeRoute',
      run(_, facts) {
        assert.deepEqual(facts.lookup, { project: 'p' });
        calls.push('review');
        return { kind: 'wait', reason: 'ask', data: 1, effect: 'card' };
      },
      async deliver(effect) {
        assert.equal(effect.ticket, ticket);
      },
    },
    {
      id: 'final',
      phase: 'beforeRoute',
      run(_, facts) {
        calls.push('final');
        assert.deepEqual(facts.review, { approved: true });
        return { kind: 'continue' };
      },
    },
  ];
  let engine = new Lifecycle(path, hooks);
  const wait = engine.advance(input),
    ticket = wait.ticket!;
  assert.equal(wait.status, 'wait');
  assert(ticket);
  await engine.close();
  engine = new Lifecycle(path, [hooks[2]!, hooks[1]!, hooks[0]!]);
  t.after(() => engine.close());
  await engine.deliverNext();
  assert.equal(engine.runnable('owner', input.id), false);
  assert.throws(() => engine.resume('wrong', { kind: 'continue' }));
  const ok = { kind: 'continue', context: { approved: true } } as const;
  engine.resume(ticket, ok);
  engine.resume(ticket, ok);
  assert.throws(() => engine.resume(ticket, { kind: 'break', reason: 'late change' }), /Conflicting/);
  assert.equal(engine.advance(input).status, 'ready');
  assert.equal(engine.advance(input).status, 'ready');
  assert.deepEqual(calls, ['lookup', 'review', 'final']);
});

test('continue queues a background effect, retries with the same ID, other effects still deliver', async (t) => {
  let fail = true;
  const attempts: HookEffect[] = [];
  const h: LifecycleHook = {
    id: 'notify',
    phase: 'beforeRoute',
    run: (i) => ({ kind: 'continue', effect: i.id }),
    async deliver(e) {
      attempts.push(e);
      if (fail && e.payload === 'example') throw Error('offline');
    },
  };
  const path = join(directory(t), 'outbox');
  let engine = new Lifecycle(path, [h]);
  assert.equal(engine.advance(input).status, 'ready');
  engine.advance({ ...input, id: 'second' });
  assert.equal(attempts.length, 0);
  await assert.rejects(engine.deliverNext(1), /offline/);
  await engine.deliverNext(2);
  assert.equal(engine.effectFailures().length, 1);
  await engine.close();
  engine = new Lifecycle(path, [h]);
  t.after(() => engine.close());
  fail = false;
  await engine.deliverNext(30001);
  await engine.deliverNext(30002);
  assert.deepEqual(
    attempts.map((e) => e.payload),
    ['example', 'second', 'example'],
  );
  assert.equal(attempts[0]?.id, attempts[2]?.id);
  assert.equal(attempts[0]?.ticket, null);
});

test('invalid hook output parks only the failing step and can be retried', async (t) => {
  let ok = false,
    count = 0;
  const h: LifecycleHook = {
    id: 'bad',
    phase: 'beforeRoute',
    run() {
      if (!ok) throw Error('offline');
      return { kind: 'continue' };
    },
  };
  const engine = new Lifecycle(join(directory(t), 'h'), [
    {
      id: 'first',
      phase: 'beforeRoute',
      run() {
        count++;
        return { kind: 'continue' };
      },
    },
    h,
  ]);
  t.after(() => engine.close());
  assert.equal(engine.advance(input).status, 'failed');
  assert(!engine.runnable('owner', input.id));
  ok = true;
  engine.retry('owner', input.id);
  assert.equal(engine.advance(input).status, 'ready');
  assert.equal(count, 1);
});

test('both queues skip parked requests, break stops before the model and facts reach the model', async (t) => {
  const calls: PlanningRequest[] = [];
  const a = createRouterApplication({
    ...options,
    directory: directory(t),
    runtime: async (r) => {
      calls.push(r);
      return analysis();
    },
    hooks: [
      {
        id: 'business',
        phase: 'beforeRoute',
        run(i) {
          const text = i.kind === 'event' ? i.event.text : i.kind === 'owner' ? i.description : '';
          if (text === 'hold') return { kind: 'wait', reason: 'need answer' };
          if (text === 'stop') return { kind: 'break', reason: 'stopped' };
          return { kind: 'continue', context: { project: 'demo' } };
        },
      },
    ],
  });
  t.after(() => a.close());
  const held = a.dispatch.submit({ id: randomUUID(), description: 'hold', sources: [] });
  const next = a.dispatch.submit({ id: randomUUID(), description: 'go', sources: [] });
  await a.processNextDispatch();
  await a.processNextDispatch();
  assert.equal(a.dispatch.get(held.id).status, 'waiting_hook');
  assert.equal(a.dispatch.get(next.id).status, 'done');
  const blocked = a.kernel.ingest(event({ text: 'hold' }));
  a.kernel.ingest(event({ text: 'go', externalId: '2' }));
  await a.host.tick();
  assert.equal(a.kernel.event(blocked).disposition, 'waiting_hook');
  const stopped = a.kernel.ingest(event({ text: 'stop', externalId: '3' }));
  await a.host.tick();
  assert.equal(a.kernel.event(stopped).disposition, 'stopped');
  a.hooks.resume(a.hooks.status('owner', held.id)!.ticket!, { kind: 'break', reason: '本人取消' });
  await a.processNextDispatch();
  assert.equal(a.dispatch.get(held.id).status, 'stopped');
  a.hooks.resume(a.hooks.status('event', blocked)!.ticket!, { kind: 'continue', context: 'resume' });
  await a.host.tick();
  assert.deepEqual(
    calls.map((x) => x.origin.kind),
    ['owner', 'event', 'event'],
  );
  assert(calls.every((r) => r.context.some((c) => c.text.includes('Hook business'))));
});

for (const execute of [true, false])
  test('Feishu card is an async wait; verified decision survives restart, execute=' + execute, async (t) => {
    const dir = directory(t),
      projects = { p: { name: 'P', cwd: dir } };
    const inbox = new RouterInbox(join(dir, 'receiver'), projects);
    inbox.admission.enable('ou_owner');
    const receipts: string[] = [];
    const channel: AdmissionChannel = {
      async send(r) {
        receipts.push(r.eventId);
        return 'om_accepted';
      },
      async update() {},
    };
    const seen: PlanningRequest[] = [];
    const open = () =>
      createRouterApplication({
        ...options,
        directory: dir,
        catalog: { defaultHarness: 'local', projects: [{ id: 'p', name: 'P', harness: 'local' }] },
        ingress: [feishuIngress(inbox, () => 'local', channel)],
        runtime: async (r) => {
          seen.push(r);
          return analysis();
        },
      });
    let app = open();
    const id = inbox.receive({ message_id: 'sample', chat_id: 'new', chat_type:'group',content: 'demo' });
    await app.host.tick();
    assert.equal(app.kernel.events()[0]?.disposition, 'waiting_hook');
    assert.equal(seen.length, 0);
    await app.hooks.deliverNext();
    assert.deepEqual(receipts, [id]);
    await app.host.tick();
    assert.equal(seen.length, 0);
    assert.throws(() => inbox.admission.submit(id, 'ou_other', 'om_accepted', { project: 'p', execute }));
    await app.close();
    inbox.admission.submit(id, 'ou_owner', 'om_accepted', { project: 'p', execute });
    app = open();
    t.after(async () => {
      await app.close();
      inbox.close();
    });
    await app.host.tick();
    await app.host.tick();
    assert.equal(inbox.admission.boundProject('new'), 'p');
    assert.equal(app.kernel.events()[0]?.disposition, execute ? 'ignored' : 'stopped');
    assert.equal(seen.length, execute ? 1 : 0);
    if (execute) {
      assert.equal(seen[0]?.defaultProject, 'p');
      assert(seen[0]?.context.some((c) => c.text.includes('approved')));
    }
  });

for (const allow of [true, false])
  test('beforeNotify parks only delivery after the work result commits, allow=' + allow, async (t) => {
    const sink: string[] = [];
    const worker = new RecordingHarness('worker');
    const a = createRouterApplication({
      ...options,
      directory: directory(t),
      harnesses: { local: worker },
      runtime: async () => ({
        answer: 'work',
        actions: [{ goal: 'draft', project: null, workId: null, evidence: [] }],
        evidence: [],
      }),
      sinks: {
        inbox: {
          async deliver(n, facts) {
            assert.equal(facts?.confirm, 'checked');
            sink.push(n.id);
            return 'receipt';
          },
        },
      },
      hooks: [
        {
          id: 'confirm',
          phase: 'beforeNotify',
          run() {
            return { kind: 'wait', reason: 'confirm channel' };
          },
        },
      ],
    });
    t.after(() => a.close());
    a.kernel.ingest(event());
    const ids = await a.kernel.routeNext();
    const run = running(await a.kernel.dispatch(ids![0]!));
    worker.complete(run.receipt.runId, ready);
    await a.kernel.poll(run.id);
    const id = a.kernel.notices()[0]!.notice.id;
    assert.deepEqual(await a.host.tick(), []);
    assert.equal(a.kernel.notices()[0]?.state.kind, 'waiting_hook');
    assert.equal(a.kernel.work(ids![0]!).execution.kind, 'ready');
    assert.deepEqual(sink, []);
    a.hooks.resume(
      a.hooks.status('result', id)!.ticket!,
      allow ? { kind: 'continue', context: 'checked' } : { kind: 'break', reason: 'quiet' },
    );
    await a.host.tick();
    await a.host.tick();
    assert.equal(sink.length, allow ? 1 : 0);
    assert.equal(a.kernel.notices()[0]?.state.kind, allow ? 'delivered' : 'suppressed');
  });

test('Feishu informational hook explicitly continues and pins delivery to configured recipient', () => {
  const hook = feishuResultNotice('ou_self');
  assert.throws(() => feishuResultNotice('user-supplied-name'));
  const notice = { id: 'n', recipient: 'local-owner', workId: 'work', body: ready };
  const data = hook.run(
    { phase: 'beforeNotify', kind: 'result', id: 'n', notice: NoticeSchema.parse(notice) },
    {},
  );
  assert.deepEqual(data, { kind: 'continue', effect: { recipient: 'ou_self', text: ready.summary } });
});

test('async lookup can return context; main queue progresses before the lookup promise settles', async (t) => {
  let release!: () => void;
  const completed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: PlanningRequest[] = [];
  const app = createRouterApplication({
    ...options,
    directory: directory(t),
    runtime: async (r) => {
      seen.push(r);
      return analysis();
    },
    hooks: [
      {
        id: 'lookup',
        phase: 'beforeRoute',
        run(i) {
          return i.kind === 'owner' && i.description === 'lookup'
            ? { kind: 'wait', reason: 'fetching', effect: { lookup: 'prd' } }
            : { kind: 'continue' };
        },
        async deliver() {
          await completed;
          return { kind: 'continue', context: { prd: 'v2' } };
        },
      },
    ],
  });
  t.after(() => app.close());
  const job = app.dispatch.submit({ id: randomUUID(), description: 'lookup', sources: [] });
  app.dispatch.submit({ id: randomUUID(), description: 'other', sources: [] });
  await app.processNextDispatch();
  const sending = app.hooks.deliverNext();
  await app.processNextDispatch();
  assert.deepEqual(
    seen.map((r) => r.description),
    ['other'],
  );
  release();
  await sending;
  await app.processNextDispatch();
  assert.equal(app.dispatch.get(job.id).status, 'done');
  assert(seen[1]?.context[0]?.text.includes('v2'));
});

test('absent pending hook and invalid return fail closed; a hook cannot replace authorized fields', async (t) => {
  const path = join(directory(t), 'errors');
  const h: LifecycleHook = {
    id: 'park',
    phase: 'beforeRoute',
    run: () => ({ kind: 'wait', reason: 'park' }),
  };
  const invalid: LifecycleHook = {
    id: 'invalid',
    phase: 'beforeRoute',
    run: () => Object.assign({ kind: 'continue' as const }, { maxActions: 99 }),
  };
  let engine = new Lifecycle(path, [h, invalid]);
  const ticket = engine.advance(input).ticket!;
  await engine.close();
  engine = new Lifecycle(path, [h]);
  engine.resume(ticket, { kind: 'continue' });
  assert.equal(engine.advance(input).status, 'failed');
  assert.match(engine.status('owner', input.id)!.reason, /Missing registered hook/);
  await engine.close();
  engine = new Lifecycle(path, [h, invalid]);
  t.after(() => engine.close());
  engine.retry('owner', input.id);
  assert.equal(engine.advance(input).status, 'failed');
  assert.deepEqual(engine.advance(input).facts, {});
});

test('business registers an external ESM hook module without editing the service', async (t) => {
  const dir = directory(t),
    file = join(dir, 'business.mjs');
  writeFileSync(
    file,
    "export function createHooks(){return [{id:'team',phase:'beforeRoute',run(){return {kind:'break',reason:'team policy'}}}]}",
  );
  const hooks = await loadBusinessHooks(file);
  const app = createRouterApplication({
    ...options,
    directory: dir,
    hooks,
    runtime: async () => {
      throw Error('model must not run');
    },
  });
  t.after(() => app.close());
  const id = app.kernel.ingest(event());
  await app.host.tick();
  assert.equal(app.kernel.event(id).disposition, 'stopped');
  const invalid = join(dir, 'invalid.mjs');
  writeFileSync(invalid, "export function createHooks(){return [{id:'broken',phase:'beforeRoute'}]}");
  await assert.rejects(loadBusinessHooks(invalid));
});
