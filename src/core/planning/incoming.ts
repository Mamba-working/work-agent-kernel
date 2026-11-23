import { RouteSchema } from '../domain.ts';
import type { RouteContext, Router } from '../ports.ts';

interface ProjectContext {
  id: string;
  name: string;
  harness: string;
  context?: string;
}
export interface HistoryMessage {
  messageId: string;
  chatId: string;
  sender: string;
  text: string;
}
export type DecisionInput = RouteContext & { project?: ProjectContext; projectMessages?: HistoryMessage[] };
export type EventContextAdapter = (
  key: string,
  text: string,
) => {
  text: string;
  project?: ProjectContext;
  messages?: HistoryMessage[];
};

export function contextualRouter(
  adapters: Record<string, EventContextAdapter>,
  decide: (input: DecisionInput) => Promise<unknown>,
): Router {
  return {
    async decide(context, recall) {
      const candidates = context.hasMoreCandidates
        ? recall
            .listWorks()
            .map(({ id, goal, harness, projectId, scope, execution }) => ({
              id,
              goal,
              harness,
              projectId,
              scope,
              execution,
            }))
        : context.candidates;
      const event = { ...context.event, ...recall.event(context.event.key), truncated: false };
      const details = adapters[event.source]?.(event.key, event.text);
      if (details) event.text = details.text;
      const project = details?.project;
      const input: DecisionInput = project
        ? {
            ...context,
            event,
            project,
            projectMessages: details?.messages ?? [],
            candidates: candidates.filter((w) =>
              w.projectId === undefined ? w.harness === project.harness : w.projectId === project.id,
            ),
            harnesses: [project.harness],
          }
        : { ...context, event, candidates };
      const decision = RouteSchema.parse(await decide(input));
      if (decision.kind === 'attach' && !input.candidates.some((w) => w.id === decision.workId))
        throw new Error('Unknown or cross-project work item');
      if (decision.kind === 'create' && project)
        return { ...decision, projectId: project.id, harness: project.harness };
      if (decision.kind === 'create' && !input.harnesses.includes(decision.harness))
        throw new Error('Unknown harness');
      return decision;
    },
  };
}
