import type { ProjectFact } from './planning/facts.ts';
import { queryWork } from './planning/work-query.ts';
import { Lifecycle } from './hooks/lifecycle.ts';
import type { LifecycleHook } from './hooks/lifecycle.ts';
import { join } from 'node:path';
import { Kernel } from './kernel.ts';
import { TaskObservers } from './task-handles.ts';
import { ApplicationScheduler } from './scheduler.ts';
import { Host, type HostError } from './host.ts';
import type { Harness, NotificationSink, Source } from './ports.ts';
import { RouterBot } from './planning/router.ts';
import { contextualRouter } from './planning/incoming.ts';
import type { EventContextAdapter } from './planning/incoming.ts';
import type { Target, Catalog, PlanningRuntime } from './planning/contracts.ts';
import { incomingPlanner } from './planning/requests.ts';
import { DispatchStore, type TaskSubmission } from './dispatch/store.ts';
import { prepareDispatch, processDispatch } from './dispatch/process.ts';

import type { RouterExtension } from './planning/extensions.ts';

export interface ProjectTargetRegistration {
  target: Target;
  adapter: Harness;
  sessions?: readonly { id: string; title: string }[];
}

export interface ApplicationOptions {
  router?: {
    language?: 'zh' | 'en';
    extensions?: readonly RouterExtension[];
    instructions?: string;
    maxActions?: number;
    maxToolCalls?: number;
    archiveTools?: boolean;
  };
  owner?: string;
  maxSources?: number;
  scheduling?: { reconcileMs?: number; onCycle?: (errors: HostError[]) => void };
  directory: string;
  catalog: Catalog;
  runtime: PlanningRuntime;
  hooks?: LifecycleHook[];
  ingress?: { source: Source; context?: EventContextAdapter; hooks: LifecycleHook[] }[];
  selectedArchive?: { source: string; historyDays: (description: string) => number };
  ownerActionLimit?: (description: string) => number;
  projectFact?: (id: string) => ProjectFact | undefined;
  sources?: Source[];
  eventContexts?: Record<string, EventContextAdapter>;
  boundProject?: (sourceId: string) => string | null;
  harnesses: Record<string, Harness>;
  sinks: Record<string, NotificationSink>;
  resultSink?: string;
  signal: AbortSignal;
}

// External adapters own their connections. The application owns the two durable queues.
function assemble(options: ApplicationOptions) {
  const { directory, signal } = options;
  const catalog = structuredClone(options.catalog);
  if (new Set(catalog.projects.map((p) => p.id)).size !== catalog.projects.length)
    throw Error('Duplicate project ID');
  const owner = options.owner ?? 'local-owner';
  const maxActions = options.router?.maxActions ?? 12,
    maxSources = options.maxSources ?? 12;
  if (
    !owner.trim() ||
    [maxActions, maxSources, options.router?.maxToolCalls ?? 14].some(
      (n) => !Number.isSafeInteger(n) || n < 0,
    )
  )
    throw Error('Invalid owner or application limits');
  const reconcileMs = options.scheduling?.reconcileMs;
  if (
    reconcileMs !== undefined &&
    (!Number.isSafeInteger(reconcileMs) || reconcileMs < 1 || reconcileMs > 2147483647)
  )
    throw Error('reconcileMs must be a positive timer interval in milliseconds');
  for (const name of [catalog.defaultHarness, ...catalog.projects.map((p) => p.harness)]) {
    if (!Object.hasOwn(options.harnesses, name)) throw Error('Harness not registered: ' + name);
  }
  const ingress = options.ingress ?? [];
  const sources = [...(options.sources ?? []), ...ingress.map((i) => i.source)];
  if (new Set(sources.map((s) => s.name)).size !== sources.length) throw Error('Duplicate source name');
  let lifetime = new AbortController();
  const runtime: PlanningRuntime = async (req, tools, signal, instructions) => {
    const scope = AbortSignal.any([signal, lifetime.signal]);
    scope.throwIfAborted();
    const result = await options.runtime(req, tools, scope, instructions);
    scope.throwIfAborted();
    return result;
  };
  const bot = new RouterBot(runtime, {
    ...options.router,
    lookup: (request, opts) => queryWork(kernel, sources, request, opts),
    facts: {
      snapshot: () => kernel.factSnapshot(),
      sources,
      ...(options.selectedArchive
        ? { archiveSource: options.selectedArchive.source, historyDays: options.selectedArchive.historyDays }
        : {}),
      ...(options.projectFact ? { project: options.projectFact } : {}),
    },
  });
  const contexts = { ...options.eventContexts };
  for (const entry of ingress) if (entry.context) contexts[entry.source.name] = entry.context;
  const hooks = new Lifecycle(join(directory, 'hooks.sqlite'), [
    ...ingress.flatMap((i) => i.hooks),
    ...(options.hooks ?? []),
  ]);
  const kernel: Kernel = new Kernel({
    hooks,
    path: join(directory, 'kernel.sqlite'),
    owner,
    subscriptionRouting: 'evaluate',
    router: contextualRouter(contexts, incomingPlanner(bot, catalog, signal, options.router?.language)),
    harnesses: options.harnesses,
    sinks: options.sinks,
    defaultSink: options.resultSink ?? 'inbox',
  });
  kernel.restoreProjectIds((harness) => {
    const matches = catalog.projects.filter((p) => p.harness === harness);
    return matches.length === 1 && harness !== catalog.defaultHarness ? matches[0]!.id : null;
  });
  const host = new Host({ kernel, sources });
  const dispatch = new DispatchStore(directory, () => scheduler.wake(), maxSources);
  const observers = new TaskObservers(kernel.factSnapshot());
  const dispatchArgs = () =>
    [
      dispatch,
      kernel,
      catalog,
      bot,
      AbortSignal.any([signal, lifetime.signal]),
      options.boundProject ?? (() => null),
      hooks,
      options.ownerActionLimit ?? (() => maxActions),
      owner,
    ] as const;
  const processNextDispatch = () => processDispatch(...dispatchArgs());
  let ownerFirst = true;
  const refresh = () => observers.refresh(dispatch, kernel.factSnapshot());
  const scheduler = new ApplicationScheduler({
    directory,
    host,
    hooks,
    signal,
    onAbort: () => {
      void stop();
    },
    interval: () =>
      reconcileMs ??
      (sources.some((s) => !s.subscribe) ||
      kernel
        .works()
        .some(
          (w) =>
            w.execution.kind === 'uncertain' ||
            (w.execution.kind === 'running' && !kernel.harnesses.get(w.harness)?.subscribe),
        )
        ? 2000
        : 30000),
    ...(options.scheduling?.onCycle ? { onCycle: options.scheduling.onCycle } : {}),
    adapters: () => [hooks, ...sources, ...kernel.harnesses.values()],
    refresh,
    plan() {
      const owner = () =>
        prepareDispatch(...dispatchArgs(), (save) => {
          void scheduler.command(save).catch((error) => process.emitWarning(String(error)));
        });
      const passive = () => {
        const route = kernel.prepareRoute();
        return route instanceof Promise ? route.then((commit) => () => commit() !== null) : route !== null;
      };
      const order = ownerFirst ? [owner, passive] : [passive, owner];
      ownerFirst = !ownerFirst;
      for (const take of order) {
        const work = take();
        if (work !== false) return work;
      }
      return false;
    },
  });
  let closing: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  function assertOpen() {
    if (closing) throw Error('Application closed');
    if (stopping) throw Error('Application is stopping');
    signal.throwIfAborted();
  }
  function task(id: string) {
    assertOpen();
    return observers.attach(dispatch.get(id), kernel.factSnapshot());
  }
  function stop() {
    if (stopping) return stopping;
    lifetime.abort();
    stopping = scheduler
      .stop()
      .then(() => {
        observers.detach();
      })
      .finally(() => {
        stopping = undefined;
      });
    return stopping;
  }
  function activate() {
    assertOpen();
    if (lifetime.signal.aborted) lifetime = new AbortController();
  }
  function command<T>(apply: () => T) {
    assertOpen();
    return scheduler.command(apply);
  }
  const app = {
    getEvent: kernel.findEvent.bind(kernel),
    getWork: kernel.findWork.bind(kernel),
    listWorks: kernel.works.bind(kernel),
    listAttentions: kernel.attentions.bind(kernel),
    getNotice: kernel.findNotice.bind(kernel),
    listProjectTargets: () => structuredClone(catalog.projects),
    getDispatch: (id: string) => dispatch.get(id),
    hookStatus: hooks.status.bind(hooks),
    hookEffects: () => hooks.effectFailures(),
    resume: (...args: Parameters<Lifecycle['resume']>) => command(() => hooks.resume(...args)),
    retryHook: (...args: Parameters<Lifecycle['retry']>) => command(() => hooks.retry(...args)),
    ingest: (input: unknown) => command(() => kernel.ingest(input)),
    rebind: (...args: Parameters<Kernel['rebind']>) => command(() => kernel.rebind(...args)),
    registerProjectTarget(input: ProjectTargetRegistration) {
      const target = structuredClone(input.target),
        sessions = structuredClone(input.sessions ?? []),
        adapter = input.adapter;
      return command(() => {
        if (!target.id.trim() || !target.name.trim() || !target.harness.trim())
          throw Error('Incomplete project target');
        const prior = catalog.projects.find((p) => p.id === target.id);
        if (prior && prior.harness !== target.harness)
          throw Error('Project harness migration requires an explicit rebind');
        if (
          sessions.some((s) => !s.id.trim() || !s.title.trim()) ||
          new Set(sessions.map((s) => s.id)).size !== sessions.length
        )
          throw Error('Invalid or duplicate project session');
        const ids = kernel.registerTarget(target.harness, adapter, sessions, target.id);
        if (prior) prior.name = target.name;
        else catalog.projects.push(target);
        return ids;
      });
    },
    setHarness: (name: string, harness: Harness | undefined) =>
      command(() => {
        if (kernel.harnesses.get(name) === harness) return;
        if (
          kernel
            .works()
            .some((w) => w.harness === name && ['running', 'uncertain'].includes(w.execution.kind))
        )
          throw Error('Settle active runs before replacing their harness');
        if (harness) kernel.harnesses.set(name, harness);
        else kernel.harnesses.delete(name);
      }),
    start() {
      activate();
      scheduler.start();
    },
    stop,
    step() {
      activate();
      return scheduler.step();
    },
    wake: scheduler.wake,
    submit(input: TaskSubmission) {
      assertOpen();
      const job = dispatch.submit(input);
      return task(job.id);
    },
    task,
    on: observers.on.bind(observers),
    answer(input: Parameters<Kernel['answer']>[0]) {
      return command(() => kernel.answer(input));
    },
    close() {
      closing ??= stop().then(() => {
        dispatch.close();
        kernel.close();
        hooks.close();
      });
      return closing;
    },
  };
  return { app, kernel, host, dispatch, hooks, processNextDispatch };
}
export function createRouterApplication(options: ApplicationOptions) {
  return assemble(options).app;
}

// Explicit low-level test fixture, intentionally absent from the public barrel and without start().
export function createManualTestApplication(options: ApplicationOptions) {
  const { app, ...raw } = assemble(options);
  const { start: _start, ...manual } = app;
  return { ...manual, ...raw };
}
