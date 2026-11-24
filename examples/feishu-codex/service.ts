import { codexSessionId, CodexHarness } from 'work-agent-kernel/adapters/codex';
import {
  loadBusinessHooks,
  type RouterExtension,
  createRouterApplication,
  type HostError,
  type Harness,
} from 'work-agent-kernel';
import {
  createFeishuChannel,
  startFeishuAdmission,
  ProjectRegistry,
  loadProjects,
  projectsSchema,
  RouterInbox,
  type Project,
  type Projects,
  projectWorker,
} from 'work-agent-kernel/adapters/feishu';
import { SqliteInbox } from 'work-agent-kernel/adapters/local';
import { isDeepStrictEqual } from 'node:util';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const ProjectsSchema = projectsSchema(codexSessionId);
import { localRouterProfile } from './profile.ts';

export async function serve(
  directory: string,
  configured: Projects,
  executable: string,
  signal: AbortSignal,
) {
  const hooks = process.env.ROUTER_HOOKS_FILE ? await loadBusinessHooks(process.env.ROUTER_HOOKS_FILE) : [];
  const cwd = join(directory, 'workspace');
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const projects = loadProjects(directory, configured);
  const registry = new ProjectRegistry(directory, codexSessionId);
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
    codex: projectWorker(null, inbox, (key) => app.getEvent(key)!.event.text, generic, citations),
  };
  function citations(key: string) {
    return app.getEvent(key)!.decisions?.at(-1)?.evidence ?? [];
  }
  function makeWorker(id: string, project: Project) {
    const worker = new CodexHarness({
      useDesktopDefaults: true,
      executable,
      cwd: project.cwd,
      directory: join(directory, 'projects', id),
    });
    return {
      worker,
      adapter: projectWorker(id, inbox, (key) => app.getEvent(key)!.event.text, worker, citations),
    };
  }
  for (const [id, p] of Object.entries(projects)) {
    const { worker, adapter } = makeWorker(id, p);
    workers.push(worker);
    harnesses[harnessFor(id)] = adapter;
  }
  const extensions: RouterExtension[] = [];
  if (process.env.ROUTER_EXTENSIONS_FILE) {
    const module = await import(pathToFileURL(resolve(process.env.ROUTER_EXTENSIONS_FILE)).href);
    const extra: unknown = await module.createRouterExtensions();
    if (!Array.isArray(extra) || !extra.every((bind) => typeof bind === 'function'))
      throw Error('createRouterExtensions() must return an array of Router extensions');
    extensions.push(...extra);
  }
  const channel = createFeishuChannel(inbox.admission);
  const app = createRouterApplication({
    directory,
    scheduling: { onCycle: updateService },
    catalog,
    signal,
    ...localRouterProfile(
      inbox,
      executable,
      harnessFor,
      {
        ...channel,
        async send(request, projects) {
          if (!admission.status().listening) throw Error('等待飞书回调监听就绪');
          return channel.send(request, projects);
        },
      },
      extensions,
    ),
    hooks,
    projectFact(id) {
      const project = projects[id];
      if (!project) return;
      const chats = new Set([
        ...(project.feishuChatId ? [project.feishuChatId] : []),
        ...(project.groups ?? []).flatMap((group) => [group.id, ...(group.aliases ?? [])]),
        ...inbox.admission
          .bindings()
          .filter((binding) => binding.project_id === id)
          .map((binding) => binding.chat_id),
      ]);
      return { definition: project, bindings: [...chats].map((id) => ({ source: inbox.name, id })) };
    },
    boundProject: (id) => inbox.admission.boundProject(id),
    harnesses,
    sinks: { inbox: outputs },
  });

  for (const [id, project] of Object.entries(projects)) {
    await app.registerProjectTarget({
      target: { id, name: project.name, harness: harnessFor(id) },
      adapter: harnesses[harnessFor(id)]!,
      sessions: project.sessions ?? [],
    });
  }
  async function registerProject(id: string, p: Project) {
    if (Object.hasOwn(projects, id)) {
      if (isDeepStrictEqual(projects[id], p)) return;
      throw Error('项目标识已存在。');
    }
    if (Object.values(projects).some((other) => other.name === p.name && other.cwd === p.cwd))
      throw Error('同名项目已在这个工作目录登记。');
    for (const group of p.groups ?? [])
      for (const chat of [group.id, ...(group.aliases ?? [])]) {
        if (inbox.admission.boundProject(chat)) throw Error('飞书会话「' + group.name + '」已绑定其他项目。');
      }
    const { worker, adapter } = makeWorker(id, p);
    try {
      await app.registerProjectTarget({
        target: { id, name: p.name, harness: harnessFor(id) },
        adapter,
        sessions: p.sessions ?? [],
      });
    } catch (error) {
      await worker.close();
      throw error;
    }
    workers.push(worker);
    inbox.addProject(id, p);
  }
  const admission = startFeishuAdmission(inbox.admission, signal, true, channel, app.wake);
  const stopCardWatch = inbox.subscribe(admission.flush);
  let registryError = false;
  const stopProjectWatch = registry.listen(
    async (id, project) => {
      await registerProject(id, project);
      registryError = false;
      app.wake();
    },
    () => {
      registryError = true;
      app.wake();
    },
  );
  function updateService(errors: HostError[]) {
    if (registryError) errors.push({ operation: 'project registry', error: '项目登记暂不可用' });
    writeFileSync(
      join(directory, 'health.tmp'),
      JSON.stringify({
        router: 'unified-agent-v1',
        profile: 'feishu-codex',
        applicationDriver: 2,
        hookProtocol: 1,
        routerFacts: 1,
        incomingContext: 1,
        projectRegistry: 1,
        hookEffects: app.hookEffects(),
        at: new Date().toISOString(),
        errors,
        projects,
        admission: admission.status(),
        conversationBindings: inbox.admission.bindings(),
      }),
    );
    renameSync(join(directory, 'health.tmp'), join(directory, 'health.json'));
  }
  try {
    if (!signal.aborted) {
      app.start();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    }
  } finally {
    await stopProjectWatch();
    stopCardWatch();
    await app.stop();
    await admission.close();
    await Promise.all(workers.map((worker) => worker.close()));
    await app.close();
    outputs.close();
    inbox.close();
    registry.close();
  }
}
