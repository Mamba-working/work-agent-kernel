import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { bindExtensions } from '../src/core/planning/extensions.ts';
import type { PlanningRequest, PlanningRuntime } from '../src/core/planning/contracts.ts';
import { createManualTestApplication as createRouterApplication } from '../src/core/application.ts';
import { EventKey } from '../src/core/domain.ts';
import { RouterInbox } from '../src/adapters/feishu/inbox.ts';
import { projectWorker } from '../src/adapters/feishu/context.ts';
import { parseSubmission, renderAdmission } from '../src/adapters/feishu/card.ts';
import { feishuIncomingContext } from '../src/adapters/feishu/incoming-context.ts';
import { feishuIngress } from '../examples/feishu-codex/profile.ts';
import { codexPlanner } from '../src/adapters/codex/planner.ts';
import { CodexHarness } from '../src/adapters/codex/harness.ts';
import { RecordingHarness } from '../examples/support/adapters.ts';
import { running } from './support.ts';

const request: PlanningRequest = {
  id: 'test',
  origin: { kind: 'owner', uri: 'test://', actor: 'owner' },
  sources: [],
  created: new Date().toISOString(),
  context: [],
  projects: [],
  candidates: [],
  maxActions: 1,
  defaultProject: null,
  description: 'test',
};
test('扩展按请求启用，跳过必读、伪造参数和重名注册均被拒绝', async () => {
  const tool = {
    name: 'read_fixture',
    description: 'read',
    schema: z.strictObject({}),
    required: true,
    async run() {
      return { value: 'ok' };
    },
  };
  const base = {
    specs: [],
    async call() {
      throw Error('未注册');
    },
  };
  const mount = () => ({ instructions: 'fixture', tools: [tool] });
  const make = () => bindExtensions(request, [mount], base, new Map(), () => {});
  const active = make();
  assert.throws(active.verify);
  await assert.rejects(active.agentTools.call({ tool: 'read_fixture', arguments: { chat: 'other' } }));
  assert.throws(active.verify);
  await active.agentTools.call({ tool: 'read_fixture', arguments: {} });
  active.verify();
  assert.throws(make().verify);
  assert.throws(() => bindExtensions(request, [mount, mount], base, new Map(), () => {}), /Duplicate/);
  assert.deepEqual(
    bindExtensions(request, [() => undefined], base, new Map(), () => {}).agentTools.specs,
    [],
  );
});

test('从批准卡到同一 worker：补充信息只存在于飞书上文', async (t) => {
  const live = process.env.ROUTER_CONTEXT_LIVE_CODEX === '1';
  const dir = mkdtempSync(join(tmpdir(), 'router-context-'));
  const workspace = join(dir,'workspace');
  mkdirSync(workspace);
  const until = new Date(Date.now() - 7200000).toISOString();
  const delta = randomInt(2000, 9000);
  const cli = join(dir, 'lark-fixture.mjs'),
    calls = join(dir, 'calls.jsonl');
  const message = (id: string, text: string, offset: number) => ({
    message_id: id,
    create_time: new Date(Date.parse(until) + offset).toISOString(),
    sender: { name: 'Test' },
    content: text,
    chat_id: 'oc_sample',
  });
  const upstream = message(
    'om_reference',
    '刚才的算术验收事项：在上次的 126 上增加 ' + delta + '，仅返回新数值。',
    -1000,
  );
  writeFileSync(
    cli,
    `#!/usr/bin/env node
import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
assert.equal(args[0],'im');assert.equal(args[args.indexOf('--as')+1],'user');
appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
let messages;
if(args[1]==='+messages-mget'){
  assert.equal(args[args.indexOf('--message-ids')+1],'om_reference');messages=[${JSON.stringify(upstream)}];
}else{
  assert.equal(args[1],'+chat-messages-list');assert.equal(args[args.indexOf('--chat-id')+1],'oc_sample');
  assert.equal(args[args.indexOf('--end')+1],${JSON.stringify(until)});
  messages=${JSON.stringify([message('om_future', '晚到的信息', 9000), message('om_deleted', '删除的信息', -10)].map((m, i) => ({ ...m, deleted: i === 1 })))};
}
console.log(JSON.stringify({ok:true,data:{messages}}));`,
    { mode: 0o700 },
  );
  const prior = process.env.LARK_CLI_BIN;
  process.env.LARK_CLI_BIN = cli;
  t.after(() => {
    if (prior === undefined) delete process.env.LARK_CLI_BIN;
    else process.env.LARK_CLI_BIN = prior;
  });
  const inbox = new RouterInbox(join(dir, 'feishu.sqlite'));
  inbox.admission.enable('owner');
  const recording = new RecordingHarness('test');
  const codex = live
    ? new CodexHarness({
        executable: 'codex',
        cwd: workspace,
        directory: join(dir, 'worker'),
        useDesktopDefaults: true,
      })
    : undefined;
  const runtime: PlanningRuntime = async (req, tools, _signal, instructions) => {
    const hasTool = tools.specs.some((s) => (s as { name: string }).name === 'read_incoming_context');
    const evidence: string[] = [];
    if (hasTool) {
      assert.match(instructions, /先调用 read_incoming_context/);
      const result = await tools.call({ tool: 'read_incoming_context', arguments: {} });
      const { messages } = z
        .object({ messages: z.array(z.object({ text: z.string(), evidenceId: z.string() })) })
        .parse(result);
      assert.deepEqual(
        messages.map((m) => m.text),
        [upstream.content],
      );
      evidence.push(messages[0]!.evidenceId);
    }
    const rows = z
      .array(z.object({ id: z.string() }))
      .parse(await tools.call({ tool: 'list_work_items', arguments: {} }));
    return {
      answer: '算术验收',
      actions: [{ goal: req.context.at(-1)!.text, project: null, workId: rows[0]?.id ?? null, evidence }],
      evidence,
    };
  };
  const app = createRouterApplication({
    directory: dir,
    catalog: { defaultHarness: 'local', projects: [] },
    runtime: live ? codexPlanner('codex') : runtime,
    router: { archiveTools:true, extensions: [feishuIncomingContext(inbox)] },
    signal: new AbortController().signal,
    ingress: [
      feishuIngress(inbox, () => 'local', {
        async send(r) {
          return 'om_' + r.eventId;
        },
        async update() {},
      }),
    ],
    harnesses: {
      local: projectWorker(
        null,
        inbox,
        (k) => app.kernel.event(EventKey.parse(k)).event.text,
        codex ?? recording,
        (k) => app.kernel.event(EventKey.parse(k)).decisions?.at(-1)?.evidence ?? [],
      ),
    },
    sinks: {},
  });
  t.after(async () => {
    await codex?.close();
    await app.close();
    inbox.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function receive(id: string, content: string, execution: string) {
    const key = inbox.receive({
      message_id: id,
      chat_id: '12345',
      chat_type: 'p2p',
      sender: 'Test',
      content,
      occurred_at: until,
      ...(id === 'followup' ? { parent_message_id: 'om_reference' } : {}),
    });
    await app.kernel.collect({ name: inbox.name, fetch: () => inbox.fetchForAdmission() });
    assert.deepEqual(await app.kernel.routeNext(), []);
    await app.hooks.deliverNext();
    const card = inbox.admission.get(key)!;
    const payload = {
      type: 'card.action.trigger',
      action_tag: 'button',
      action_name: 'router_admit_' + key,
      operator_id: 'owner',
      message_id: card.receipt,
      form_value: { execution, source_chat: 'oc_sample' },
    };
    assert.match(
      JSON.stringify(renderAdmission(card, {}, { chats: [{ id: 'oc_sample', name: '样例' }] })),
      /读取本会话上文/,
    );
    const reply = parseSubmission(payload)!;
    inbox.admission.submit(key, reply.actor, reply.receipt, reply.choice);
    const ids = await app.kernel.routeNext();
    return { key, ids };
  }
  const first = await receive('initial', '新建算术验收事项，计算 18 × 7，仅返回数值。', 'run');
  const work = first.ids![0]!;
  async function complete(value: number) {
    const run = running(await app.kernel.dispatch(work));
    if (!live)
      recording.complete(run.receipt.runId, { kind: 'ready', summary: String(value), evidence: ['fixture'] });
    for (let i = 0; i < 600; i++) {
      await app.kernel.poll(run.id);
      if (app.kernel.work(work).execution.kind !== 'running') break;
      await delay(250);
    }
    assert.equal(app.kernel.work(work).execution.kind, 'ready');
    assert.match(app.kernel.work(work).results.at(-1)!.report.summary, new RegExp(String(value)));
    return run.receipt.sessionId;
  }
  const session = await complete(126);
  assert.equal(inbox.admission.context.permission(first.key), undefined);
  const stopped = await receive('stopped', '闲聊', 'stop');
  assert.deepEqual(stopped.ids, []);
  assert.equal(inbox.admission.context.read(stopped.key), undefined);
  const next = await receive('followup', '请按我刚才说的增量，继续原来那件事，只给新数值。', 'run_context');
  assert.deepEqual(next.ids, [work]);
  assert.equal(inbox.admission.context.address('12345'), 'oc_sample');
  assert.equal(inbox.admission.boundProject('12345'), null);
  const read = inbox.admission.context.read(next.key)!;
  assert.equal(read.status, 'read');
  assert.deepEqual(
    read.messages.map((m) => m.text),
    [upstream.content],
  );
  const decision = app.kernel
    .event(EventKey.parse(JSON.stringify(['feishu', 'followup', '1'])))
    .decisions!.at(-1)!;
  assert.equal(decision.action, 'attach');
  assert(decision.evidence.includes('om_reference'));
  assert.equal(await complete(126 + delta), session);
  if (!live) assert(recording.requests.at(-1)!.inputs[0]!.text.includes(upstream.content));
  assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 2);
});

test('同一地址跨重启复用；私聊逐条批准；错误操作者和重复卡片不能改变映射', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'router-grant-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'input.sqlite');
  let inbox = new RouterInbox(file);
  inbox.admission.enable('owner');
  const card = async (message_id: string) => {
    const id = inbox.receive({ message_id, chat_id: '123', chat_type: 'p2p', content: 'test' });
    await inbox.admission.sendPending(id, {
      async send() {
        return id;
      },
      async update() {},
    });
    return id;
  };
  const first = await card('a');
  assert.throws(() =>
    inbox.admission.submit(first, 'other', first, { execute: true, readContext: true, openChat: 'oc_wrong' }),
  );
  inbox.admission.submit(first, 'owner', first, { execute: true, readContext: true, openChat: 'oc_right' });
  inbox.close();
  inbox = new RouterInbox(file);
  t.after(() => inbox.close());
  const next = await card('b');
  assert.equal(inbox.admission.context.permission(next), undefined);
  inbox.admission.submit(next, 'owner', next, { execute: true, readContext: true });
  inbox.admission.submit(first, 'owner', first, { execute: true, readContext: true, openChat: 'oc_wrong' });
  assert.deepEqual(inbox.admission.context.permission(next), { chat: 'oc_right' });
  assert.equal(inbox.admission.boundProject('123'), null);
});

for (const status of ['unmapped', 'empty', 'unavailable'] as const)
  test('准入后的读取状态单独记录：' + status, async (t) => {
    const inbox = new RouterInbox(':memory:');
    t.after(() => inbox.close());
    inbox.admission.enable('owner');
    const chat = '123';
    const key = inbox.receive({ message_id: 'a', content: '补充', chat_id: chat, chat_type: 'p2p' });
    await inbox.admission.sendPending(key, {
      async send() {
        return key;
      },
      async update() {},
    });
    inbox.admission.submit(key, 'owner', key, {
      execute: true,
      readContext: true,
      ...(status === 'unmapped' ? {} : { openChat: 'ou_fixture' }),
    });
    let calls = 0;
    const ext = feishuIncomingContext(inbox, async (target) => {
      calls++;
      assert.equal(target, 'ou_fixture');
      if (status === 'unavailable') throw Error('no permission');
      return [];
    });
    const req = {
      ...request,
      id: JSON.stringify(['feishu', 'a', '1']),
      origin: {
        kind: 'event' as const,
        source: 'feishu',
        uri: 'local://a',
        actor: 'test',
        receivedAt: request.created,
        conversationId: chat,
      },
    };
    assert.equal(ext(request,{log:()=>{}}), undefined);
    const base = {
      specs: [],
      async call() {
        throw Error('unregistered');
      },
    };
    for (let i = 0; i < 2; i++) {
      const run = bindExtensions(req, [ext], base, new Map(), () => {});
      assert.deepEqual(
        ((await run.agentTools.call({ tool: 'read_incoming_context', arguments: {} })) as { status: string })
          .status,
        status,
      );
      run.verify();
    }
    assert.equal(calls, status === 'unmapped' ? 0 : 1);
    assert.equal(inbox.admission.context.read(key)?.status, status);
  });
