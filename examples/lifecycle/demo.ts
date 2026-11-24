// Run with Node 24. Uses an isolated database, a synthetic planner and a local card recorder.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRouterApplication } from '../../src/core/index.ts';
import { RecordingHarness } from '../support/adapters.ts';
import type { LifecycleHook } from '../../src/core/index.ts';

const directory = mkdtempSync(join(tmpdir(), 'hook-demo-'));
let cardDelivered!: (ticket: string) => void;
const card = new Promise<string>(resolve => { cardDelivered = resolve; });
const review: LifecycleHook = {
  id: 'project.review',
  phase: 'beforeRoute',
  run(input) {
    if (input.kind === 'owner' && input.description === '编写验收说明')
      return {
        kind: 'wait',
        reason: '等待选择验收版本',
        effect: { title: '请选择验收版本' },
      };
    return { kind: 'continue' };
  },
  async deliver(effect) {
    // A real interactive channel would associate this ticket with its verified callback.
    cardDelivered(effect.ticket!);
    console.log('模拟卡片已送达，流程仍在等待');
  },
};
const app = createRouterApplication({
  directory,
  signal: new AbortController().signal,
  catalog: { defaultHarness: 'local', projects: [] },
  hooks: [review],
  harnesses: { local: new RecordingHarness('demo') },
  sinks: {},
  runtime: async (request) => ({
    answer: request.context.map((item) => item.text).join('\n') || '已分析',
    actions: [],
    evidence: [],
  }),
});
try {
  app.start();
  const first = app.submit({ id: randomUUID(), description: '编写验收说明', sources: [] });
  const second = app.submit({ id: randomUUID(), description: '分析另一个问题', sources: [] });

  const ticket = await card;
  const other = await second.done;
  console.log('第一单', app.getDispatch(first.id).status, '第二单', other.dispatch.status);

  await app.resume(ticket, { kind: 'continue', context: { version: 'v2' } });
  const plan = await first.routed;
  const completed = await first.done;
  console.log('第一单', completed.dispatch.status, plan.result?.answer);
} finally {
  await app.stop();
  await app.close();
  rmSync(directory, { recursive: true, force: true });
}
