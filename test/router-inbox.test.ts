import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { RouterInbox } from '../src/adapters/feishu/inbox.ts';
import type { Projects } from '../src/adapters/feishu/inbox.ts';

const projects: Projects = {
  a: { name: 'Alpha', cwd: '.', feishuChatId: 'g1' },
  b: { name: 'Beta', cwd: '.', feishuChatId: 'g2' },
};
const msg = (id: string, chat = 'g1', content = '项目备忘', revision = '1') => ({
  message_id: id,
  chat_id: chat,
  content,
  revision,
  sender: '模拟发件人',
});
function context(box: RouterInbox, m: ReturnType<typeof msg>, project?: string) {
  return box.context(JSON.stringify(['feishu', m.message_id, m.revision]), JSON.stringify(m), project);
}
function open(t: import('node:test').TestContext, catalog = projects) {
  const dir = mkdtempSync(join(tmpdir(), 'router-archive-'));
  const path = join(dir, 'inbox.sqlite');
  const boxes: RouterInbox[] = [];
  const reopen = (cfg = catalog) => {
    const box = new RouterInbox(path, cfg);
    boxes.push(box);
    return box;
  };
  t.after(() => {
    for (const box of boxes) box.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { box: reopen(), reopen, path };
}
for (const [label, chat, project] of [
  ['群 A', 'g1', 'a'],
  ['群 B', 'g2', 'b'],
  ['未绑定群', 'g3', ''],
  ['私聊', 'dm', ''],
  ['缺少群 ID', '', ''],
] as const) {
  test(label + '：按已登记的群归档', (t) => {
    const { box } = open(t);
    const m = msg('m', chat);
    box.receive(m);
    assert.equal(context(box, m)?.project.id ?? '', project);
  });
}
for (const [label, raw] of [
  ['缺少消息 ID', { content: '你好' }],
  ['空白正文', msg('1', 'g1', '  ')],
  ['空修订号', msg('m', 'g1', 'hello', '')],
  ['数字 ID 未作为字符串', { ...msg('1'), message_id: 9001 }],
  ['空白 ID', msg('  ')],
]) {
  test(label + '：拒收并保持空库', async (t) => {
    const { box } = open(t);
    assert.throws(() => box.receive(raw));
    assert.equal((await box.fetch()).events.length, 0);
  });
}
test('两项目不能重复绑定同一个群', () => {
  assert.throws(
    () => new RouterInbox(':memory:', { ...projects, z: { ...projects.a!, feishuChatId: ' g1 ' } }),
    /duplicate/,
  );
});
test('旧项目配置可以省略群字段', (t) => {
  const { box } = open(t, { a: { name: 'Alpha', cwd: '.' } });
  const m = msg('a');
  box.receive(m);
  assert.equal(context(box, m), null);
});
test('重复投递只有一条事件且回执相同', async (t) => {
  const { box } = open(t);
  const m = msg('m');
  assert.equal(box.receive(m), box.receive(m));
  assert.equal((await box.fetch()).events.length, 1);
});
test('同版不同内容报错且不覆盖原文', async (t) => {
  const { box } = open(t);
  box.receive(msg('m'));
  assert.throws(() => box.receive(msg('m', 'g1', '改写')), /Conflicting/);
  assert.equal(JSON.parse((await box.fetch()).events[0].text).content, '项目备忘');
});
test('归档写失败也回滚收件箱记录', async (t) => {
  const { box, path } = open(t);
  const db = new DatabaseSync(path);
  db.exec("CREATE TRIGGER inject_error BEFORE INSERT ON project_events BEGIN SELECT RAISE(ABORT,'injected'); END;");
  assert.throws(() => box.receive(msg('m')), /injected/);
  assert.equal((await box.fetch()).events.length, 0);
  db.exec('DROP TRIGGER inject_error');
  db.close();
  box.receive(msg('m'));
  assert.equal((await box.fetch()).events.length, 1);
});
test('重新打开后仍能找到来源与背景', (t) => {
  const { box, reopen } = open(t);
  const m = msg('2');
  box.receive(msg('1'));
  box.receive(m);
  assert.equal(context(reopen(), m)?.messages[0]?.messageId, '1');
});
test('改绑、重投、编辑不搬动原项目归属', (t) => {
  const { box, reopen } = open(t);
  const m = msg('m');
  box.receive(m);
  const next = reopen({ a: { name: 'A', cwd: '.' }, b: { name: 'B', cwd: '.', feishuChatId: 'g1' } });
  next.receive(m);
  const edited = msg('m', 'g1', '二版', '2');
  next.receive(edited);
  assert.equal(context(next, m)?.project.id, 'a');
  assert.equal(context(next, edited)?.project.id, 'a');
  const later = msg('next');
  next.receive(later);
  assert.equal(context(next, later)?.project.id, 'b');
  assert.deepEqual(context(next, later)?.messages, []);
});
test('登记群前已入库的消息不会被追溯归档', (t) => {
  const { box, reopen } = open(t, {});
  const m = msg('m');
  box.receive(m);
  const next = reopen(projects);
  next.receive(m);
  assert.equal(context(next, m), null);
});
test('同一消息的编辑不能变更来源群', async (t) => {
  const { box } = open(t);
  box.receive(msg('m'));
  assert.throws(() => box.receive(msg('m', 'g2', '变更', '2')), /conversation/);
  assert.equal((await box.fetch()).events.length, 1);
});
test('上下文排除未来消息、当前消息和外群消息', (t) => {
  const { box } = open(t);
  const m = msg('current');
  for (const item of [msg('before'), msg('foreign', 'g2'), m, msg('later')]) box.receive(item);
  assert.deepEqual(
    context(box, m)?.messages.map((x) => x.messageId),
    ['before'],
  );
});
test('按当时已收到的最新修订取值', (t) => {
  const { box } = open(t);
  const m = msg('q');
  for (const item of [msg('m'), msg('m', 'g1', '新版', '2'), m, msg('m', 'g1', '未来', '3')]) box.receive(item);
  assert.deepEqual(
    context(box, m)?.messages.map((x) => [x.text, x.revision]),
    [['新版', '2']],
  );
});
test('最近 8 条和最多 4 条较早的关键词资料均带来源', (t) => {
  const { box } = open(t);
  for (let i = 0; i < 6; i++) box.receive(msg('ref' + i, 'g1', '合同验收资料'));
  for (let i = 0; i < 9; i++) box.receive(msg('later' + i));
  const m = msg('q', 'g1', '合同验收');
  box.receive(m);
  const rows = context(box, m)!.messages;
  assert.equal(rows.length, 12);
  assert.equal(rows.filter((r) => r.messageId.startsWith('ref')).length, 4);
  assert(rows.every((r) => r.chatId === 'g1' && r.sender === '模拟发件人'));
  assert.equal(rows.at(-1)?.messageId, 'later8');
});
test('摘录截短但保存完整原文', async (t) => {
  const { box } = open(t);
  const body = '长'.repeat(900);
  box.receive(msg('1', 'g1', body));
  const m = msg('2');
  box.receive(m);
  assert.equal(context(box, m)?.messages[0]?.text.length, 600);
  assert.equal(JSON.parse((await box.fetch()).events[0].text).content, body);
});
test('富文本 text 段转换为可读群消息', (t) => {
  const { box } = open(t);
  box.receive(msg('a', 'g1', '{"text":"确认了"}'));
  const m = msg('q');
  box.receive(m);
  assert.equal(context(box, m)?.messages[0]?.text, '确认了');
});
test('worker 无法读取其他项目归属的事件上下文', (t) => {
  const { box } = open(t);
  const m = msg('a');
  box.receive(m);
  assert.equal(context(box, m, 'b'), null);
});
