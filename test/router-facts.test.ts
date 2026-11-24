import { bindExtensions } from '../src/core/planning/extensions.ts';
import { selectedChats } from '../src/adapters/feishu/selected-chats.ts';
import { ScriptedRouter } from '../examples/support/adapters.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { z } from 'zod';
import { RouterFacts } from '../src/core/planning/facts.ts';
import { RouterInbox } from '../src/adapters/feishu/inbox.ts';
import { emptyState, eventKey, threadKey } from '../src/core/domain.ts';
import type { EventRecord } from '../src/core/domain.ts';
import type { Evidence, PlanningRequest } from '../src/core/planning/contracts.ts';
import { ready, running, setup, createWork, event } from './support.ts';

const page = z.object({
  items: z.array(z.record(z.string(), z.unknown())),
  nextCursor: z.string().nullable(),
});
const invoke = (facts: RouterFacts, tool: string, args: unknown, evidence = new Map<string, Evidence>()) =>
  page.parse(facts.call(tool, args, evidence));
const owner: PlanningRequest = {
  id: 'audit',
  origin: { kind: 'owner', actor: '本人', uri: 'owner://audit' },
  description: '复盘',
  created: '2026-06-20T12:00:00.000Z',
  sources: [],
  context: [],
  projects: [{ id: 'hotel', name: '酒店', selectedSourceIds: [] }],
  candidates: [],
  defaultProject: null,
  maxActions: 0,
};
function archive() {
  const state = emptyState();
  const source = {
    name: 'chat',
    async fetch() {
      return { events: [], cursor: null };
    },
    archiveRecord(e: ReturnType<typeof event>) {
      return {
        projectId: e.thread === 'group' ? 'hotel' : null,
        normalized: { body: e.text },
        raw: { body: e.text },
        admission: e.externalId === 'declined' ? 'stopped' : 'allowed',
      };
    },
  };
  function add(
    id: string,
    chat: string,
    text: string,
    disposition: EventRecord['disposition'] = 'routed',
    revision = '1',
    receivedAt = '2026-06-20T00:00:00.000Z',
  ) {
    const e = event({ source: 'chat', externalId: id, thread: chat, text, revision });
    const key = eventKey(e);
    state.events[key] = {
      event: e,
      key,
      threadKey: threadKey(e.source, e.thread),
      receivedAt,
      disposition,
      deliveries: [],
      reasons: [],
      decisions: [],
      forceRouter: false,
    };
    return key;
  }
  const facts = (request = owner) =>
    new RouterFacts(
      request,
      {
        snapshot: () => structuredClone(state),
        sources: [source],
        archiveSource: 'chat',
        project: () => ({ definition: { name: '酒店' }, bindings: [{ source: 'chat', id: 'group' }] }),
      },
      1,
    );
  return { facts, add, state };
}

test('归档按消息版本分页，查询快照保持不变，完整原文可跨页逐字还原', () => {
  const a = archive();
  const long = '🌾'.repeat(6100) + '最后一句';
  const first = a.add('m1', 'group', long),
    second = a.add('m1', 'group', '改稿', 'routed', '2');
  const facts = a.facts(),
    refs = new Map<string, Evidence>();
  const query = invoke(facts, 'find_messages', { projectId: 'hotel', limit: 1 }, refs);
  assert.equal(query.items[0]?.evidenceId, second);
  assert.deepEqual([...refs.keys()], [second]);
  const cursor = query.nextCursor!;
  a.add('new', 'group', '之后到达');
  assert.throws(() => invoke(a.facts(), 'find_messages', { cursor }));
  assert.throws(() => invoke(facts, 'read_records', { cursor }));
  assert.equal(invoke(facts, 'find_messages', { cursor }, refs).items[0]?.evidenceId, first);
  assert.throws(() => invoke(facts, 'find_messages', { cursor }));
  assert.equal(invoke(facts, 'find_messages', { revisions: 'latest' }).items.length, 1);
  assert.equal(invoke(a.facts(), 'find_messages', { revisions: 'latest' }).items.length, 2);
  let raw = invoke(facts, 'read_records', { refs: [{ type: 'message', id: first }], view: 'raw' });
  let json = String(raw.items[0]?.chunk);
  while (raw.nextCursor) {
    raw = invoke(facts, 'read_records', { cursor: raw.nextCursor });
    json += raw.items[0]?.chunk;
  }
  assert.deepEqual(JSON.parse(json), { availability: 'available', payload: { body: long } });
});

test('私聊、被拦截或过期的记录不能经搜索、引用或追溯越过本轮读取范围', () => {
  const a = archive();
  const group = a.add('g', 'group', '项目消息'),
    dm = a.add('p', 'dm', '私聊消息');
  const hidden = [
    a.add('hold', 'group', '等待', 'waiting_hook'),
    a.add('stop', 'group', '中止', 'stopped'),
    a.add('declined', 'group', '未获准'),
    a.add('fail', 'group', '失败', 'hook_failed'),
  ];
  const old = a.add('old', 'group', '过去的消息', 'ignored', '1', '2026-05-01T00:00:00.000Z');
  const req = { ...owner, sources: [{ id: 'group', name: '群' }] };
  const facts = a.facts(req);
  assert.deepEqual(
    invoke(facts, 'find_messages', {}).items.map((r) => r.evidenceId),
    [group],
  );
  for (const id of [dm, old, ...hidden]) {
    assert.throws(() => invoke(facts, 'read_records', { refs: [{ type: 'message', id }] }));
    assert.throws(() => invoke(facts, 'trace_routing', { ref: { type: 'message', id } }));
  }
  assert.equal(
    invoke(a.facts(), 'find_messages', { conversation: { source: 'chat', id: 'dm' } }).items.length,
    0,
  );
  const incoming = a.facts({
    ...owner,
    id: dm,
    origin: { kind: 'event', actor: 'person', uri: 'event://p', source: 'chat', conversationId: 'dm' },
  });
  assert.deepEqual(
    invoke(incoming, 'find_messages', {}).items.map((r) => r.evidenceId),
    [dm],
  );
  assert.equal(
    invoke(facts, 'find_projects', { conversation: { source: 'chat', id: 'group' } }).items.length,
    1,
  );
  assert.equal(
    invoke(facts, 'find_projects', { conversation: { source: 'other', id: 'group' } }).items.length,
    0,
  );
});

test('旧记录只展示已知状态，适配器区分原始信封未保存、已保存与受限', async (t) => {
  const a = archive(),
    id = a.add('old', 'group', '记录');
  delete a.state.events[id]!.decisions;
  assert.equal(
    invoke(a.facts(), 'trace_routing', { ref: { type: 'message', id } }).items[0]?.completeness,
    'legacy_partial',
  );
  assert.deepEqual(
    invoke(a.facts(), 'trace_routing', { ref: { type: 'message', id } }).items[0]?.decisions,
    [],
  );
  const { directory } = setup(t);
  const inbox = new RouterInbox(join(directory, 'feishu.sqlite'), {
    hotel: { cwd: directory, name: '酒店', groups: [{ id: 'group', name: '群' }] },
  });
  t.after(() => inbox.close());
  for (const [i, raw] of [undefined, { custom: '事实' }, { access_token: 'synthetic' }].entries())
    inbox.receive({ message_id: 'm' + i, chat_id: 'group', content: '原文', raw });
  const { events } = await inbox.fetch();
  assert.equal(events.length, 3);
  const projections = events.map((e) => inbox.archiveRecord(e));
  assert(projections.every((p) => p.projectId === 'hotel' && p.admission === 'not_required'));
  assert.equal(projections[0]!.raw, undefined);
  assert.deepEqual(projections[1]!.raw, { custom: '事实' });
  assert.equal(projections[2]!.rawRestricted, true);
  assert(!JSON.stringify(projections[2]).includes('synthetic'));
});

test('内核记录实际路由和执行，会话、待投递通知和依据可在重启后追溯', async (t) => {
  const { open, harness } = setup(t),
    kernel = open();
  const m1 = event({ thread: 'group' }),
    k1 = eventKey(m1);
  const id = await createWork(kernel, m1, { projectId: 'hotel', evidence: [k1] });
  const run = running(await kernel.dispatch(id));
  harness.complete(run.receipt.runId, ready);
  await kernel.poll(run.id);
  const restored = open(),
    w = restored.work(id);
  const facts = new RouterFacts(
    {
      ...owner,
      origin: { kind: 'event', source: 'manual', conversationId: 'group', actor: 'a', uri: 'u' },
      defaultProject: 'hotel',
      candidates: [{ id, project: 'hotel', goal: w.goal, state: w.execution.kind }],
    },
    { sources: [], snapshot: () => restored.factSnapshot() },
    1,
  );
  const refs = new Map<string, Evidence>();
  const rows = invoke(facts, 'trace_routing', { ref: { type: 'message', id: k1 } }, refs).items;
  assert(refs.has(k1));
  assert.equal((rows[0]!.decisions as { action: string }[])[0]?.action, 'create');
  assert.deepEqual(
    rows.map((r) => r.stage),
    ['routing', 'work', 'run', 'notification'],
  );
  assert.equal(rows[2]?.sessionId, run.receipt.sessionId);
  assert.equal(rows[3]?.state, 'pending');
  assert.equal(invoke(facts, 'find_messages', { projectId: 'hotel' }).items[0]?.evidenceId, k1);
  const result = invoke(facts, 'read_records', { refs: [rows[2]?.ref] }).items[0]?.value;
  assert.match(JSON.stringify(result), /Draft prepared/);
});

test('实时聊天与本地归档分开，预览后的完整正文只能在原请求读取', async () => {
  const a = archive();
  const req = { ...owner, sources: [{ id: 'group', name: '群' }] };
  const full = '完整内容'.repeat(800);
  const facts = a.facts(req);
  const tools = bindExtensions(
    req,
    [
      selectedChats(
        async () => ({
          messages: [{ id: 'live', sender: 'person', time: req.created, text: full, url: 'chat://live' }],
          next: '',
        }),
        () => 1,
      ),
    ],
    { specs: [], call: async () => {} },
    new Map(),
    () => {},
    facts.rememberLive.bind(facts),
  ).agentTools;
  const args = { tool: 'read_selected_chat', arguments: { sourceId: 'group', days: 1, nextPage: false } };
  const live = z
    .object({
      provenance: z.string(),
      messages: z.array(z.object({ text: z.string(), ref: z.object({ type: z.string(), id: z.string() }) })),
    })
    .parse(await tools.call(args));
  assert.equal(live.provenance, 'live_channel');
  assert(live.messages[0]!.text.length < full.length);
  const ref = live.messages[0]!.ref;
  const complete = invoke(facts, 'read_records', { refs: [ref] });
  assert.equal(complete.items[0]!.provenance, 'live_channel');
  assert.equal(
    z.object({ message: z.object({ text: z.string() }) }).parse(complete.items[0]!.value).message.text,
    full,
  );
  assert.deepEqual(invoke(facts, 'find_messages', {}).items, []);
  assert.throws(() => invoke(a.facts(req), 'read_records', { refs: [ref] }));
  await assert.rejects(tools.call({ ...args, arguments: { ...args.arguments, sourceId: 'other' } }));
});

test('同一事项有其他会话输入时，追溯只列可见输入并限制运行与交付详情', async (t) => {
  const { open, harness } = setup(t);
  const kernel = open(),
    first = event({ thread: 'group' }),
    second = event({ thread: 'dm', externalId: 'private', text: '个人材料' });
  const id = await createWork(kernel, first, { projectId: 'hotel' });
  kernel.ingest(second);
  kernel.router = new ScriptedRouter([{ kind: 'attach', workId: id, reason: '同事项' }]);
  await kernel.routeNext();
  const run = running(await kernel.dispatch(id));
  harness.complete(run.receipt.runId, ready);
  await kernel.poll(run.id);
  const req = {
    ...owner,
    id: eventKey(first),
    origin: { kind: 'event' as const, source: 'manual', conversationId: 'group', actor: 'a', uri: 'u' },
    candidates: [{ id, project: 'hotel', goal: '检查', state: 'ready' }],
  };
  const facts = new RouterFacts(req, { snapshot: () => kernel.factSnapshot(), sources: [] }, 1);
  const ref = { type: 'work', id };
  const visible = invoke(facts, 'read_records', { refs: [ref] }).items[0]!.value;
  assert.deepEqual(
    z.object({ scope: z.literal('limited'), inputs: z.array(z.string()) }).parse(visible).inputs,
    [eventKey(first)],
  );
  assert.doesNotMatch(JSON.stringify(visible), /个人材料/);
  const trace = invoke(facts, 'trace_routing', { ref }).items;
  assert.deepEqual(
    trace.map((r) => r.stage),
    ['input', 'work'],
  );
  for (const type of ['run', 'notice'])
    assert.throws(() => invoke(facts, 'read_records', { refs: [{ type, id: run.id }] }));
});
