import { RouteSchema } from '../domain.ts';
import type { RouteContext, Router, Harness } from '../ports.ts';
import type { RouterInbox } from './inbox.ts';
import { plainText } from './inbox.ts';
export type DecisionInput = RouteContext & {
  project?: { id: string; name: string; harness: string };
  projectMessages?: NonNullable<ReturnType<RouterInbox['context']>>['messages'];
};
export function projectRouter(inbox: RouterInbox, decide: (input: DecisionInput) => Promise<unknown>): Router {
  return {
    async decide(context, recall) {
      const candidates = context.hasMoreCandidates
        ? recall
            .listWorks()
            .map(({ id, goal, harness, scope, execution }) => ({ id, goal, harness, scope, execution }))
        : context.candidates;
      const event = { ...context.event, ...recall.event(context.event.key), truncated: false };
      const related = inbox.context(event.key, event.text);
      // The model only needs the message. Keep transport metadata in the receiver's audit record.
      if (event.source === inbox.name) event.text = plainText(JSON.parse(event.text).content);
      const input: DecisionInput = related
        ? {
            ...context,
            event,
            project: related.project,
            projectMessages: related.messages,
            candidates: candidates.filter((w) => w.harness === related.project.harness),
            harnesses: [related.project.harness],
          }
        : { ...context, candidates, event };
      const decision = RouteSchema.parse(await decide(input));
      if (decision.kind === 'attach' && !input.candidates.some((w) => w.id === decision.workId))
        throw new Error('Unknown or cross-project work item');
      if (decision.kind === 'create' && related) return { ...decision, harness: related.project.harness };
      if (decision.kind === 'create' && !input.harnesses.includes(decision.harness))
        throw new Error('Unknown harness');
      return decision;
    },
  };
}
export function projectWorker(
  projectId: string | null,
  inbox: RouterInbox,
  fullText: (key: string) => string,
  worker: Harness,
): Harness {
  return {
    submit(request) {
      const inputs = request.inputs.map((input) => {
        const full = fullText(input.key);
        if (input.source !== inbox.name) return input;
        const related = projectId ? inbox.context(input.key, full, projectId) : null;
        const message = JSON.parse(full);
        const context = (related?.messages ?? [])
          .map((m) => m.sender + '（消息 ' + m.messageId + '）：' + m.text)
          .join('\n');
        const content =
          (context ? '项目历史（仅供参考）\n' + context + '\n\n当前消息\n' : '') + plainText(message.content);
        return { ...input, truncated: false, text: JSON.stringify({ content }) };
      });
      return worker.submit({ ...request, inputs });
    },
    lookup: (id) => worker.lookup(id),
    poll: (id) => worker.poll(id),
  };
}
