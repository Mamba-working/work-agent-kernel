// Opt-in: two real Codex worker turns and an independent Router audit on synthetic inputs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DispatchStore } from '../../src/core/dispatch/store.ts';
import { StateSchema } from '../../src/core/domain.ts';

const directory = mkdtempSync(join(tmpdir(), 'router-facts-eval-'));
const cli = fileURLToPath(new URL('../feishu-codex/cli.ts', import.meta.url));
const cwd = join(directory, 'repo');
mkdirSync(cwd);
const config = join(directory, 'projects.json');
writeFileSync(
  config,
  JSON.stringify({ sample: { name: '算术验收项目', cwd, groups: [{ id: 'sample-chat', name: '算术群' }] } }),
);
const env = {
  ...process.env,
  ROUTER_INBOX_DIR: directory,
  ROUTER_PROJECTS_FILE: config,
  ROUTER_APPROVAL_OWNER: '',
  ROUTER_HOOKS_FILE: '',
};
const store = new DispatchStore(directory);
const marker = randomUUID();
function start() {
  const child = spawn(process.execPath, [cli, 'serve'], { env, stdio: 'ignore' });
  const exit = once(child, 'exit');
  return async () => {
    child.kill('SIGTERM');
    await exit;
  };
}
function send(id: string, content: string, raw: unknown) {
  const result = spawnSync(process.execPath, [cli, 'ingest'], {
    env,
    input: JSON.stringify({
      message_id: id,
      chat_id: 'sample-chat',
      chat_type: 'group',
      sender: '验收用户',
      content,
      raw,
    }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
}
async function wait<T>(read: () => T | undefined) {
  const until = Date.now() + 300000;
  while (Date.now() < until) {
    const v = read();
    if (v !== undefined) return v;
    await delay(500);
  }
  throw Error('Timed out waiting for real Codex');
}
function snapshot() {
  const db = new DatabaseSync(join(directory, 'kernel.sqlite'), { readOnly: true, timeout: 2000 });
  try {
    const row = db.prepare('SELECT body FROM state WHERE id=1').get();
    return StateSchema.parse(JSON.parse(String(row?.body)));
  } finally {
    db.close();
  }
}
function finished(count: number) {
  const s = snapshot();
  if (Object.values(s.works).some((w) => w.execution.kind === 'failed')) throw Error('Worker failed');
  if (Object.keys(s.works).length > 1) throw Error('Expected the same work item');
  return Object.values(s.works).find((w) => w.results.length === count);
}
let halt = start();
try {
  send('m1', '新建算术验收事项，计算 18 × 7 并只交付数值。', { auditMarker: marker });
  await wait(() => (existsSync(join(directory, 'health.json')) ? true : undefined));
  const first = await wait(() => finished(1));
  assert.match(first.results[0]!.report.summary, /126/);
  assert(first.sessionId);
  await halt();
  halt = start();
  send('m2', '请续接刚才的算术验收事项，在原结果上加 1，只交付新数值。', { test: 'follow-up' });
  const second = await wait(() => finished(2));
  assert.equal(second.id, first.id);
  assert.equal(second.sessionId, first.sessionId);
  assert.match(second.results[1]!.report.summary, /127/);
  const state = snapshot();
  for (const [i, action] of ['create', 'attach'].entries()) {
    const key = JSON.stringify(['feishu', 'm' + (i + 1), '1']);
    const record = state.events[key]!;
    assert.deepEqual(
      record.decisions?.map((d) => [d.action, d.workIds]),
      [[action, [first.id]]],
    );
    const completed = state.runs[second.results[i]!.runId]!;
    assert.equal(completed.state.kind, 'finished');
    assert.deepEqual(
      completed.request.inputs.map((input) => input.key),
      [key],
    );
    assert.equal(completed.state.receipt.sessionId, first.sessionId);
  }
  const job = store.submit({
    id: randomUUID(),
    sources: [],
    description:
      '仅分析本地归档。先查找算术验收项目，再按项目查归档消息，追溯 m1 和 m2 各自的实际路由动作（写出 create/attach）、工作会话是否相同；读取 m1 保存的原始载荷，把 auditMarker 的值逐字列入回答。',
  });
  const audit = await wait(() => {
    const j = store.get(job.id);
    if (j.status === 'failed') throw Error([j.error ?? 'Audit failed', ...j.steps].join(' · '));
    return j.status === 'done' ? j : undefined;
  });
  for (const tool of ['find_projects', 'find_messages', 'trace_routing', 'read_records'])
    assert(
      audit.steps.some((s) => s.endsWith(tool)),
      tool + ' was not called',
    );
  assert(audit.result);
  assert(audit.result.answer.includes(marker));
  assert.match(audit.result.answer, /create/i);
  assert.match(audit.result.answer, /attach/i);
  assert.deepEqual(audit.workIds, []);
  console.log(
    JSON.stringify(
      {
        first: 126,
        followup: 127,
        sameWork: true,
        sameWorkerSession: true,
        serviceRestarted: true,
        rawMarkerVerified: true,
        auditCreatedWork: audit.workIds.length,
        observedTools: [...new Set(audit.steps.filter((s) => s.includes('查询本地记录')))],
      },
      null,
      2,
    ),
  );
} finally {
  await halt();
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
