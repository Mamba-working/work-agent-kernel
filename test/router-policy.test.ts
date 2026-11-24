import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRouterApplication } from 'work-router';
import { RecordingHarness } from '../examples/support/adapters.ts';
import { DispatchStore } from '../src/core/dispatch/store.ts';

test('public application uses configured owner, language and budgets above the defaults', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wak-policy-'));
  const app = createRouterApplication({
    directory: dir,
    owner: 'incident-ops',
    maxSources: 13,
    router: { language: 'en', maxActions: 13, maxToolCalls: 15 },
    signal: new AbortController().signal,
    catalog: { defaultHarness: 'fixture', projects: [] },
    harnesses: { fixture: new RecordingHarness('sample') },
    sinks: {},
    runtime: async (req, tools, _signal, instructions) => {
      assert.equal(req.origin.actor, 'incident-ops');
      assert.equal(req.maxActions, 13);
      assert.match(instructions, /Explain the decision in English/);
      assert(!tools.specs.some((s) => (s as { name: string }).name === 'find_messages'));
      for (let i = 0; i < 15; i++) await tools.call({ tool: 'list_work_items', arguments: {} });
      await assert.rejects(tools.call({ tool: 'list_work_items', arguments: {} }), /Tool call limit exceeded/);
      return {
        answer: 'assign',
        actions: Array.from({ length: 13 }, (_, i) => ({
          goal: 'task ' + i,
          workId: null,
          project: null,
          evidence: [],
        })),
        evidence: [],
      };
    },
  });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const sources = Array.from({ length: 13 }, (_, i) => ({ id: String(i), name: 'alert ' + i }));
  const task = app.submit({ id: randomUUID(), description: 'assign', sources });
  await app.step();
  assert.equal((await task.routed).workIds.length, 13);
  assert.throws(() =>
    app.submit({
      id: randomUUID(),
      description: 'too many',
      sources: [...sources, { id: 'other', name: 'more' }],
    }),
  );
});
test('legacy evidence names are normalized on point reads, listing and restart recovery', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wak-evidence-')),
    db = new DispatchStore(dir);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const job = db.submit({ id: randomUUID(), description: 'sample', sources: [] });
  db.db
    .prepare('UPDATE dispatch_runs SET body=? WHERE id=?')
    .run(
      JSON.stringify({ ...job, status: 'planned', refs: [{ id: 'a', chat: 'alerts', time: '', url: '' }] }),
      job.id,
    );
  for (const row of [db.get(job.id), db.list()[0], db.next()])
    assert.deepEqual(row?.refs, [{ id: 'a', sourceLabel: 'alerts', url: '', time: '' }]);
});
