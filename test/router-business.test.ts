import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { RecordingHarness } from '../examples/support/adapters.ts';
import { Kernel } from '../src/core/kernel.ts';
import { EventKey } from '../src/core/domain.ts';
import { RouterInbox } from '../src/adapters/feishu/inbox.ts';
import { projectRouter as eventRouter, projectWorker } from '../src/adapters/feishu/context.ts';
import type { DecisionInput } from '../src/adapters/feishu/context.ts';
import { ready, running } from './support.ts';

function projectRouter(inbox: RouterInbox, decide: (input:DecisionInput)=>Promise<unknown>) {
  return eventRouter(inbox,decide,id=>'codex/'+id);
}
const create = { kind: 'create', reason: '明确任务', goal: '检查发布清单', harness: 'codex' };
const ignore = { kind: 'ignore', reason: '仅存档' };
function setup(t: TestContext) {
  const inbox = new RouterInbox(':memory:', {
    a: { name: 'A', cwd: '.', feishuChatId: 'groupA' },
    b: { name: 'B', cwd: '.', feishuChatId: 'groupB' },
  });
  const workers = {
    codex: new RecordingHarness('default'),
    'codex/a': new RecordingHarness('A'),
    'codex/b': new RecordingHarness('B'),
  };
  const k = new Kernel({ path: ':memory:', harnesses: workers });
  k.harnesses.set(
    'codex',
    projectWorker(null, inbox, (key) => k.recall().event(EventKey.parse(key)).text, workers.codex),
  );
  k.harnesses.set(
    'codex/a',
    projectWorker('a', inbox, (key) => k.recall().event(EventKey.parse(key)).text, workers['codex/a']),
  );
  t.after(() => {
    inbox.close();
    k.close();
  });
  let index = 0;
  const contexts: DecisionInput[] = [];
  async function route(chat: string, content: string, decision: unknown) {
    inbox.receive({ message_id: String(++index), chat_id: chat, content });
    await k.collect(inbox);
    k.router = projectRouter(inbox, async (input) => {
      contexts.push(input);
      return decision;
    });
    return (await k.routeNext())!;
  }
  return { inbox, k, workers, contexts, route };
}
for (const [label, chat, msg] of [
  ['私聊闲聊', 'dm', '早上好'],
  ['绑定群闲聊', 'groupA', '哈哈哈'],
  ['未绑定群闲聊', 'other', '谢谢大家'],
  ['仅背景', 'groupA', '备案：发布日是周五，无需执行'],
] as const) {
  test(label + '：ignore 后消息仍可查，事项和 worker 均为零', async (t) => {
    const f = setup(t);
    assert.deepEqual(await f.route(chat, msg, ignore), []);
    assert.equal(f.k.events()[0]?.disposition, 'ignored');
    assert.equal(f.k.works().length, 0);
    assert.equal(f.k.notices().length, 0);
    assert(Object.values(f.workers).every((w) => w.requests.length === 0));
    assert.equal((await f.inbox.fetch()).events.length, 1);
  });
}
for (const [label, chat, harness] of [
  ['群明确任务', 'groupA', 'codex/a'],
  ['另一项目群', 'groupB', 'codex/b'],
  ['私聊明确任务', 'dm', 'codex'],
  ['未绑定群任务', 'other', 'codex'],
] as const) {
  test(label + '：新建后仅派给选中的执行器', async (t) => {
    const f = setup(t),
      [id] = await f.route(chat, '请准备一份发布清单', create);
    assert(id);
    assert.equal(f.k.work(id).harness, harness);
    await f.k.dispatch(id);
    assert.equal(f.workers[harness].requests.length, 1);
    assert.equal(Object.values(f.workers).flatMap((w) => w.requests).length, 1);
  });
}
test('同群的独立需求持有不同事项与会话', async (t) => {
  const f = setup(t);
  const [a] = await f.route('groupA', '请检查库存接口', create);
  const [b] = await f.route('groupA', '请起草会员公告', { ...create, goal: '起草公告' });
  assert(a && b);
  assert.notEqual(a, b);
  await f.k.dispatch(a);
  await f.k.dispatch(b);
  assert.notEqual(f.k.work(a).sessionId, f.k.work(b).sessionId);
});
test('已完成事项续接原 session，携带新输入与旧结果', async (t) => {
  const f = setup(t),
    [id] = await f.route('groupA', '请列发布清单', create);
  assert(id);
  const first = running(await f.k.dispatch(id));
  const session = f.k.work(id).sessionId;
  f.workers['codex/a'].complete(first.receipt.runId, ready);
  await f.k.poll(first.id);
  assert.deepEqual(await f.route('groupA', '原清单再加回滚步骤', { kind: 'attach', workId: id, reason: '续接' }), [
    id,
  ]);
  await f.k.dispatch(id);
  const request = f.workers['codex/a'].requests[1];
  assert.equal(request?.sessionId, session);
  assert.equal(request?.priorResults.length, 1);
  assert.equal(f.k.works().length, 1);
});
test('背景虽被忽略，仍可供路由和 worker 使用；不混入邻群', async (t) => {
  const f = setup(t);
  await f.route('groupA', '发布代号青玉', ignore);
  await f.route('groupB', '发布代号橙色', ignore);
  const [id] = await f.route('groupA', '本轮代号是什么？', create);
  assert(id);
  assert.deepEqual(
    f.contexts.at(-1)?.projectMessages?.map((m) => m.text),
    ['发布代号青玉'],
  );
  await f.k.dispatch(id);
  const body = f.workers['codex/a'].requests[0]!.inputs[0]!.text;
  assert.match(body, /青玉/);
  assert.doesNotMatch(body, /橙色/);
});
test('绑定群的候选事项只包括本项目', async (t) => {
  const f = setup(t);
  await f.route('groupA', 'A 事项', create);
  await f.route('groupB', 'B 事项', create);
  await f.route('groupA', '收到', ignore);
  assert.deepEqual(
    f.contexts.at(-1)?.candidates.map((w) => w.harness),
    ['codex/a'],
  );
});
test('模型误选跨项目 attach 被拒绝且消息可重试', async (t) => {
  const f = setup(t),
    [id] = await f.route('groupB', 'B 事项', create);
  assert(id);
  await assert.rejects(
    f.route('groupA', 'A 追问', { kind: 'attach', workId: id, reason: '误选' }),
    /cross-project/,
  );
  assert.equal(f.k.events().at(-1)?.disposition, 'pending');
  assert.equal(f.k.work(id).inputs.length, 1);
  f.k.router = projectRouter(f.inbox, async () => create);
  assert.equal((await f.k.routeNext())?.length, 1);
});
test('无绑定时拒绝模型编造的执行器', async (t) => {
  const f = setup(t);
  await assert.rejects(f.route('dm', '处理', { ...create, harness: 'missing' }), /Unknown harness/);
  assert.equal(f.k.works().length, 0);
});
test('无效模型决策不启动任务', async (t) => {
  const f = setup(t);
  await assert.rejects(f.route('groupA', '处理', { kind: 'publish' }));
  assert.equal(f.k.events().at(-1)?.disposition, 'pending');
  assert.equal(f.k.works().length, 0);
});
test('不得由群消息把 prepare 扩到 execute', async (t) => {
  const f = setup(t);
  await assert.rejects(f.route('groupA', '执行', { ...create, scope: 'execute' }), /Scope/);
  assert.equal(f.k.works().length, 0);
});
test('首条长消息送给项目 worker 时仍是完整正文', async (t) => {
  const f = setup(t),
    [id] = await f.route('groupA', '长'.repeat(2100) + '结束', create);
  assert(id);
  await f.k.dispatch(id);
  const input = f.workers['codex/a'].requests[0]!.inputs[0]!;
  assert.equal(input.truncated, false);
  assert.match(input.text, /结束/);
});

test('长私聊进入通用 worker：正文完整且不带其他项目背景', async (t) => {
  const f = setup(t);
  await f.route('groupB', '保密代号', ignore);
  const [id] = await f.route('dm', '很长'.repeat(1500) + '私聊末尾', create);
  assert(id);
  await f.k.dispatch(id);
  const input = f.workers.codex.requests[0]!.inputs[0]!;
  assert.equal(input.truncated, false);
  assert.match(input.text, /私聊末尾/);
  assert.doesNotMatch(input.text, /保密代号/);
});
test('决策失败后重新采集：同一条入库消息能够重新路由', async (t) => {
  const f = setup(t);
  await assert.rejects(f.route('groupA', '请派单', { kind: 'invalid' }));
  await f.k.collect(f.inbox);
  f.k.router = projectRouter(f.inbox, async () => create);
  const ids = await f.k.routeNext();
  assert.equal(ids?.length, 1);
  assert.equal(f.k.events().length, 1);
  assert.equal(await f.k.routeNext(), null);
});

test('模型只收到业务正文，传输封装不会成为派单指令', async (t) => {
  const f = setup(t);
  f.inbox.receive({
    message_id: 'audit',
    chat_id: 'groupA',
    content: '{"text":"请汇总清单"}',
    raw: { privateAdapterField: 'not-for-model' },
  });
  await f.k.collect(f.inbox);
  let captured: DecisionInput | undefined;
  f.k.router = projectRouter(f.inbox, async (input) => {
    captured = input;
    return create;
  });
  await f.k.routeNext();
  assert.equal(captured?.event.text, '请汇总清单');
  assert(!JSON.stringify(captured).includes('not-for-model'));
});
