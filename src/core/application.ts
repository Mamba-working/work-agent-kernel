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
import type { Catalog, PlanningRuntime } from './planning/contracts.ts';
import { incomingPlanner } from './planning/requests.ts';
import { DispatchStore, type TaskSubmission } from './dispatch/store.ts';
import { processDispatch } from './dispatch/process.ts';

import type { RouterExtension } from './planning/extensions.ts';

export interface ApplicationOptions {
  router?: { extensions: readonly RouterExtension[] };
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
export function createRouterApplication(options: ApplicationOptions) {
  const { directory, catalog, signal } = options;
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
    owner: 'local-owner',
    subscriptionRouting: 'evaluate',
    router: contextualRouter(contexts, incomingPlanner(bot, catalog, signal)),
    harnesses: options.harnesses,
    sinks: options.sinks,
    defaultSink: options.resultSink ?? 'inbox',
  });
  kernel.restoreProjectIds((harness) => {
    const matches = catalog.projects.filter((p) => p.harness === harness);
    return matches.length === 1 && harness !== catalog.defaultHarness ? matches[0]!.id : null;
  });
  const host = new Host({ kernel, sources });
  const dispatch = new DispatchStore(directory);
  const observers = new TaskObservers(kernel.factSnapshot());
  const processNextDispatch = () =>
    processDispatch(
      dispatch,
      kernel,
      catalog,
      bot,
      AbortSignal.any([signal, lifetime.signal]),
      options.boundProject ?? (() => null),
      hooks,
      options.ownerActionLimit,
    );
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
    async plan() {
      const owner = await processNextDispatch();
      if (owner) {
        refresh();
        scheduler.wake();
      }
      if (signal.aborted || lifetime.signal.aborted) return false;
      const passive = await kernel.routeNext();
      return owner || passive !== null;
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
  return {
    kernel,
    host,
    dispatch,
    hooks,
    processNextDispatch,
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
      scheduler.wake();
      return task(job.id);
    },
    task,
    on: observers.on.bind(observers),
    answer(input: Parameters<Kernel['answer']>[0]) {
      kernel.answer(input);
      scheduler.wake();
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
}
