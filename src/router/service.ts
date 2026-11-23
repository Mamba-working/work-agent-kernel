import {startFeishuAdmission} from '../admission/feishu.ts';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Kernel } from '../kernel.ts';
import { Host } from '../host.ts';
import { CodexHarness } from '../live/codex-harness.ts';
import { runController } from '../live/controller.ts';
import { SqliteInbox } from '../adapters.ts';
import { RouterInbox } from './inbox.ts';
import type { Projects } from './inbox.ts';
import type { Harness } from '../ports.ts';
import { EventKey } from '../domain.ts';
import { projectRouter, projectWorker } from './routing.ts';
import { desktopDecision } from './desktop-decision.ts';

export const ProjectsSchema = z.record(
  z.string().min(1),
  z.object({
    name: z.string().min(1),
    cwd: z.string().min(1),
    feishuChatId: z.string().min(1).optional(),
    groups: z.array(z.object({name:z.string().min(1),id:z.string().min(1),aliases:z.array(z.string().min(1)).optional()})).optional(),
  }),
);
export async function serve(directory: string, projects: Projects, executable: string, signal: AbortSignal) {
  const cwd = join(directory, 'workspace');
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const inbox = new RouterInbox(join(directory, 'feishu.sqlite'), projects);
  const outputs = new SqliteInbox(join(directory, 'results.sqlite'));
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
    harnesses['codex/' + id] = projectWorker(
      id,
      inbox,
      (key) => kernel.recall().event(EventKey.parse(key)).text,
      worker,
    );
  }
  const kernel = new Kernel({
    path: join(directory, 'kernel.sqlite'),
    owner: 'local-owner',
    router: projectRouter(inbox, desktopDecision(executable)),
    harnesses,
    sinks: { inbox: outputs },
  });
  const admission=startFeishuAdmission(inbox.admission,signal);
  const host = new Host({ kernel, sources: [inbox] });
  try {
    await runController({
      host,
      signal,
      intervalMs: 2000,
      onTick(errors) {
        writeFileSync(
          join(directory, 'health.tmp'),
          JSON.stringify({ at: new Date().toISOString(), errors, projects, admission:admission.status(), conversationBindings:inbox.admission.bindings() }),
        );
        renameSync(join(directory, 'health.tmp'), join(directory, 'health.json'));
      },
    });
  } finally {
    await admission.close();
    await Promise.all(workers.map((worker) => worker.close()));
    kernel.close();
    outputs.close();
    inbox.close();
  }
}
