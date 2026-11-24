import type { Catalog, Candidate, PlanningRequest } from './contracts.ts';
import { RouterBot, routesFor } from './router.ts';
import type { DecisionInput } from './incoming.ts';
import type { WorkItem } from '../domain.ts';

export function candidates(
  works: Pick<WorkItem, 'id' | 'goal' | 'execution' | 'harness' | 'projectId'>[],
  catalog: Catalog,
): Candidate[] {
  return works.map((w) => ({
    id: w.id,
    goal: w.goal,
    state: w.execution.kind,
    project:
      w.projectId === undefined
        ? (catalog.projects.find((p) => p.harness === w.harness)?.id ?? null)
        : w.projectId,
  }));
}

// The sender's message is evidence. Admission authorizes evaluating it under this fixed instruction.
export function incomingPlanner(bot: RouterBot, catalog: Catalog, signal: AbortSignal) {
  return async (input: DecisionInput) => {
    const { event, project, projectMessages = [] } = input;
    const available = catalog.projects.filter((p) =>
      project ? p.id === project.id : input.harnesses.includes(p.harness),
    );
    const request: PlanningRequest = {
      id: event.key,
      origin: { kind: 'event', actor: event.actor, uri: event.uri,source:event.source,...(input.receivedAt ? {receivedAt:input.receivedAt} : {}),conversationId:input.conversationId??null },
      description:
        '判断本条来信是否需要新建或续接工作事项。闲聊或纯背景请只记录。对具体问题或明确任务准备可审阅的成果。',
      created: new Date().toISOString(),
      sources: [],
      defaultProject: project?.id ?? null,
      maxActions: 1,
      projects: available.map((p) => ({ id: p.id, name: p.name, selectedSourceIds: [] })),
      candidates: candidates(input.candidates, catalog),
      context: [
        ...(input.hookContext??[]),
        ...(input.subscribedWorks?.length
          ? [
              {
                text:
                  '本讨论串已经关联的事项：' +
                  input.candidates
                    .filter((w) => input.subscribedWorks?.includes(w.id))
                    .map((w) => w.id)
                    .join('、'),
              },
            ]
          : []),
        ...(project?.context ? [{ text: project.context }] : []),
        ...projectMessages.map((m) => ({
          text: m.sender + '：' + m.text,
          evidence: { id: JSON.stringify([event.source,m.messageId,m.revision??'1']), chat: m.chatId, url: '', time: '' },
        })),
        { text: event.text, evidence: { id: event.key, chat: input.conversationId??event.thread, url: event.uri, time: '' } },
      ],
    };
    const { report } = await bot.plan(request, signal);
    return routesFor(report, catalog, request.defaultProject)[0] ?? { kind: 'ignore', reason: report.answer,evidence:report.evidence };
  };
}
