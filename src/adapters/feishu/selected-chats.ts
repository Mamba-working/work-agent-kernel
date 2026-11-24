import { z } from 'zod';
import type { ContextReader } from '../../core/planning/contracts.ts';
import type { RouterExtension } from '../../core/planning/extensions.ts';

const readArgs = z.strictObject({
  sourceId: z.string(),
  days: z.number().int().min(1).max(30),
  nextPage: z.boolean(),
});

export function selectedChats(
  reader: ContextReader,
  maxDays: (description: string) => number,
): RouterExtension {
  return (request, services) => {
    if (request.origin.kind !== 'owner' || !request.sources.length) return;
    const unread = new Set(request.sources.map((s) => s.id));
    const cursors = new Map<string, { token: string; days: number }>();
    return {
      instructions:
        '读取每个选定聊天至少一页，按委托范围翻页。实时聊天与本地归档分别取证。引用实时消息时复制其 id。',
      verify() {
        if (unread.size) throw Error('未读取所有选中来源');
      },
      tools: [
        {
          name: 'read_selected_chat',
          description:
            'Read a page from one selected conversation. Use nextPage to continue the same time window.',
          schema: readArgs,
          async run(input) {
            const a = readArgs.parse(input);
            const source = request.sources.find((s) => s.id === a.sourceId);
            if (!source) throw Error('只能读取本次选中的会话');
            const days = Math.min(a.days, maxDays(request.description)),
              prior = cursors.get(source.id);
            if (a.nextPage && (!prior?.token || prior.days !== days)) throw Error('没有对应的下一页');
            const start = new Date(Date.parse(request.created) - days * 86400000).toISOString();
            const page = await reader(source, start, request.created, a.nextPage ? prior!.token : '');
            unread.delete(source.id);
            cursors.set(source.id, { token: page.next, days });
            services.log(source.name + ' · 最近 ' + days + ' 天 · 已读取 ' + page.messages.length + ' 条');
            return {
              evidence: page.messages.map((m) => ({ id: m.id, chat: source.name, time: m.time, url: m.url })),
              value: {
                provenance: 'live_channel',
                asOf: request.created,
                source: source.name,
                days,
                hasMore: !!page.next,
                messages: page.messages.map(({ url, ...m }) => {
                  const ref = services.rememberLive?.(source.id, { url, ...m });
                  return ref
                    ? { ...m, text: m.text.slice(0, 2400), truncated: m.text.length > 2400, ref }
                    : m;
                }),
              },
            };
          },
        },
      ],
    };
  };
}
