import type { EventKey } from '../domain.ts';
import type { Kernel } from '../kernel.ts';
import type { Source } from '../ports.ts';
import type { PlanningRequest, Candidate } from './contracts.ts';

const activeStates = new Set(['queued', 'running', 'waiting_input', 'uncertain']);

// Candidate IDs are the scope established by the intake; read current state only for those IDs.
export function queryWork(
  kernel: Kernel,
  sources: Source[],
  request: PlanningRequest,
  options: { workId?: string; activeOnly?: boolean; visibleMessage?:(key:EventKey)=>boolean },
) {
  const { works, events } = kernel.workIndex();
  const summaries = [];
  for (const candidate of request.candidates) {
    if (options.workId && candidate.id !== options.workId) continue;
    const work = works[candidate.id];
    if (!work || (options.activeOnly && !activeStates.has(work.execution.kind))) continue;
    const conversations = new Map<string, { source: string; id: string }>();
    const recentInputs: { actor: string; text: string; receivedAt: string }[] = [];
    let sameConversation = false;
    for (const key of work.inputs) {
      const record = events[key];
      if (!record || (options.visibleMessage && !options.visibleMessage(key))) continue;
      const { event } = record;
      // An owner's selected chats are references, not the origin of an external message.
      if (event.source === 'owner') continue;
      const adapter = sources.find((s) => s.name === event.source);
      const origin = adapter?.describeInput
        ? adapter.describeInput(event.text)
        : { conversationId: event.thread, text: event.text };
      if (!origin.conversationId) continue;
      const same =
        request.origin.source === event.source && request.origin.conversationId === origin.conversationId;
      sameConversation ||= same;
      if (same || request.origin.kind === 'owner' || request.defaultProject !== null)
        conversations.set(JSON.stringify([event.source, origin.conversationId]), {
          source: event.source,
          id: origin.conversationId,
        });
      if (same && options.workId)
        recentInputs.push({
          actor: event.actor,
          text: origin.text.slice(0, 400),
          receivedAt: record.receivedAt,
        });
    }
    const summary = {
      ...candidate,
      state: work.execution.kind,
      sourceConversations: [...conversations.values()],
      sameConversation,
      workerSessionId: work.sessionId,
    };
    if (options.workId)
      return {
        ...summary,
        execution: work.execution,
        inputCount: work.inputs.length,
        pendingInputCount: work.pendingInputs.length,
        recentInputs: recentInputs.slice(-4),
        lastResult: work.results.at(-1)?.report.kind ?? null,
      };
    summaries.push(summary);
  }
  if (options.workId) throw Error('事项不在本次候选范围');
  return summaries.sort(
    (a, b) =>
      Number(b.sameConversation) - Number(a.sameConversation) ||
      Number(activeStates.has(b.state)) - Number(activeStates.has(a.state)),
  );
}

export type WorkQuery = (
  request: PlanningRequest,
  options: { workId?: string; activeOnly?: boolean; visibleMessage?:(key:EventKey)=>boolean },
) => ReturnType<typeof queryWork>;
export function activeCandidates(rows: Candidate[]) {
  return rows.filter((w) => activeStates.has(w.state));
}
