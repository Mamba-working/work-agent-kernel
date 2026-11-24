import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createRouterApplication, type ApplicationOptions } from 'work-agent-kernel';
import type { Harness } from '../src/core/ports.ts';
import type { PlanningRuntime } from '../src/core/planning/contracts.ts';
import { RecordingHarness, MemorySink } from '../examples/support/adapters.ts';
import { eventKey } from '../src/core/domain.ts';
import { event } from './support.ts';

const ready = (summary: string) => ({ kind: 'ready', summary, evidence: ['fixture://proof'] });
const planner: PlanningRuntime = async (req) => ({
  answer: 'queued',
  evidence: [],
  actions: [{ goal: req.description, project: null, workId: null, evidence: [] }],
});
const job = (description = 'do work') => ({ id: randomUUID(), description, sources: [] });
const immediate: Harness = {
  async submit(req) {
    return { runId: req.requestId, sessionId: 'local' };
  },
  async lookup() {
    return null;
  },
  async poll() {
    return ready('finished');
  },
};
function make(t: TestContext, h: Harness, options: Partial<ApplicationOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'application-driver-'));
  const app = createRouterApplication({
    directory: dir,
    catalog: { defaultHarness: 'local', projects: [] },
    harnesses: { local: h },
    sinks: { inbox: new MemorySink() },
    runtime: planner,
    signal: new AbortController().signal,
    scheduling: { reconcileMs: 60000 },
    ...options,
  });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return app;
}
test('manual creation/submission does no background work; each step is bounded', async (t) => {
  const timers = t.mock.method(globalThis, 'setTimeout');
  const intervals = t.mock.method(globalThis, 'setInterval');
  let calls = 0,
    subscriptions = 0;
  const app = make(
    t,
    {
      ...immediate,
      subscribe() {
        subscriptions++;
        return () => {};
      },
    },
    {
      runtime: async (...args) => {
        calls++;
        return planner(...args);
      },
    },
  );
  const task = app.submit(job());
  assert.equal(timers.mock.callCount(), 0);
  assert.equal(intervals.mock.callCount(), 0);
  await delay(25);
  assert.equal(subscriptions, 0);
  assert.equal(calls, 0);
  await app.step();
  assert.equal((await task.routed).workIds.length, 1);
  assert.equal(app.listWorks().filter((w) => w.execution.kind === 'running').length, 1);
  await app.step();
  await app.step();
  assert.equal((await task.done).outcomes[0]?.report.kind, 'ready');
});

test(
  'worker push settles during unrelated slow planning; wait for owner and follow the continuation',
  { timeout: 5000 },
  async (t) => {
    let wake = () => {},
      resume!: () => void,
      entered!: () => void;
    const slow = new Promise<void>((ok) => {
      resume = ok;
    });
    const started = new Promise<void>((ok) => {
      entered = ok;
    });
    const worker = new RecordingHarness('push');
    const submitted: string[] = [];
    let admit!: () => void;
    let receipt = new Promise<void>((ok) => {
      admit = ok;
    });
    const h: Harness = {
      subscribe(fn) {
        wake = fn;
        return () => {
          wake = () => {};
        };
      },
      async submit(req) {
        const r = await worker.submit(req);
        submitted.push(r.runId);
        admit();
        return r;
      },
      poll: (id) => worker.poll(id),
      lookup: (id) => worker.lookup(id),
    };
    const app = make(t, h, {
      runtime: async (...args) => {
        if (args[0].description === 'slow') {
          entered();
          await slow;
          return { answer: 'ok', evidence: [], actions: [] };
        }
        return planner(...args);
      },
    });
    t.after(resume);
    const questions: string[] = [];
    let asked!: () => void;
    const question = new Promise<void>((ok) => {
      asked = ok;
    });
    app.on('work.needs_input', (run) => {
      questions.push(run.id);
      asked();
    });
    const completed: string[] = [];
    const off = app.on('work.completed', (run) => completed.push(run.id));
    app.start();
    const a = app.submit(job());
    await a.routed;
    await receipt;
    const b = app.submit(job('slow'));
    await started;
    worker.complete(submitted[0]!, {
      kind: 'needs_input',
      summary: 'choice',
      question: 'choose',
      options: ['a', 'b'],
    });
    wake();
    await question;
    let done = false;
    void a.done.then(() => {
      done = true;
    });
    await delay(5);
    assert.equal(done, false);
    receipt = new Promise<void>((ok) => {
      admit = ok;
    });
    app.answer({
      actor: 'local-owner',
      attentionId: app.listAttentions()[0]!.id,
      choice: 'a',
    });
    await receipt;
    worker.complete(submitted[1]!, ready('answered'));
    wake();
    const result = await a.done;
    assert.equal(result.outcomes[0]?.report.kind, 'ready');
    assert.equal(result.outcomes[0]?.runId, app.getWork(result.outcomes[0]!.workId)?.results.at(-1)?.runId);
    assert.equal(questions.length, 1);
    assert.equal(completed.length, 1);
    off();
    resume();
    assert.deepEqual((await b.done).outcomes, []);
    await app.stop();
  },
);

test(
  'source push after idle triggers work without a clock; a pull-only worker completes by reconciliation',
  { timeout: 5000 },
  async (t) => {
    let wake = () => {},
      inputs: ReturnType<typeof event>[] = [],
      polls = 0;
    const app = make(
      t,
      {
        ...immediate,
        async poll() {
          return ++polls >= 2 ? ready('pulled') : null;
        },
      },
      {
        sources: [
          {
            name: 'manual',
            subscribe(fn) {
              wake = fn;
              return () => {
                wake = () => {};
              };
            },
            async fetch() {
              return { events: inputs, cursor: null };
            },
          },
        ],
        scheduling: { reconcileMs: 80 },
      },
    );
    const finished = new Promise<void>((ok) => app.on('work.completed', () => ok()));
    app.start();
    await delay(15);
    inputs = [event()];
    wake();
    await finished;
    assert(polls >= 2);
  },
);

test(
  'push source wakes from idle with a one-minute reconciliation deadline',
  { timeout: 5000 },
  async (t) => {
    let notify = () => {},
      sent = false;
    const app = make(t, immediate, {
      sources: [
        {
          name: 'manual',
          subscribe(fn) {
            notify = fn;
            return () => {};
          },
          async fetch() {
            return { events: sent ? [event()] : [], cursor: null };
          },
        },
      ],
    });
    const finished = new Promise<void>((resolve) => app.on('work.completed', () => resolve()));
    app.start();
    await delay(20);
    sent = true;
    notify();
    await finished;
  },
);

test('multiple actions and later followups retain their own outcomes; failed or stopped waiters settle', async (t) => {
  const app = make(t, immediate, {
    runtime: async (req, tools) => {
      if (req.description === 'reject') throw Error('model offline');
      const rows = await tools.call({ tool: 'list_work_items', arguments: {} });
      assert(Array.isArray(rows));
      return {
        answer: 'ok',
        evidence: [],
        actions: (req.description === 'both' ? ['first', 'second'] : ['later']).map((goal) => ({
          goal,
          project: null,
          workId: rows[0]?.id ?? null,
          evidence: [],
        })),
      };
    },
  });
  app.start();
  const first = app.submit(job('both'));
  const results = (await first.done).outcomes;
  assert.equal(results.length, 2);
  const next = app.submit(job('again'));
  assert.equal((await next.done).outcomes.length, 1);
  assert.deepEqual((await app.task(first.id).done).outcomes, results);
  const fail = app.submit(job('reject'));
  await assert.rejects(fail.routed, /model offline/);
  await assert.rejects(fail.done, /model offline/);
  await app.stop();
  const offline = app.submit(job('again'));
  await app.stop();
  await assert.rejects(offline.done, /stopped/);
  app.start();
  assert.equal((await app.task(offline.id).done).outcomes.length, 1);
});

test('lifecycle example finishes the independent submission before resuming the parked one', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const demo = fileURLToPath(new URL('../examples/lifecycle/demo.ts', import.meta.url));
  const output = execFileSync(process.execPath, [demo], { encoding: 'utf8', timeout: 5000 });
  assert.match(output, /第一单 waiting_hook 第二单 done/);
  assert.match(output, /第一单 done.*v2/);
});

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

test(
  'slow model and hook hand back results; no commit or public write overtakes an in-flight host phase',
  { timeout: 5000 },
  async (t) => {
    const model = gate(),
      effect = gate(),
      fetch = gate(),
      resumeFetch = gate(),
      modelStarted = gate(),
      effectStarted = gate();
    let block = false;
    const app = make(t, immediate, {
      sources: [
        {
          name: 'input',
          async fetch() {
            if (block) {
              fetch.open();
              await resumeFetch.wait;
            }
            return { events: [], cursor: null };
          },
        },
      ],
      hooks: [
        {
          id: 'hold',
          phase: 'beforeRoute',
          run(input) {
            return input.kind === 'owner' && input.description === 'held'
              ? { kind: 'wait', reason: 'wait', effect: 'card' }
              : { kind: 'continue' };
          },
          async deliver() {
            effectStarted.open();
            await effect.wait;
            return { kind: 'continue' };
          },
        },
      ],
      runtime: async (...args) => {
        if (args[0].description === 'slow') {
          modelStarted.open();
          await model.wait;
        }
        return planner(...args);
      },
    });
    try {
      app.start();
      const held = app.submit(job('held')),
        slow = app.submit(job('slow'));
      await Promise.all([modelStarted.wait, effectStarted.wait]);
      block = true;
      app.wake();
      await fetch.wait;
      model.open();
      effect.open();
      const input = app.ingest(event());
      await delay(15);
      assert.equal(app.getDispatch(slow.id).status, 'running');
      assert.equal(app.hookStatus('owner', held.id)?.status, 'wait');
      assert.equal(app.getEvent(eventKey(event())), undefined);
      resumeFetch.open();
      await Promise.all([input, slow.done, held.done]);
    } finally {
      model.open();
      effect.open();
      resumeFetch.open();
    }
  },
);

test('one manual step routes a backlog and dispatches within available worker slots', async (t) => {
  const app = make(t, immediate);
  for (let i = 0; i < 4; i++) await app.ingest(event({ externalId: 'batch' + i }));
  await app.step();
  assert.deepEqual(
    Array.from(
      { length: 4 },
      (_, i) => app.getEvent(eventKey(event({ externalId: 'batch' + i })))?.disposition,
    ),
    Array(4).fill('routed'),
  );
  assert.equal(app.listWorks().filter((w) => w.execution.kind === 'running').length, 2);
  assert.equal(app.listWorks().length, 4);
  for (const property of ['state', 'kernel', 'host', 'processNextDispatch', 'dispatch', 'hooks'])
    assert(!(property in app));
});

test('replacing and removing a harness releases its subscription exactly once', async (t) => {
  const calls: string[] = [];
  const h = (name: string) => ({
    ...immediate,
    subscribe() {
      calls.push('+' + name);
      return () => {
        calls.push('-' + name);
      };
    },
  });
  const app = make(t, h('first'));
  app.start();
  await app.setHarness('local', h('second'));
  await app.setHarness('local', undefined);
  await app.stop();
  assert.deepEqual(calls, ['+first', '-first', '+second', '-second']);
});

test('stop rejects both pending waits with ApplicationStoppedError', async (t) => {
  const { ApplicationStoppedError } = await import('work-agent-kernel');
  const app = make(t, immediate),
    task = app.submit(job());
  await app.stop();
  await assert.rejects(task.routed, ApplicationStoppedError);
  await assert.rejects(task.done, ApplicationStoppedError);
});

test('committed completion is observable even when beforeNotify suppresses durable delivery', async (t) => {
  const sink = new MemorySink();
  const app = make(t, immediate, {
    sinks: { inbox: sink },
    hooks: [{ id: 'mute', phase: 'beforeNotify', run: () => ({ kind: 'break', reason: 'muted' }) }],
  });
  const observed = gate();
  app.on('work.completed', () => observed.open());
  const task = app.submit(job());
  await app.step();
  await app.step();
  await observed.wait;
  const result = await task.done;
  const notice = app.getNotice(result.outcomes[0]!.runId!)!;
  assert.equal(notice.state.kind, 'suppressed');
  assert.equal(sink.messages.size, 0);
});

test('application owns target definitions; duplicate registrations preserve work IDs and publish to the planner', async (t) => {
  const catalog = { defaultHarness: 'local', projects: [{ id: 'old', name: 'Old', harness: 'local' }] };
  const options = make(t, immediate, {
    catalog,
    runtime: async (request) => ({
      answer: request.projects.map((p) => p.id + ':' + p.name).join(','),
      evidence: [],
      actions: [],
    }),
  });
  catalog.projects[0]!.name = 'external mutation';
  catalog.projects.push({ id: 'injected', name: 'external', harness: 'local' });
  const spec = {
    target: { id: 'new', name: 'New', harness: 'worker' },
    adapter: immediate,
    sessions: [{ id: 'session-1', title: 'Review' }],
  };
  options.start();
  const registering = options.registerProjectTarget(spec);
  spec.target.name = 'late mutation';
  spec.sessions[0]!.title = 'late mutation';
  const [work] = await registering;
  assert.equal(options.getWork(work!)?.goal, 'Review');
  const visible = options.listProjectTargets();
  visible[0]!.name = 'another mutation';
  assert.equal((await options.submit(job()).routed).result?.answer, 'old:Old,new:New');
  assert.deepEqual(await options.registerProjectTarget(spec), [work]);
  assert.equal(options.listProjectTargets()[1]?.name, 'late mutation');
  assert.equal(options.listWorks().length, 1);
  assert.equal(options.getWork('unknown'), undefined);
});

test('session conflict rolls back the batch and leaves the proposed harness and target available for retry', async (t) => {
  const app = make(t, immediate);
  await app.registerProjectTarget({
    target: { id: 'one', name: 'One', harness: 'local' },
    adapter: immediate,
    sessions: [{ id: 'owned', title: 'Owned' }],
  });
  const target = { id: 'two', name: 'Two', harness: 'new' };
  await assert.rejects(
    app.registerProjectTarget({
      target,
      adapter: immediate,
      sessions: [
        { id: 'draft', title: 'Draft' },
        { id: 'owned', title: 'Conflict' },
      ],
    }),
  );
  await assert.rejects(
    app.registerProjectTarget({
      target: { ...target, harness: 'local' },
      adapter: immediate,
      sessions: [{ id: 'owned', title: 'Same harness, other project' }],
    }),
  );
  assert.deepEqual(
    app.listWorks().map((w) => w.sessionId),
    ['owned'],
  );
  assert.deepEqual(
    app.listProjectTargets().map((p) => p.id),
    ['one'],
  );
  await app.registerProjectTarget({
    target,
    adapter: { ...immediate },
    sessions: [{ id: 'draft', title: 'Retry' }],
  });
  assert.equal(app.listWorks().find((w) => w.sessionId === 'draft')?.projectId, 'two');
});
