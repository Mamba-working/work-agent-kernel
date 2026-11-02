import { z } from 'zod';

const text = z.string().min(1);
export const EventKey = text.brand<'EventKey'>();
export const ThreadKey = text.brand<'ThreadKey'>();
export const WorkId = text.brand<'WorkId'>();
export const RunId = text.brand<'RunId'>();
export const AttentionId = text.brand<'AttentionId'>();
export type WorkId = z.infer<typeof WorkId>;
export type RunId = z.infer<typeof RunId>;
export type EventKey = z.infer<typeof EventKey>;
export type AttentionId = z.infer<typeof AttentionId>;

export const EventSchema = z.strictObject({
  source: text, externalId: text, revision: text, thread: text,
  actor: text, text, uri: text, occurredAt: z.iso.datetime().nullable().default(null),
});
export type Event = z.infer<typeof EventSchema>;
export const eventKey = (event: Event): EventKey => EventKey.parse(JSON.stringify([event.source, event.externalId, event.revision]));
export const threadKey = (source: string, thread: string) => ThreadKey.parse(JSON.stringify([source, thread]));
export const SourceBatchSchema = z.strictObject({ events: z.array(EventSchema), cursor: z.string().nullable() });

export const WorkflowSchema = z.strictObject({
  name: text, version: text, instructions: text,
  skills: z.array(text).default([]), acceptance: z.array(text).default([]),
});
export type Workflow = z.infer<typeof WorkflowSchema>;
export const ScopeSchema = z.enum(['prepare', 'execute']);
export type Scope = z.infer<typeof ScopeSchema>;
export const RouteSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('create'), reason: text, goal: text, harness: text, workflow: text.default('general'), scope: ScopeSchema.default('prepare') }),
  z.strictObject({ kind: z.literal('attach'), reason: text, workId: WorkId }),
  z.strictObject({ kind: z.literal('ignore'), reason: text }),
]);
export type Route = z.infer<typeof RouteSchema>;

export const ReceiptSchema = z.strictObject({ sessionId: text, runId: text });
export type Receipt = z.infer<typeof ReceiptSchema>;
export const ReportSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ready'), summary: text, evidence: z.array(text).min(1) }),
  z.strictObject({ kind: z.literal('needs_input'), summary: text, question: text,
    options: z.array(text).min(2).refine(options => new Set(options).size === options.length, 'Options must be distinct') }),
  z.strictObject({ kind: z.literal('failed'), summary: text }),
  z.strictObject({ kind: z.literal('reroute'), summary: text }),
]);
export type Report = z.infer<typeof ReportSchema>;

const eventRecord = z.object({
  event: EventSchema, key: EventKey, threadKey: ThreadKey, receivedAt: z.iso.datetime(),
  disposition: z.enum(['pending', 'routed', 'ignored']), deliveries: z.array(WorkId),
  forceRouter: z.boolean(), reasons: z.array(text),
});
export type EventRecord = z.infer<typeof eventRecord>;
const decisionState = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pending') }),
  z.object({ kind: z.literal('resolved'), choice: text, actor: text }),
]);
const attention = z.object({ id: AttentionId, workId: WorkId, runId: RunId, question: text, options: z.array(text), state: decisionState });
export type Attention = z.infer<typeof attention>;
const result = z.object({ runId: RunId, report: ReportSchema });
export const ExecutionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('queued') }), z.object({ kind: z.literal('idle') }),
  z.object({ kind: z.literal('ready') }), z.object({ kind: z.literal('failed') }),
  z.object({ kind: z.literal('running'), runId: RunId }),
  z.object({ kind: z.literal('uncertain'), runId: RunId }),
  z.object({ kind: z.literal('waiting_input'), attentionId: AttentionId }),
]);
const work = z.object({
  id: WorkId, goal: text, harness: text, scope: ScopeSchema, workflow: WorkflowSchema,
  execution: ExecutionSchema, sessionId: text.nullable(),
  inputs: z.array(EventKey), pendingInputs: z.array(EventKey), pendingDecisions: z.array(AttentionId), results: z.array(result),
});
export type WorkItem = z.infer<typeof work>;
const input = z.object({ key: EventKey, source: text, actor: text, text, uri: text, truncated: z.boolean() });
export const RequestSchema = z.object({
  requestId: RunId, workId: WorkId, goal: text, scope: ScopeSchema, workflow: WorkflowSchema,
  sessionId: text.nullable(), inputs: z.array(input), decisions: z.array(attention), priorResults: z.array(result),
});
export type WorkRequest = z.infer<typeof RequestSchema>;
const runState = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dispatching') }),
  z.object({ kind: z.literal('running'), receipt: ReceiptSchema }),
  z.object({ kind: z.literal('uncertain'), error: text }),
  z.object({ kind: z.literal('finished'), receipt: ReceiptSchema, report: ReportSchema }),
]);
const run = z.object({ id: RunId, workId: WorkId, harness: text, request: RequestSchema, state: runState });
export type Run = z.infer<typeof run>;
const noticeState = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pending') }), z.object({ kind: z.literal('superseded') }),
  z.object({ kind: z.literal('delivered'), receipt: text }),
]);
export const NoticeSchema = z.object({ id: text, workId: WorkId, recipient: text, body: ReportSchema });
export type Notice = z.infer<typeof NoticeSchema>;
const outbox = z.object({ notice: NoticeSchema, sink: text, state: noticeState, attempts: z.number().int().nonnegative(), lastError: text.nullable() });
export const StateSchema = z.object({
  version: z.literal(1), events: z.record(z.string(), eventRecord), cursors: z.record(z.string(), z.string().nullable()),
  works: z.record(z.string(), work), subscriptions: z.record(z.string(), z.array(WorkId)),
  runs: z.record(z.string(), run), attentions: z.record(z.string(), attention), outbox: z.record(z.string(), outbox),
});
export type State = z.infer<typeof StateSchema>;
export const emptyState = (): State => ({ version: 1, events: {}, cursors: {}, works: {}, subscriptions: {}, runs: {}, attentions: {}, outbox: {} });

export function entry<T>(record: Record<string, T>, id: string): T {
  const value = record[id];
  if (value === undefined) throw new Error(`Unknown entity: ${id}`);
  return value;
}
