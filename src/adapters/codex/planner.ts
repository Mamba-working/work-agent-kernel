import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { CodexAppServer } from './app-server.ts';
import { Report } from '../../core/planning/contracts.ts';
import type { PlanningRuntime } from '../../core/planning/contracts.ts';
export function codexPlanner(executable: string): PlanningRuntime {
  return async (request, tools, signal, instructions) => {
    const cwd = await mkdtemp(join(tmpdir(), 'router-agent-'));
    let finalText = '';
    let settle!: (report: Report) => void, fail!: (error: Error) => void;
    const completion = new Promise<Report>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    // Startup, cancellation and turn completion can arrive in either order.
    void completion.catch(() => {});
    const combined = AbortSignal.any([signal, AbortSignal.timeout(300000)]);
    const stop = () => fail(Error('本次分析已中止或超时，可重新派发'));
    combined.addEventListener('abort', stop, { once: true });
    const client = new CodexAppServer({
      executable,
      cwd,
      env: process.env,
      args: [
        'app-server',
        '--listen',
        'stdio://',
        '--disable',
        'shell_tool',
        '--disable',
        'unified_exec',
        '--disable',
        'plugins',
        '--disable',
        'apps',
        '--disable',
        'hooks',
        '--disable',
        'browser_use',
        '--disable',
        'computer_use',
        '-c',
        'web_search="disabled"',
      ],
      async toolCall(params) {
        const value = await tools.call(params);
        return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] };
      },
      onClose: () => fail(Error('Codex 连接已断开')),
      onNotification(method, params) {
        const p = params as {
          item?: { type?: string; text?: string; phase?: string };
          turn?: { status?: string; error?: { message?: string } };
        };
        if (method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.phase !== 'commentary')
          finalText = p.item.text ?? '';
        if (method === 'turn/completed') {
          if (p.turn?.status !== 'completed') {
            fail(Error(p.turn?.error?.message?.slice(0, 300) || 'Codex 运行失败'));
            return;
          }
          try {
            settle(Report.parse(JSON.parse(finalText)));
          } catch {
            fail(Error('Router 返回结果格式无效'));
          }
        }
      },
    });
    try {
      await client.ready;
      const { config } = (await client.request('config/read', { cwd })) as {
        config: { mcp_servers?: Record<string, unknown> };
      };
      const { thread } = (await client.request('thread/start', {
        cwd,
        ephemeral: true,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        developerInstructions: instructions,
        config: {
          mcp_servers: Object.fromEntries(
            Object.keys(config.mcp_servers ?? {}).map((id) => [id, { enabled: false }]),
          ),
        },
        dynamicTools: tools.specs,
      })) as { thread: { id: string } };
      if (combined.aborted) throw Error('分析已取消');
      await client.request('turn/start', {
        threadId: thread.id,
        input: [
          {
            type: 'text',
            text: JSON.stringify({
              origin: request.origin,
              instruction: request.description,
              context: request.context,
              selectedSources: request.sources,
              submittedAt: request.created,
              projects: request.projects,
              defaultProject: request.defaultProject,
              maxActions: request.maxActions,
            }),
            text_elements: [],
          },
        ],
        outputSchema: z.toJSONSchema(Report),
      });
      return await completion;
    } finally {
      combined.removeEventListener('abort', stop);
      await client.close();
      await rm(cwd, { recursive: true, force: true });
    }
  };
}
