import type { Harness } from '../../core/ports.ts';
import { contextualRouter } from '../../core/planning/incoming.ts';
import type { DecisionInput,EventContextAdapter } from '../../core/planning/incoming.ts';
import type { RouterInbox } from './inbox.ts';
import { plainText } from './inbox.ts';
export type {DecisionInput} from '../../core/planning/incoming.ts';

export function inboxContext(inbox:RouterInbox,harnessFor:(id:string)=>string):EventContextAdapter {
  return (key,raw) => {
    const related=inbox.context(key,raw);
    const text=plainText(JSON.parse(raw).content);
    if(!related)return {text};
    return {text,project:{...related.project,harness:harnessFor(related.project.id)},messages:related.messages};
  };
}
export function projectRouter(inbox:RouterInbox,decide:(input:DecisionInput)=>Promise<unknown>,harnessFor:(id:string)=>string) {
  return contextualRouter({[inbox.name]:inboxContext(inbox,harnessFor)},decide);
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
        if (input.source === 'owner' && input.truncated) return {...input,text:full,truncated:false};
        if (input.source !== inbox.name) return input;
        const related = projectId ? inbox.context(input.key, full, projectId) : null;
        const message = JSON.parse(full);
        const context = (related?.messages ?? [])
          .map((m) => m.sender + '（消息 ' + m.messageId + '）：' + m.text)
          .join('\n');
        const content =
          (related?.project.context ? '项目背景（仅供参考）\n'+related.project.context+'\n\n' : '') +
          (context ? '项目历史（仅供参考）\n' + context + '\n\n当前消息\n' : '') + plainText(message.content);
        return { ...input, truncated: false, text: JSON.stringify({ content }) };
      });
      return worker.submit({ ...request, inputs });
    },
    lookup: (id) => worker.lookup(id),
    poll: (id) => worker.poll(id),
  };
}
