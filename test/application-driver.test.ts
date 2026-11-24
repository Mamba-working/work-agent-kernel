import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createRouterApplication, type ApplicationOptions } from '../src/core/application.ts';
import type { Harness } from '../src/core/ports.ts';
import type { PlanningRuntime } from '../src/core/planning/contracts.ts';
import { RecordingHarness, MemorySink } from '../examples/support/adapters.ts';
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
  assert.equal(Object.values(app.kernel.factSnapshot().runs).length, 0);
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
    app.answer({ actor: 'local-owner', attentionId: app.kernel.attentions()[0]!.id, choice: 'a' });
    await receipt;
    worker.complete(submitted[1]!, ready('answered'));
    wake();
    const result = await a.done;
    assert.equal(result.outcomes[0]?.report.kind, 'ready');
    assert.equal(result.outcomes[0]?.runId, Object.values(app.kernel.factSnapshot().runs)[1]?.id);
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
