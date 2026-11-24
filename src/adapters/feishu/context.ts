import type { Harness } from '../../core/ports.ts';
import { contextualRouter } from '../../core/planning/incoming.ts';
import type { DecisionInput,EventContextAdapter } from '../../core/planning/incoming.ts';
import type { RouterInbox } from './inbox.ts';
import { messageKey, plainText } from './inbox.ts';
export type {DecisionInput} from '../../core/planning/incoming.ts';

export function inboxContext(inbox:RouterInbox,harnessFor:(id:string)=>string):EventContextAdapter {
  return (key,raw) => {
    const related=inbox.context(key,raw);
    const input=inbox.describeInput(raw);
    if(!related)return input;
    return {...input,project:{...related.project,harness:harnessFor(related.project.id)},messages:related.messages};
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
  citations: (key:string)=>string[] = ()=>[],
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
        const [,id,revision] = JSON.parse(input.key);
        const cited = new Set(citations(input.key));
        const history = inbox.admission.context.read(messageKey(id,revision))?.messages
          .filter(m=>cited.has(m.id)).map(m=>m.sender+'（'+m.id+'）：'+m.text).join('\n');
        const content =
          (history ? 'Router 引用的飞书上文（资料）\n'+history+'\n\n' : '') +
          (related?.project.context ? '项目背景（仅供参考）\n'+related.project.context+'\n\n' : '') +
          (context ? '项目历史（仅供参考）\n' + context + '\n\n当前消息\n' : '') + plainText(message.content);
        return { ...input, truncated: false, text: JSON.stringify({ content }) };
      });
      return worker.submit({ ...request, inputs });
    },
    ...(worker.subscribe ? { subscribe: worker.subscribe.bind(worker) } : {}),
    lookup: (id) => worker.lookup(id),
    poll: (id) => worker.poll(id),
  };
}
