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
export function incomingPlanner(bot: RouterBot, catalog: Catalog, signal: AbortSignal,language:'zh'|'en'='zh') {
  return async (input: DecisionInput) => {
    const { event, project, projectMessages = [] } = input;
    const available = catalog.projects.filter((p) =>
      project ? p.id === project.id : input.harnesses.includes(p.harness),
    );
    const request: PlanningRequest = {
      id: event.key,
      origin: { kind: 'event', actor: event.actor, uri: event.uri,source:event.source,...(input.receivedAt ? {receivedAt:input.receivedAt} : {}),conversationId:input.conversationId??null },
      description:language==='en'?'Use the instructions and evidence to decide whether to ignore, create, or continue work.':
        '依据本轮指引与证据，判断此输入应忽略、新建事项或续接已有事项。',
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
                  (language==='en'?'Work already linked to this source thread: ':'本讨论串已经关联的事项：') +
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
          evidence: { id: JSON.stringify([event.source,m.messageId,m.revision??'1']), sourceLabel: m.conversationId, url: '', time: '' },
        })),
        { text: event.text, evidence: { id: event.key, sourceLabel: input.conversationId??event.thread, url: event.uri, time: '' } },
      ],
    };
    const { report } = await bot.plan(request, signal);
    return routesFor(report, catalog, request.defaultProject)[0] ?? { kind: 'ignore', reason: report.answer,evidence:report.evidence };
  };
}
