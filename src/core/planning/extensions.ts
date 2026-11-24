import { z } from 'zod';
import type { AgentTools, Evidence, PlanningRequest } from './contracts.ts';

export interface RouterTool {
  name: string;
  description: string;
  schema: z.ZodType;
  required?: boolean;
  run(args: unknown): Promise<{ value: unknown; evidence?: Evidence[] }>;
}

/** Trusted application code binds capabilities to one admitted planning request. */
export type RouterExtension = (
  request: PlanningRequest,
) => { instructions?: string; tools?: RouterTool[] } | undefined;

export function bindExtensions(
  request: PlanningRequest,
  extensions: readonly RouterExtension[],
  base: AgentTools,
  refs: Map<string, Evidence>,
  log: (step: string) => void,
) {
  const specs = [...base.specs];
  const names = new Set(specs.map((s) => (s as { name: string }).name));
  const tools = new Map<string, RouterTool>();
  const pending = new Set<string>();
  const instructions: string[] = [];
  for (const bind of extensions) {
    const extension = bind(request);
    if (!extension) continue;
    if (extension.instructions) instructions.push(extension.instructions);
    for (const tool of extension.tools ?? []) {
      if (names.has(tool.name)) throw Error('Duplicate Router tool: ' + tool.name);
      names.add(tool.name);
      tools.set(tool.name, tool);
      if (tool.required) pending.add(tool.name);
      specs.push({
        name: tool.name,
        description: tool.description,
        inputSchema: z.toJSONSchema(tool.schema),
      });
    }
  }
  return {
    instructions,
    agentTools: {
      specs,
      async call(params: unknown) {
        const { tool: name, arguments: args } = z
          .object({ tool: z.string(), arguments: z.unknown() })
          .parse(params);
        const tool = tools.get(name);
        if (!tool) return base.call(params);
        const result = await tool.run(tool.schema.parse(args));
        for (const ref of result.evidence ?? []) refs.set(ref.id, ref);
        pending.delete(name);
        log('调用扩展工具 · ' + name);
        return result.value;
      },
    } satisfies AgentTools,
    verify() {
      if (pending.size) throw Error('提交路由前需要读取：' + [...pending].join(', '));
    },
  };
}
