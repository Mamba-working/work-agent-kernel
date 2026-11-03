import assert from 'node:assert/strict';
import { EventKey, WorkId, WorkflowSchema } from '../../src/domain.ts';
import type { Route, WorkItem } from '../../src/domain.ts';
import { ResponsesRouter } from '../../src/live/responses-router.ts';
import type { RouteContext } from '../../src/ports.ts';

const { WORK_AGENT_API_BASE: baseUrl, WORK_AGENT_API_KEY: apiKey, WORK_AGENT_MODEL: model } = process.env;
if (!baseUrl || !apiKey || !model) throw new Error('Set WORK_AGENT_API_BASE, WORK_AGENT_API_KEY and WORK_AGENT_MODEL');
const router = new ResponsesRouter({ baseUrl, apiKey, model });
const workflow = WorkflowSchema.parse({ name: 'general', version: '1', instructions: 'Prepare a reviewable result.' });
const results: Route[] = [];
const works: WorkItem[] = [];
const samples = [
  '请为 Acorn 个人工作 Agent 写一个最小试运行方案，覆盖消息输入、模型分流和 Codex 执行，供我审阅。',
  '补充刚才 Acorn 工作 Agent 的试运行方案：通知只发给我自己，先不用接飞书真实消息。请加入同一份方案。',
  '早上好！这只是一句问候，不需要安排任何任务，也没有项目补充资料。',
];
for (const [index, text] of samples.entries()) {
  const event = { key: EventKey.parse(`sample-${index}`), source: 'owner', thread: `discussion-${index}`,
    actor: 'owner', text, uri: `demo://router/${index}`, truncated: false };
  const context: RouteContext = { event, candidates: works, hasMoreCandidates: false, workflows: [workflow], harnesses: ['codex'], allowedScopes: ['prepare'] };
  const decision = await router.decide(context, {
    event: () => ({ text, uri: event.uri }), listWorks: () => works,
    work: id => { const work = works.find(value => value.id === id); if (!work) throw new Error('Unknown work'); return work; },
  });
  results.push(decision);
  if (decision.kind === 'create') works.push({
    id: WorkId.parse(`work-${index}`), goal: decision.goal, harness: decision.harness, scope: decision.scope,
    workflow, execution: { kind: 'ready' }, sessionId: null, inputs: [], pendingInputs: [], pendingDecisions: [], results: [],
  });
}
process.stdout.write(JSON.stringify(results, null, 2) + '\n');
assert.deepEqual(results.map(decision => decision.kind), ['create', 'attach', 'ignore']);
const attachment = results[1];
assert(attachment?.kind === 'attach');
assert.equal(attachment.workId, works[0]?.id);
