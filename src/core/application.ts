import { Lifecycle } from './hooks/lifecycle.ts';
import type { LifecycleHook } from './hooks/lifecycle.ts';
import { join } from 'node:path';
import { Kernel } from './kernel.ts';
import { Host } from './host.ts';
import type { Harness, NotificationSink, Source } from './ports.ts';
import { RouterBot } from './planning/router.ts';
import { contextualRouter } from './planning/incoming.ts';
import type { EventContextAdapter } from './planning/incoming.ts';
import type { Catalog, ContextReader, PlanningRuntime } from './planning/contracts.ts';
import { incomingPlanner } from './planning/requests.ts';
import { DispatchStore } from './dispatch/store.ts';
import { processDispatch } from './dispatch/process.ts';

export interface ApplicationOptions {
  directory: string;
  catalog: Catalog;
  runtime: PlanningRuntime;
  hooks?: LifecycleHook[];
  ingress?: { source: Source; context?: EventContextAdapter; hooks: LifecycleHook[] }[];
  reader?: ContextReader;
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
  for (const name of [catalog.defaultHarness, ...catalog.projects.map((p) => p.harness)]) {
    if (!Object.hasOwn(options.harnesses, name)) throw Error('Harness not registered: ' + name);
  }
  const bot = new RouterBot(options.runtime, options.reader);
  const ingress = options.ingress ?? [];
  const sources = [...(options.sources ?? []), ...ingress.map((i) => i.source)];
  if (new Set(sources.map((s) => s.name)).size !== sources.length) throw Error('Duplicate source name');
  const contexts = { ...options.eventContexts };
  for (const entry of ingress) if (entry.context) contexts[entry.source.name] = entry.context;
  const hooks = new Lifecycle(join(directory, 'hooks.sqlite'), [
    ...ingress.flatMap((i) => i.hooks),
    ...(options.hooks ?? []),
  ]);
  const kernel = new Kernel({
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
  hooks.start(signal);
  return {
    kernel,
    host,
    dispatch,
    hooks,
    processNextDispatch: () =>
      processDispatch(dispatch, kernel, catalog, bot, signal, options.boundProject ?? (() => null), hooks),
    close() {
      dispatch.close();
      kernel.close();
      return hooks.close();
    },
  };
}
