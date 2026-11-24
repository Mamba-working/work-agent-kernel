import {codexSessionId} from '../src/adapters/codex/session-id.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { ProjectRegistry, loadProjects } from '../src/adapters/feishu/project-registry.ts';
import { serve } from '../examples/feishu-codex/service.ts';
import { RouterInbox } from '../examples/feishu-codex/inbox.ts';

test('register while running, resume a seeded session from an independent receiver, then restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'create-project-')),
    cwd = join(dir, 'work');
  mkdirSync(cwd);
  const registry = new ProjectRegistry(dir,codexSessionId);
  const executable = fileURLToPath(new URL('./fixtures/desktop-runner.mjs', import.meta.url));
  const configured = { legacy: { name: '原有项目', cwd: dir, feishuChatId: 'legacy-chat' } };
  function start() {
    const stop = new AbortController();
    const service = serve(dir, configured, executable, stop.signal);
    return async () => {
      stop.abort();
      await service;
    };
  }
  let halt = start();
  const session = randomUUID();
  const input = {
    requestId: randomUUID(),
    name: '新项目',
    cwd,
    context: '测试背景',
    sessions: [{ id: 'codex://threads/' + session, title: '已登记会话' }],
    groups: [{ id: 'group-new', name: '新群', aliases: ['sample-alias'] }],
  };
  try {
    const [{ id, project }, again] = await Promise.all([registry.create(input), registry.create(input)]);
    assert.deepEqual(again, { id, project });
    assert.equal(project.sessions?.[0]?.id, session);
    await assert.rejects(registry.create({ ...input, requestId: randomUUID(), name: '冲突' }), /已绑定/);
    await assert.rejects(
      registry.create({ ...input, requestId: randomUUID(), name: '冲突', groups: [] }),
      /Session already belongs/,
    );
    await assert.rejects(
      registry.create({
        ...input,
        requestId: randomUUID(),
        name: '冲突',
        sessions: [],
        groups: [{ id: 'legacy-chat', name: '原群' }],
      }),
      /已绑定/,
    );
    writeFileSync(
      join(cwd, 'fixture-history.json'),
      JSON.stringify({ [session]: { id: session, turns: [] } }),
    );
    const receiver = new RouterInbox(join(dir, 'feishu.sqlite'), configured);
    try {
      assert.equal(receiver.admission.boundProject('sample-alias'), id);
      receiver.receive({ message_id: 'new-task', chat_id: 'sample-alias', content: '请继续原事项' });
    } finally {
      receiver.close();
    }
    const db = new DatabaseSync(join(dir, 'kernel.sqlite'), { readOnly: true });
    try {
      const deadline = Date.now() + 20000;
      while (true) {
        const state = JSON.parse(String(db.prepare('SELECT body FROM state').get()?.body));
        const finished = Object.values(state.works).some((w) => {
          const work = w as { projectId: string; sessionId: string; execution: { kind: string } };
          return work.projectId === id && work.sessionId === session && work.execution.kind === 'ready';
        });
        if (finished) break;
        assert(Date.now() < deadline, 'new project worker did not complete');
        await delay(100);
      }
    } finally {
      db.close();
    }
    await halt();
    halt = start();
    assert.deepEqual(loadProjects(dir, configured), { ...configured, [id]: project });
    assert.deepEqual(await registry.create(input), { id, project });
    assert(existsSync(join(cwd, 'fixture-history.json')));
  } finally {
    await halt();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid directory, session link and repeated bindings cannot create a project', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'invalid-project-'));
  const registry = new ProjectRegistry(dir,codexSessionId);
  const draft = { requestId: randomUUID(), name: '项目', cwd: dir };
  try {
    await assert.rejects(registry.create({ ...draft, cwd: join(dir, 'missing') }), /工作目录/);
    await assert.rejects(
      registry.create({ ...draft, sessions: [{ title: '会话', id: 'wrong' }] }),
      /会话 UUID/,
    );
    await assert.rejects(
      registry.create({ ...draft, groups: [{ name: '群', id: 'g', aliases: ['g'] }] }),
      /群 ID 或别名重复/,
    );
    assert.deepEqual(loadProjects(dir, {}), {});
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generic project registry preserves non-Codex session IDs; Codex normalization is opt-in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'generic-registry-'));
  const registry = new ProjectRegistry(dir);
  const stop = registry.listen(async () => {}, error => {throw error});
  try {
    const external = 'issue://ACME/17';
    const result = await registry.create({requestId:randomUUID(),name:'Example',cwd:dir,sessions:[{id:external,title:'Follow up'}]});
    assert.equal(result.project.sessions?.[0]?.id,external);
    assert.throws(()=>codexSessionId(external), /UUID/);
  } finally {await stop();registry.close();rmSync(dir,{recursive:true,force:true});}
});
