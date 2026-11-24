import { factSpecs, type RouterFacts } from './facts.ts';
import { activeCandidates, type WorkQuery } from './work-query.ts';
import { z } from 'zod';
import type { Candidate, Evidence } from './contracts.ts';
export interface Toolbox {
  specs: object[];
  call: (params: unknown) => Promise<unknown>;
  refs: Map<string, Evidence>;
  listed: Set<string>;
}
export function toolbox(
  candidates: () => Candidate[],
  log: (step: string) => void,
  lookup?: (options: Parameters<WorkQuery>[1]) => ReturnType<WorkQuery>,
  facts?: RouterFacts,
): Toolbox {
  const refs = new Map<string, Evidence>(),
    listed = facts?.inspectedWorks ?? new Set<string>();
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
    specs,
    refs,
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
      } else throw Error('未授权的工具');
      return payload;
    },
  };
}
