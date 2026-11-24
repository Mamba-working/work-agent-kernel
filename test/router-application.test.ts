import { z } from 'zod';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRouterApplication } from '../src/core/application.ts';
import { RecordingHarness } from '../examples/support/adapters.ts';
import type { PlanningRequest, PlanningRuntime } from '../src/core/planning/contracts.ts';
import { RouterInbox } from '../src/adapters/feishu/inbox.ts';
import { inboxContext } from '../src/adapters/feishu/context.ts';
import { event, ready, running } from './support.ts';

function directory(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'router-application-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
const signal = new AbortController().signal;
const goal = '补充验收清单';
const catalog = {
  defaultHarness: 'test-worker',
  projects: [{ id: 'p', name: '项目', harness: 'test-worker' }],
};
const action = (workId: string | null) => ({
  answer: '处理清单',
  evidence: [],
  actions: [{ goal, workId, project: 'p', evidence: [] }],
});

test('owner and admitted message use the same planner, project and session with a replacement worker', async (t) => {
  const dir = directory(t);
  const inbox = new RouterInbox(join(dir, 'in.sqlite'), { p: { name: '项目', cwd: dir } });
  inbox.admission.enable('owner-test');
  const calls: PlanningRequest[] = [];
  const runtime: PlanningRuntime = async (request, tools) => {
    calls.push(request);
    const response = await tools.call({ tool: 'list_work_items', arguments: {} });
    assert(response);
    return action(request.candidates[0]?.id ?? null);
  };
  const worker = new RecordingHarness('replacement');
  const app = createRouterApplication({
    directory: dir,
    catalog,
    runtime,
    signal,
    harnesses: { 'test-worker': worker },
    sources: [inbox],
    eventContexts: { [inbox.name]: inboxContext(inbox, () => 'test-worker') },
    sinks: {},
  });
  t.after(() => {
    app.close();
    inbox.close();
  });
  const job = app.dispatch.submit({ id: randomUUID(), sources: [], description: goal });
  await app.processNextDispatch();
  const [original] = app.kernel.works();
  assert(original);
  assert.deepEqual(app.dispatch.get(job.id).workIds, [original.id]);
  const first = running(await app.kernel.dispatch(original.id));
  worker.complete(first.receipt.runId, ready);
  await app.kernel.poll(first.id);

  const message = { message_id: 'm', chat_id: 'demo', chat_type: 'group', content: '原清单再补充一点' };
  const id = inbox.receive(message);
  await app.kernel.collect(inbox);
  assert.equal(await app.kernel.routeNext(), null);
  const channel = {
    async send() {
      return 'card';
    },
    async update() {},
  };
  await inbox.admission.deliverOne(channel);
  inbox.admission.submit(id, 'owner-test', 'card', { project: 'p', execute: true });
  await app.kernel.collect(inbox);
  assert.deepEqual(await app.kernel.routeNext(), [original.id]);
  const second = running(await app.kernel.dispatch(original.id));
  assert.equal(second.request.sessionId, first.receipt.sessionId);
  assert.deepEqual(
    calls.map((r) => r.origin.kind),
    ['owner', 'event'],
  );
  assert.equal(calls[1]?.defaultProject, 'p');

  // Even a revision of a previously linked message reaches the common planner.
  inbox.receive({ ...message, revision: '2', content: '清单第二版' });
  await app.kernel.collect(inbox);
  assert.deepEqual(await app.kernel.routeNext(), [original.id]);
  assert.equal(calls.length, 3);
});

test('application runs with a custom source, reader, model and harness, with both vendor adapters absent', async (t) => {
  const dir = directory(t);
  const e = event({ source: 'calendar', actor: 'scheduler', text: goal });
  const seen: string[] = [];
  const runtime: PlanningRuntime = async (request, tools) => {
    seen.push(request.origin.kind);
    for (const source of request.sources) {
      await tools.call({
        tool: 'read_calendar',
        arguments: { sourceId: source.id, days: 1, nextPage: false },
      });
    }
    return { answer: '分析完成', actions: [], evidence: request.sources.length ? ['entry'] : [] };
  };
  const app = createRouterApplication({
    directory: dir,
    catalog,
    signal,
    runtime,
    harnesses: { 'test-worker': new RecordingHarness('fixture') },
    sinks: {},
    sources: [
      {
        name: 'calendar',
        async fetch() {
          return { events: [e], cursor: null };
        },
      },
    ],
    router: {
      extensions: [
        (request) =>
          request.origin.kind === 'owner'
            ? {
                tools: [
                  {
                    name: 'read_calendar',
                    description: 'Read the selected calendar',
                    schema: z.object({ sourceId: z.string() }),
                    async run(input) {
                      const { sourceId } = z.object({ sourceId: z.string() }).parse(input);
                      assert(request.sources.some((s) => s.id === sourceId));
                      return {
                        evidence: [{ id: 'entry', chat: 'calendar', time: '', url: '' }],
                        value: 'entry',
                      };
                    },
                  },
                ],
              }
            : undefined,
      ],
    },
  });
  t.after(() => app.close());
  const job = app.dispatch.submit({
    id: randomUUID(),
    description: '仅分析',
    sources: [{ id: 'calendar-local', name: '日程' }],
  });
  await app.processNextDispatch();
  assert.equal(app.dispatch.get(job.id).refs[0]?.id, 'entry');
  assert.deepEqual(await app.host.tick(), []);
  assert.deepEqual(seen, ['owner', 'event']);
  assert.equal(app.kernel.events()[0]?.disposition, 'ignored');
  assert.equal(app.kernel.works().length, 0);
});

test('both entries reject an invented project before dispatch', async (t) => {
  const dir = directory(t);
  const app = createRouterApplication({
    directory: dir,
    catalog,
    runtime: async () => ({
      ...action(null),
      actions: [{ goal, project: 'missing', workId: null, evidence: [] }],
    }),
    signal,
    harnesses: { 'test-worker': new RecordingHarness('fixture') },
    sinks: {},
  });
  t.after(() => app.close());
  const job = app.dispatch.submit({ id: randomUUID(), sources: [], description: goal });
  await app.processNextDispatch();
  assert.equal(app.dispatch.get(job.id).status, 'failed');
  app.kernel.ingest(event());
  await assert.rejects(app.kernel.routeNext(), /未知项目/);
  assert.equal(app.kernel.events()[0]?.disposition, 'pending');
  assert.equal(app.kernel.works().length, 0);
});

test('a project survives changing execution adapters; shared harnesses do not merge project scope', async (t) => {
  const dir = directory(t);
  const projects = ['a', 'b'].map((id) => ({ id, name: id, harness: 'shared' }));
  const seen: string[][] = [];
  const app = createRouterApplication({
    directory: dir,
    catalog: { defaultHarness: 'shared', projects },
    signal,
    eventContexts: { manual: (_key, text) => ({ text, project: { id: 'a', name: 'A', harness: 'shared' } }) },
    runtime: async (r) => {
      seen.push(r.candidates.map((w) => w.project ?? ''));
      return { answer: 'ignore', actions: [], evidence: [] };
    },
    harnesses: { shared: new RecordingHarness('worker'), other: new RecordingHarness('replacement') },
    sinks: {},
  });
  t.after(() => app.close());
  const a = app.kernel.registerSession('shared', 'session-A', 'goal A', 'a');
  app.kernel.registerSession('shared', 'session-B', 'goal B', 'b');
  app.kernel.rebind(a, 'other');
  app.kernel.ingest(event());
  await app.kernel.routeNext();
  assert.deepEqual(seen, [['a']]);
  assert.equal(app.kernel.work(a).projectId, 'a');
});

test('reopening an old database records the original project before an adapter handoff', async (t) => {
  const dir = directory(t);
  const { Kernel } = await import('../src/core/kernel.ts');
  const original = new RecordingHarness('old');
  const old = new Kernel({ path: join(dir, 'kernel.sqlite'), harnesses: { 'old/project': original } });
  const id = old.registerSession('old/project', 'historic-session', 'historic work');
  old.close();
  const shared = {
    directory: dir,
    signal,
    sinks: {},
    runtime: async () => ({ answer: 'idle', actions: [], evidence: [] }),
  };
  const app = createRouterApplication({
    ...shared,
    catalog: { defaultHarness: 'new', projects: [{ id: 'p', name: 'P', harness: 'old/project' }] },
    harnesses: { 'old/project': original, new: new RecordingHarness('new') },
  });
  assert.equal(app.kernel.work(id).sessionId, 'historic-session');
  assert.equal(app.kernel.work(id).projectId, 'p');
  app.kernel.rebind(id, 'new');
  app.close();
  const reopened = createRouterApplication({
    ...shared,
    catalog: { defaultHarness: 'new', projects: [{ id: 'p', name: 'P', harness: 'new' }] },
    harnesses: { new: new RecordingHarness('new') },
  });
  t.after(() => reopened.close());
  assert.equal(reopened.kernel.work(id).projectId, 'p');
});

test('unconfigured router offers only framework tools on both entry points', async (t) => {
  const seen: string[] = [];
  const app = createRouterApplication({
    directory: directory(t),
    catalog,
    signal,
    harnesses: { 'test-worker': new RecordingHarness('fixture') },
    sinks: {},
    runtime: async (req, tools, _signal, instructions) => {
      seen.push(req.origin.kind);
      const names = tools.specs.map((spec) => Reflect.get(spec, 'name'));
      assert(names.includes('list_work_items'));
      assert.doesNotMatch(instructions, /merge-work|read_selected_chat|read_incoming_context/);
      for (const name of ['read_selected_chat', 'read_incoming_context']) {
        assert(!names.includes(name));
        await assert.rejects(tools.call({ tool: name, arguments: {} }));
      }
      return { answer: 'ok', actions: [], evidence: [] };
    },
  });
  t.after(() => app.close());
  app.kernel.ingest(event({ source: 'feishu' }));
  await app.kernel.routeNext();
  const job = app.dispatch.submit({
    id: randomUUID(),
    description: '分析',
    sources: [{ id: 'group', name: 'source' }],
  });
  await app.processNextDispatch();
  assert.deepEqual(seen, ['event', 'owner']);
  assert.equal(app.dispatch.get(job.id).status, 'done');
  assert.equal(app.kernel.works().length, 0);
});
