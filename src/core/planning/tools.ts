import { factSpecs, type RouterFacts } from './facts.ts';
import { activeCandidates, type WorkQuery } from './work-query.ts';
import { z } from 'zod';
import type { Candidate, ContextReader, Evidence, PlanningRequest } from './contracts.ts';
export interface Toolbox {
  specs: object[];
  call: (params: unknown) => Promise<unknown>;
  refs: Map<string, Evidence>;
  accessed: Set<string>;
  listed: Set<string>;
}
export function maxDays(description: string) {
  const m = description.match(/(?:最近|过去|近)\s*(\d+|一|两|二|三|七|十)\s*天/);
  if (description.includes('24小时') || description.includes('24 小时') || description.includes('最近一天'))
    return 1;
  const n = m?.[1];
  if (n)
    return Math.min(30, Math.max(1, Number(n) || ({ 一: 1, 两: 2, 二: 2, 三: 3, 七: 7, 十: 10 }[n] ?? 1)));
  return /一周|本周/.test(description) ? 7 : /一个月|本月/.test(description) ? 30 : 3;
}
export function toolbox(
  job: Pick<PlanningRequest, 'description' | 'created' | 'sources'>,
  candidates: () => Candidate[],
  log: (step: string) => void,
  reader?: ContextReader,
  lookup?: (options: Parameters<WorkQuery>[1]) => ReturnType<WorkQuery>,
  facts?: RouterFacts,
): Toolbox {
  const refs = new Map<string, Evidence>(),
    accessed = new Set<string>(),
    listed = facts?.inspectedWorks ?? new Set<string>();
  const cursors = new Map<string, { token: string; days: number }>();
  let calls = 0;
  const readArgs = z.object({
    sourceId: z.string(),
    days: z.number().int().min(1).max(30),
    nextPage: z.boolean(),
  });
  const listArgs = z.object({
    activeOnly: z.boolean().optional(),
    projectId: z.string().optional(),
    text: z.string().optional(),
    states: z.array(z.string()).optional(),
    conversation: z.object({ source: z.string(), id: z.string() }).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z.string().optional(),
  });
  const detailArgs = z.object({ workId: z.string().min(1) });
  const specs = [
    ...(facts ? factSpecs : []),
    {
      name: 'read_selected_chat',
      description:
        'Read one chronological window of an explicitly selected conversation, latest messages first. Set nextPage=true to continue the same window.',
      inputSchema: z.toJSONSchema(readArgs),
    },
    {
      name: 'list_work_items',
      description:
        'List existing work items to identify an exact continuation target before planning a task.',
      inputSchema: z.toJSONSchema(listArgs),
    },
    ...(lookup
      ? [
          {
            name: 'get_work_item',
            description:
              'Inspect one listed work item: worker session, execution, queued inputs and recent input from the current conversation.',
            inputSchema: z.toJSONSchema(detailArgs),
          },
        ]
      : []),
  ];
  return {
    specs: specs.filter((spec) => spec.name !== 'read_selected_chat' || (reader && job.sources.length)),
    refs,
    accessed,
    listed,
    async call(raw) {
      const { tool, arguments: args } = z.object({ tool: z.string(), arguments: z.unknown() }).parse(raw);
      const isFactTool = factSpecs.some((spec) => spec.name === tool);
      if (
        facts &&
        (isFactTool || tool === 'list_work_items') &&
        args &&
        typeof args === 'object' &&
        'cursor' in args
      )
        return facts.call(tool, args, refs);
      if (++calls > 14) throw Error('工具步数已达上限');
      if (facts && isFactTool) {
        log('查询本地记录 · ' + tool);
        return facts.call(tool, args, refs);
      }
      let payload: unknown;
      if (tool === 'list_work_items') {
        const a = listArgs.parse(args);
        const { activeOnly = false } = a;
        const works = lookup
          ? lookup({ activeOnly })
          : activeOnly
            ? activeCandidates(candidates())
            : candidates();
        if (!Array.isArray(works)) throw Error('无效的事项列表');
        const visible = works.filter(
          (w) =>
            (!a.projectId || w.project === a.projectId) &&
            (!a.states || a.states.includes(w.state)) &&
            (!a.text || w.goal.toLowerCase().includes(a.text.toLowerCase())) &&
            (!a.conversation ||
              ('sourceConversations' in w &&
                Array.isArray(w.sourceConversations) &&
                w.sourceConversations.some(
                  (c) => c.source === a.conversation!.source && c.id === a.conversation!.id,
                ))),
        );
        if (a.limit && facts) return facts.workPage(visible, a.limit, listed);
        for (const w of visible) listed.add(w.id);
        log('查询已有事项');
        payload = visible;
      } else if (tool === 'get_work_item' && lookup) {
        const { workId } = detailArgs.parse(args);
        if (!listed.has(workId)) throw Error('请先查询本次可见的候选事项');
        payload = lookup({ workId });
        log('查看事项执行详情');
      } else if (tool === 'read_selected_chat') {
        const a = readArgs.parse(args);
        const source = job.sources.find((s) => s.id === a.sourceId);
        if (!source || !reader) throw Error('只能读取本次选中的会话');
        const days = Math.min(a.days, maxDays(job.description));
        const prior = cursors.get(source.id);
        if (a.nextPage && (!prior?.token || prior.days !== days)) throw Error('没有对应的下一页');
        log('读取' + source.name + ' · 最近 ' + days + ' 天' + (a.nextPage ? ' · 下一页' : ''));
        const page = await reader(
          source,
          new Date(Date.parse(job.created) - days * 86400000).toISOString(),
          job.created,
          a.nextPage ? prior!.token : '',
        );
        accessed.add(source.id);
        cursors.set(source.id, { token: page.next, days });
        for (const m of page.messages)
          refs.set(m.id, { id: m.id, chat: source.name, time: m.time, url: m.url });
        payload = {
          provenance: 'live_channel',
          asOf: job.created,
          source: source.name,
          days,
          hasMore: !!page.next,
          messages: page.messages.map((message) => {
            const { url, ...m } = message;
            if (!facts) return m;
            return {
              ...m,
              text: m.text.slice(0, 2400),
              truncated: m.text.length > 2400,
              ref: facts.rememberLive(source.id, message),
            };
          }),
        };
        log(source.name + ' · 已读取 ' + page.messages.length + ' 条');
      } else throw Error('未授权的工具');
      return payload;
    },
  };
}
