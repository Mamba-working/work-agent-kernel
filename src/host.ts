import { z } from 'zod';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkflowSchema } from './domain.ts';
import { Kernel } from './kernel.ts';
import type { Harness, NotificationSink, Plugins, Router, Source } from './ports.ts';

function hasMethods(value: unknown, names: string[]): boolean {
  return typeof value === 'object' && value !== null && names.every(name => typeof Reflect.get(value, name) === 'function');
}
const pluginSchema = z.strictObject({
  apiVersion: z.literal(1),
  sources: z.array(z.custom<Source>(value => typeof value === 'object' && value !== null && hasMethods(value, ['fetch']) && typeof Reflect.get(value, 'name') === 'string' && Reflect.get(value, 'name').length > 0)),
  router: z.custom<Router>(value => hasMethods(value, ['decide'])),
  harnesses: z.record(z.string().min(1), z.custom<Harness>(value => hasMethods(value, ['submit', 'lookup', 'poll']))),
  sinks: z.record(z.string().min(1), z.custom<NotificationSink>(value => hasMethods(value, ['deliver']))),
  workflows: z.array(WorkflowSchema).default([]),
});
export function validatePlugins(raw: unknown): Plugins {
  const plugins = pluginSchema.parse(raw);
  if (new Set(plugins.sources.map(source => source.name)).size !== plugins.sources.length) throw new Error('Duplicate source name');
  return plugins;
}
export async function loadPlugins(file: string): Promise<Plugins> {
  // The explicit local path is trusted code. No network installation or discovery.
  const module: unknown = await import(pathToFileURL(resolve(file)).href);
  if (typeof module !== 'object' || module === null || !('createPlugins' in module) || typeof module.createPlugins !== 'function') throw new Error('Plugin must export createPlugins()');
  const raw: unknown = await module.createPlugins();
  return validatePlugins(raw);
}
export interface HostError { operation: string; error: string }
export class Host {
  readonly #kernel: Kernel;
  readonly #sources: Source[];
  readonly #maxRunning: number;
  readonly #routeBudget: number;
  #ticking = false;
  constructor(options: { kernel: Kernel; sources?: Source[]; maxRunning?: number; routeBudget?: number }) {
    this.#kernel = options.kernel; this.#sources = options.sources ?? [];
    this.#maxRunning = options.maxRunning ?? 2; this.#routeBudget = options.routeBudget ?? 20;
    if (this.#maxRunning < 1 || this.#routeBudget < 1) throw new Error('Budgets must be positive');
  }
  async tick(): Promise<HostError[]> {
    if (this.#ticking) throw new Error('Host tick already in progress');
    this.#ticking = true;
    try {
      const errors: HostError[] = [];
      const attempt = async <T>(operation: string, action: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
        try { return { ok: true, value: await action() }; }
        catch (error) { errors.push({ operation, error: error instanceof Error ? error.name : 'UnknownError' }); return { ok: false }; }
      };
      for (const source of this.#sources) await attempt(`collect:${source.name}`, () => this.#kernel.collect(source));
      for (const work of this.#kernel.works()) {
        if (work.execution.kind !== 'running' && work.execution.kind !== 'uncertain') continue;
        const run = this.#kernel.run(work.execution.runId);
        await attempt(`observe:${run.id}`, () => run.state.kind === 'uncertain' || run.state.kind === 'dispatching' ? this.#kernel.reconcile(run.id) : this.#kernel.poll(run.id));
      }
      for (let index = 0; index < this.#routeBudget; index++) {
        const result = await attempt('route', () => this.#kernel.routeNext());
        if (!result.ok || result.value === null) break;
      }
      let active = this.#kernel.works().filter(work => work.execution.kind === 'running' || work.execution.kind === 'uncertain').length;
      for (const work of this.#kernel.works()) {
        if (active >= this.#maxRunning) break;
        if (work.execution.kind !== 'queued') continue;
        const result = await attempt(`dispatch:${work.id}`, () => this.#kernel.dispatch(work.id));
        if (result.ok && result.value) active++;
      }
      for (const outbox of this.#kernel.notices()) {
        if (outbox.state.kind !== 'pending') continue;
        const result = await attempt(`deliver:${outbox.notice.id}`, () => this.#kernel.deliver(outbox.notice.id));
        if (result.ok && !result.value) errors.push({ operation: `deliver:${outbox.notice.id}`, error: 'DeliveryUnacknowledged' });
      }
      return errors;
    } finally { this.#ticking = false; }
  }
}
