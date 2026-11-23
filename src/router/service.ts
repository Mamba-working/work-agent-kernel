import {loadBusinessHooks} from '../core/hooks/load.ts';
import { feishuIngress } from './feishu-ingress.ts';
import { feishuChannel, startFeishuAdmission } from '../adapters/feishu/channel.ts';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createRouterApplication } from '../core/application.ts';
import { CodexHarness } from '../adapters/codex/harness.ts';
import { runController } from '../core/controller.ts';
import { SqliteInbox } from '../adapters/local/inbox.ts';
import { RouterInbox } from '../adapters/feishu/inbox.ts';
import type { Projects } from '../adapters/feishu/inbox.ts';
import type { Harness } from '../core/ports.ts';
import { EventKey } from '../core/domain.ts';
import { projectWorker } from '../adapters/feishu/context.ts';
import { codexPlanner } from '../adapters/codex/planner.ts';
import { readChat } from '../adapters/feishu/chats.ts';

export const ProjectsSchema = z.record(
  z.string().min(1),
  z.object({
    name: z.string().min(1),
    cwd: z.string().min(1),
    feishuChatId: z.string().min(1).optional(),
    groups: z
      .array(
        z.object({
          name: z.string().min(1),
          id: z.string().min(1),
          aliases: z.array(z.string().min(1)).optional(),
        }),
      )
      .optional(),
    sessions: z.array(z.object({ title: z.string().min(1), id: z.string().uuid() })).optional(),
    context: z.string().optional(),
    artwork: z.literal('architecture').optional(),
  }),
);
export async function serve(directory: string, projects: Projects, executable: string, signal: AbortSignal) {
  const hooks = process.env.ROUTER_HOOKS_FILE ? await loadBusinessHooks(process.env.ROUTER_HOOKS_FILE) : [];
  const cwd = join(directory, 'workspace');
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const inbox = new RouterInbox(join(directory, 'feishu.sqlite'), projects);
  const outputs = new SqliteInbox(join(directory, 'results.sqlite'));
  const harnessFor = (id: string) => 'codex/' + id;
  const catalog = {
    defaultHarness: 'codex',
    projects: Object.entries(projects).map(([id, p]) => ({ id, name: p.name, harness: harnessFor(id) })),
  };
  const generic = new CodexHarness({
    useDesktopDefaults: true,
    executable,
    cwd,
    directory: join(directory, 'codex'),
  });
  const workers = [generic];
  const harnesses: Record<string, Harness> = {
    codex: projectWorker(null, inbox, (key) => kernel.recall().event(EventKey.parse(key)).text, generic),
  };
  for (const [id, project] of Object.entries(projects)) {
    const worker = new CodexHarness({
      useDesktopDefaults: true,
      executable,
      cwd: project.cwd,
      directory: join(directory, 'projects', id),
    });
    workers.push(worker);
    harnesses[harnessFor(id)] = projectWorker(
      id,
      inbox,
      (key) => kernel.recall().event(EventKey.parse(key)).text,
      worker,
    );
  }
  const app = createRouterApplication({
    directory,
    catalog,
    signal,
    runtime: codexPlanner(executable),
    hooks,
    reader: readChat,
    ingress: [
      feishuIngress(inbox, harnessFor, {
        ...feishuChannel,
        async send(request, projects) {
          if (!admission.status().listening) throw Error('等待飞书回调监听就绪');
          return feishuChannel.send(request, projects);
        },
      }),
    ],
    boundProject: (id) => inbox.admission.boundProject(id),
    harnesses,
    sinks: { inbox: outputs },
  });
  const { kernel, host } = app;
  for (const [id, project] of Object.entries(projects)) {
    for (const session of project.sessions ?? [])
      kernel.registerSession(harnessFor(id), session.id, session.title, id);
  }
  const admission = startFeishuAdmission(inbox.admission, signal, true);
  let active: Promise<void> | undefined;
  let queueError = false;
  const pump = setInterval(() => {
    if (active || signal.aborted) return;
    active = app
      .processNextDispatch()
      .then(
        () => {
          queueError = false;
        },
        () => {
          queueError = true;
        },
      )
      .finally(() => {
        active = undefined;
      });
  }, 1000);
  try {
    await runController({
      host,
      signal,
      intervalMs: 2000,
      onTick(errors) {
        if (queueError) errors.push({ operation: 'dispatch queue', error: '主动任务队列暂不可用' });
        writeFileSync(
          join(directory, 'health.tmp'),
          JSON.stringify({
            router: 'unified-agent-v1',
            hookProtocol: 1,
            hookEffects: app.hooks.effectFailures(),
            at: new Date().toISOString(),
            errors,
            projects,
            admission: admission.status(),
            conversationBindings: inbox.admission.bindings(),
          }),
        );
        renameSync(join(directory, 'health.tmp'), join(directory, 'health.json'));
      },
    });
  } finally {
    await admission.close();
    clearInterval(pump);
    await active;
    await Promise.all(workers.map((worker) => worker.close()));
    await app.close();
    outputs.close();
    inbox.close();
  }
}
