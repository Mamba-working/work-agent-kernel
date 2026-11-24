import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRouterApplication } from '../src/core/application.ts';
import { RouterInbox } from '../src/adapters/feishu/inbox.ts';
import { feishuIngress } from '../src/router/feishu-ingress.ts';
import { RecordingHarness } from '../examples/support/adapters.ts';
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
        if (text === '加回滚步骤') target = workId;
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
