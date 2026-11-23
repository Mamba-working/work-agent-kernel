import assert from 'node:assert/strict';
import test from 'node:test';
import { projectSessions } from '../src/session-index.mjs';
test('merges registered and routed sessions within their project and retains trace revisions', () => {
  const project = {
    sessions: [
      { id: 'a', title: '原会话' },
      { id: 'seed', title: '只有登记' },
    ],
  };
  const r = (id, time, project, session) => ({ id, time, tasks: [{ project, session, goal: '派单目标' }] });
  const records = [
    r('1', '2026-11-20', 'p', 'a'),
    r('2', '2026-11-23', 'p', 'b'),
    r('3', '2026-11-24', 'q', 'c'),
    r('4', '2026-11-22', 'p', 'a'),
  ];
  const result = projectSessions('p', project, records, 'a');
  assert.deepEqual(
    result.map((s) => s.id),
    ['a', 'b', 'seed'],
  );
  assert.equal(result[0].title, '原会话');
  assert.equal(result[0].time, '2026-11-22');
  assert.equal(result[0].records.length, 2);
  assert.equal(result[2].time, null);
});
