import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouterInbox } from '../src/adapters/feishu/inbox.ts';
import { Host } from '../src/core/host.ts';
import { Kernel } from '../src/core/kernel.ts';
import { ScriptedRouter } from '../examples/support/adapters.ts';
import { parseSubmission, renderAdmission } from '../src/adapters/feishu/card.ts';

const owner = 'ou_self',
  projects = { p: { name: 'Example', cwd: '.', feishuChatId: 'known' } };
const message = (id: string, chat: string) => ({
  message_id: id,
  chat_id: chat,
  chat_type: 'group',
  content: '消息原文',
  sender: '测试用户',
});
const channel = {
  async send() {
    return 'om_fixture';
  },
  async update() {},
};
for (const project of [null, 'p'])
  for (const execute of [true, false])
    test('binding=' + project + ', execute=' + execute, async (t) => {
      const inbox = new RouterInbox(':memory:', projects);
      t.after(() => inbox.close());
      inbox.admission.enable(owner);
      const id = inbox.receive(message('1', 'new'), undefined, '测试会话');
      assert.equal((await inbox.fetch()).events.length, 0);
      await inbox.admission.deliverOne(channel);
      const kernel = new Kernel({
        path: ':memory:',
        router: new ScriptedRouter([{ kind: 'ignore', reason: '测试判断' }]),
      });
      t.after(() => kernel.close());
      const host = new Host({ kernel, sources: [inbox] });
      await host.tick();
      assert.equal(kernel.events().length, 0);
      const submit = parseSubmission({
        type: 'card.action.trigger',
        action_tag: 'button',
        action_name: 'router_admit_' + id,
        message_id: 'om_fixture',
        operator_id: owner,
        form_value: JSON.stringify({
          binding: project ? 'project:p' : 'none',
          execution: execute ? 'run' : 'stop',
        }),
      })!;
      inbox.admission.submit(submit.id, submit.actor, submit.receipt, submit.choice);
      inbox.admission.submit(id, owner, 'om_fixture', { project: null, execute: !execute });
      await host.tick();
      assert.equal(kernel.events().length, execute ? 1 : 0);
      assert.equal(inbox.admission.boundProject('new'), project);
      const second = inbox.receive(message('2', 'new'));
      assert.equal(inbox.admission.get(second)?.status, project ? undefined : 'waiting');
      let updated = false;
      await inbox.admission.deliverOne({
        ...channel,
        async update() {
          updated = true;
        },
      });
      assert(updated);
    });
test('historical records and known group pass; unknown is durable and duplicate receipt is stable', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'admission-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'inbox.db');
  let box = new RouterInbox(path, projects);
  box.receive(message('before', 'unbound'));
  box.admission.enable(owner);
  box.receive(message('known', 'known'));
  const id = box.receive(message('held', 'new'));
  box.close();
  box = new RouterInbox(path, projects);
  t.after(() => box.close());
  assert.equal(box.receive(message('held', 'new')), id);
  assert.equal((await box.fetch()).events.length, 2);
  assert.equal(box.admission.get(id)?.status, 'waiting');
  await box.admission.deliverOne(channel);
  box.admission.submit(id, owner, 'om_fixture', { project: 'p', execute: false });
  const another = new RouterInbox(path, projects);
  try {
    const next = another.receive(message('after', 'new'));
    assert.equal(another.admission.get(next), undefined);
  } finally {
    another.close();
  }
});
test('unknown or mismatched owner, receipt and project never release a message', async (t) => {
  const inbox = new RouterInbox(':memory:', projects);
  t.after(() => inbox.close());
  inbox.admission.enable(owner);
  const id = inbox.receive(message('1', 'x'));
  await inbox.admission.deliverOne(channel);
  for (const [actor, receipt, project] of [
    ['ou_other', 'om_fixture', 'p'],
    [owner, 'om_other', 'p'],
    [owner, 'om_fixture', 'deleted'],
  ] as const)
    assert.throws(() => inbox.admission.submit(id, actor, receipt, { project, execute: true }));
  assert.equal((await inbox.fetch()).events.length, 0);
  assert.equal(inbox.admission.boundProject('x'), null);
});
test('no projects, no chat ID, excerpt bounds, explicit choice and only button submission', async (t) => {
  const inbox = new RouterInbox(':memory:');
  t.after(() => inbox.close());
  inbox.admission.enable(owner);
  const id = inbox.receive({ ...message('0', ''), content: '长'.repeat(512) });
  const r = inbox.admission.get(id)!;
  assert(r.excerpt.length <= 420);
  const json = JSON.stringify(renderAdmission(r, {}));
  assert(!json.includes('不新增绑定'));
  assert(json.includes('执行 Router'));
  assert(!json.includes('"initial_option":"run"'));
  assert.equal(parseSubmission({ type: 'card.action.trigger', action_tag: 'select_static' }), null);
  await inbox.admission.deliverOne(channel);
  inbox.admission.submit(id, owner, 'om_fixture', { project: null, execute: true });
  assert.equal((await inbox.fetch()).events.length, 1);
});
test('card send failure is retried without giving the model the pending event', async (t) => {
  const inbox = new RouterInbox(':memory:', projects);
  t.after(() => inbox.close());
  inbox.admission.enable(owner);
  const id = inbox.receive(message('1', 'new'));
  await assert.rejects(
    inbox.admission.deliverOne(
      {
        ...channel,
        async send() {
          throw Error('offline');
        },
      },
      1,
    ),
  );
  assert.equal((await inbox.fetch()).events.length, 0);
  await inbox.admission.deliverOne(channel, 30002);
  assert.equal(inbox.admission.get(id)?.receipt, 'om_fixture');
});

test('pending siblings remain independent; an old card cannot overwrite a later binding', async (t) => {
  const other = { ...projects, q: { name: 'Other', cwd: '.' } };
  const inbox = new RouterInbox(':memory:', other);
  t.after(() => inbox.close());
  inbox.admission.enable(owner);
  const first = inbox.receive(message('1', 'chat')),
    second = inbox.receive(message('2', 'chat'));
  const ch = {
    async send(r: { eventId: string }) {
      return 'om_' + r.eventId;
    },
    async update() {},
  };
  await inbox.admission.deliverOne(ch);
  await inbox.admission.deliverOne(ch);
  inbox.admission.submit(first, owner, 'om_' + first, { project: 'p', execute: false });
  assert.equal(inbox.admission.get(second)?.status, 'waiting');
  assert.throws(() => inbox.admission.submit(second, owner, 'om_' + second, { project: 'q', execute: true }));
  inbox.admission.submit(second, owner, 'om_' + second, { project: null, execute: true });
  assert.equal(inbox.admission.boundProject('chat'), 'p');
  assert.equal((await inbox.fetch()).events.length, 1);
});

test('known alternative group ID bypasses approval without trusting a display name', async (t) => {
  const inbox = new RouterInbox(':memory:', {
    p: { name: 'Example', cwd: '.', groups: [{ name: 'Group', id: 'oc_demo', aliases: ['7001'] }] },
  });
  t.after(() => inbox.close());
  inbox.admission.enable(owner);
  for (const chat of ['oc_demo', '7001'])
    assert.equal(inbox.admission.get(inbox.receive(message(chat, chat))), undefined);
  const unknown = inbox.receive(message('other', '7002'), undefined, 'Group');
  assert.equal(inbox.admission.get(unknown)?.status, 'waiting');
  assert.equal((await inbox.fetch()).events.length, 2);
});

for (const kind of ['p2p', 'unknown'] as const)
  for (const execute of [true, false])
    test(kind + ' has one execution question; the decision only admits this message: ' + execute, (t) => {
      const inbox = new RouterInbox(':memory:', projects);
      t.after(() => inbox.close());
      inbox.admission.enable(owner);
      const id = inbox.receive({ ...message('one', '123'), chat_type: kind });
      const request = inbox.admission.get(id)!;
      const card = JSON.stringify(renderAdmission(request, projects));
      assert.equal((card.match(/select_static/g) ?? []).length, 1);
      assert(!card.includes('绑定'));
      assert(card.includes('消息原文'));
      if (kind === 'p2p') assert(card.includes('私聊消息'));
      return inbox.admission.deliverOne(channel).then(() => {
        const submit = parseSubmission({
          type: 'card.action.trigger',
          action_tag: 'button',
          action_name: 'router_admit_' + id,
          message_id: 'om_fixture',
          operator_id: owner,
          form_value: { execution: execute ? 'run' : 'stop' },
        })!;
        assert.throws(
          () => inbox.admission.submit(id, owner, 'om_fixture', { ...submit.choice, project: 'p' }),
          /one message only/,
        );
        inbox.admission.submit(id, submit.actor, submit.receipt, submit.choice);
        assert.equal(inbox.admission.get(id)?.status, execute ? 'allowed' : 'stopped');
        assert.equal(inbox.admission.boundProject('123'), null);
        const next = inbox.receive({ message_id: 'two', chat_id: '123', content: 'another message' });
        assert.equal(inbox.admission.get(next)?.status, 'waiting');
        assert(!JSON.stringify(renderAdmission(inbox.admission.get(id)!, projects)).includes('绑定'));
      });
    });
test('confirmed direct messages bypass old chat bindings, even on subsequent untyped receipt', async (t) => {
  const inbox = new RouterInbox(':memory:', projects);
  t.after(() => inbox.close());
  inbox.admission.enable(owner);
  const id = inbox.receive({ ...message('dm', 'known'), chat_type: 'p2p' });
  assert.equal(inbox.admission.get(id)?.status, 'waiting');
  assert.equal(inbox.admission.boundProject('known'), null);
  const next = inbox.receive({ message_id: 'later', chat_id: 'known', content: 'another DM' });
  assert.equal(inbox.admission.get(next)?.chatType, 'p2p');
});
test('a group callback still requires its binding field', async (t) => {
  const inbox = new RouterInbox(':memory:', projects);
  t.after(() => inbox.close());
  inbox.admission.enable(owner);
  const id = inbox.receive(message('msg', 'new'));
  await inbox.admission.deliverOne(channel);
  assert.throws(() => inbox.admission.submit(id, owner, 'om_fixture', { execute: true }), /binding choice/);
  assert.equal(inbox.admission.get(id)?.status, 'waiting');
});
test('legacy pending receipt is patched in place and patched again after its final decision', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'card-kind-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'inbox.sqlite'),
    db = new DatabaseSync(path);
  db.exec(`CREATE TABLE admissions(eventId TEXT PRIMARY KEY,ownerId TEXT,chatId TEXT,chatName TEXT,sender TEXT,
    excerpt TEXT,status TEXT,receipt TEXT UNIQUE,chosenProject TEXT,updated INTEGER,nextAttempt INTEGER);
    INSERT INTO admissions VALUES('old','ou_self','dm','','sender','hello','waiting','om_old',NULL,0,0)`);
  db.close();
  const inbox = new RouterInbox(path, projects);
  t.after(() => inbox.close());
  inbox.admission.rememberChatType('dm', 'p2p');
  const seen: string[] = [];
  const transport = {
    async send() {
      throw Error('should patch, never send');
    },
    async update(r: { receipt: string | null; status: string }) {
      assert.equal(r.receipt, 'om_old');
      seen.push(r.status);
    },
  };
  await inbox.admission.deliverOne(transport, 1, true);
  await inbox.admission.deliverOne(transport, 1, true);
  inbox.admission.submit('old', owner, 'om_old', { execute: false });
  await inbox.admission.deliverOne(transport, 1, true);
  assert.deepEqual(seen, ['waiting', 'stopped']);
});
