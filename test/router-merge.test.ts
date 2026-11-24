import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRouterApplication } from '../src/core/application.ts';
import { RouterInbox } from '../src/adapters/feishu/inbox.ts';
import { feishuIngress, mergeWork } from '../examples/feishu-codex/profile.ts';
import { RecordingHarness } from '../examples/support/adapters.ts';
import { z } from 'zod';
import { ready, running } from './support.ts';

test('approved DM follow-up can inspect running work, attach once, and resume only the worker session', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'router-merge-'));
  const inbox = new RouterInbox(join(dir, 'in.sqlite'));
  inbox.admission.enable('owner');
  const worker = new RecordingHarness('test');
  const calls: string[] = [];
  let workId = '',
    workerSession = '';
  const app = createRouterApplication({
    directory: dir,
    router:{extensions:[mergeWork]},
    catalog: { defaultHarness: 'local', projects: [] },
    signal: new AbortController().signal,
    harnesses: { local: worker },
    sinks: {},
    ingress: [
      feishuIngress(inbox, () => 'local', {
        async send(r) {
          return r.eventId;
        },
        async update() {},
      }),
    ],
    runtime: async (req, tools, _signal, instructions) => {
      assert.match(instructions, /name: merge-work/);
      const text = req.context.at(-1)!.text;
      calls.push(text);
      const rows = await tools.call({ tool: 'list_work_items', arguments: { activeOnly: true } });
      assert(Array.isArray(rows));
      let target: string | null = null;
      if (text === '加回滚步骤' || text === '另起草一份邀请函') {
        assert.equal(req.origin.conversationId, 'chat-A');
        const row = rows.find((w) => w.id === workId);
        assert.equal(row?.sameConversation, true);
        assert.equal(row?.state, 'running');
        assert.equal(row?.workerSessionId, workerSession);
        assert.deepEqual(row?.sourceConversations, [{ source: 'feishu', id: 'chat-A' }]);
        const detail = await tools.call({ tool: 'get_work_item', arguments: { workId } });
        assert.match(JSON.stringify(detail), /上线清单/);
        assert.doesNotMatch(JSON.stringify(detail), /私有元数据/);
        await assert.rejects(tools.call({ tool: 'get_work_item', arguments: { workId: 'invented' } }));
        if (text === '加回滚步骤') {
          const results = z.object({
            items: z.array(z.object({ ref: z.object({ type: z.literal('message'), id: z.string() }) })),
          });
          const items = results.parse(
            await tools.call({ tool: 'find_messages', arguments: { text: '上线清单' } }),
          ).items;
          assert.equal(items.length, 1);
          const ref = items[0]!.ref;
          const history = await tools.call({ tool: 'trace_routing', arguments: { ref } });
          assert.match(JSON.stringify(history), /"action":"create"/);
          assert.match(JSON.stringify(history), new RegExp(workerSession));
          const raw = await tools.call({ tool: 'read_records', arguments: { refs: [ref], view: 'raw' } });
          assert.match(JSON.stringify(raw), /私有元数据/);
          return {
            answer: '补充原清单',
            actions: [{ goal: text, workId, project: null, evidence: [ref.id] }],
            evidence: [],
          };
        }
      }
      if (text === '另一个私聊') {
        const row = rows.find((w) => w.id === workId);
        assert.equal(row?.sameConversation, false);
        const detail = await tools.call({ tool: 'get_work_item', arguments: { workId } });
        assert.doesNotMatch(JSON.stringify(detail), /chat-A|加回滚步骤/);
      }
      return {
        answer: '决策',
        actions: [{ goal: text, workId: target, project: null, evidence: [] }],
        evidence: [],
      };
    },
  });
  t.after(async () => {
    await app.close();
    inbox.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function receive(id: string, chat: string, content: string) {
    const key = inbox.receive({
      message_id: id,
      chat_id: chat,
      chat_type: 'p2p',
      content,
      raw: '私有元数据',
    });
    await app.kernel.collect({ name: inbox.name, fetch: () => inbox.fetchForAdmission() });
    assert.deepEqual(await app.kernel.routeNext(), []);
    assert(!calls.includes(content));
    await app.hooks.deliverNext();
    inbox.admission.submit(key, 'owner', key, { execute: true });
    const ids = await app.kernel.routeNext();
    assert(ids?.[0]);
    return ids[0];
  }
  const first = await receive('m1', 'chat-A', '上线清单');
  workId = first;
  const run = running(await app.kernel.dispatch(first));
  workerSession = run.receipt.sessionId;
  assert.equal(await receive('m2', 'chat-A', '加回滚步骤'), first);
  const trace = app.kernel.factSnapshot().events[JSON.stringify(['feishu', 'm2', '1'])]!.decisions!;
  assert.deepEqual(
    trace.map((d) => [d.action, d.workIds, d.evidence]),
    [['attach', [first], [JSON.stringify(['feishu', 'm1', '1'])]]],
  );
  assert.equal(await app.kernel.dispatch(first), null);
  assert.notEqual(await receive('m3', 'chat-A', '另起草一份邀请函'), first);
  assert.notEqual(await receive('m4', 'chat-B', '另一个私聊'), first);
  worker.complete(run.receipt.runId, ready);
  await app.kernel.poll(run.id);
  const next = running(await app.kernel.dispatch(first));
  assert.equal(next.request.sessionId, workerSession);
  assert.equal(next.request.inputs.length, 1);
  assert.match(next.request.inputs[0]!.text, /加回滚步骤/);
  assert(!JSON.stringify(next.request).includes('name: merge-work'));
});
