// Optional teaching profile. The sample service uses profile.ts unless explicitly changed.
import { type ApplicationOptions, type ContextReader, type PlanningRuntime, type RouterExtension } from 'work-agent-kernel';
import { codexPlanner } from 'work-agent-kernel/adapters/codex';
import { feishuIncomingContext, readChat, readPrecedingMessages, selectedChats, type RouterInbox, type AdmissionChannel } from 'work-agent-kernel/adapters/feishu';
import { localRouterProfile } from './profile.ts';

// 1. Customize the planner while keeping the real Codex agent loop and Desktop settings.
export function myPlanner(executable: string): PlanningRuntime {
  const plan = codexPlanner(executable);
  return (request, tools, signal, instructions) =>
    plan(request, tools, AbortSignal.any([signal, AbortSignal.timeout(90_000)]), instructions);
}

// 2. A Router-only skill can consist entirely of instructions.
export const myMergeWork: RouterExtension = () => ({
  instructions: '续接前检查已有事项。只有交付物相同才续接；同一项目下的独立交付物新建事项。',
});

// 3. Supply the read function for an admitted incoming message.
export function myIncomingContext(inbox: RouterInbox): RouterExtension {
  return feishuIncomingContext(inbox, async (chat, until, anchor) => {
    const messages = await readPrecedingMessages(chat, until, anchor);
    return messages.sort((a, b) => b.time.localeCompare(a.time)).slice(0, 3);
  });
}

// 4. Supply a paged reader and a maximum time window for explicitly selected chats.
export const readReleaseMessages: ContextReader = async (source, start, end, cursor) => {
  const page = await readChat(source, start, end, cursor);
  return { messages: page.messages.filter(m => m.text.includes('发布')), next: page.next };
};
export const mySelectedChats = selectedChats(readReleaseMessages, () => 2);

// 5. An ingress reads new source events. This fixture is ordered and append-only.
type Ticket = { id: string; author: string; title: string };
type Ingress = NonNullable<ApplicationOptions['ingress']>[number];

export function ticketIngress(tickets: readonly Ticket[]): Ingress {
  return {
    source: {
      name: 'tickets',
      async fetch(cursor) {
        const events = tickets.slice(Number(cursor ?? 0)).map(t => ({
          source: 'tickets', externalId: t.id, revision: '1', thread: t.id,
          actor: t.author, text: t.title, uri: 'ticket://' + t.id, occurredAt: null,
        }));
        return { events, cursor: String(tickets.length) };
      },
    },
    hooks: [],
  };
}

// Same parameters as localRouterProfile in service.ts. Reuse its Feishu ingress and approval hook.
export function customProfile(
  inbox: RouterInbox, executable: string, harnessFor: (id: string) => string,
  channel: AdmissionChannel, extra: RouterExtension[] = [],
) {
  const base = localRouterProfile(inbox, executable, harnessFor, channel, extra);
  return {
    ...base,
    runtime: myPlanner(executable),
    ingress: [...base.ingress, ticketIngress([{ id: 'T-17', author: '小林', title: '整理发布检查项' }])],
    selectedArchive: { source: inbox.name, historyDays: () => 2 },
    router: { archiveTools:true, extensions: [myMergeWork, myIncomingContext(inbox), mySelectedChats, ...extra] },
  };
}
