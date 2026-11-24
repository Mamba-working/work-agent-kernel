import {settle,type Prepared} from '../stage.ts';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Event, Notice } from '../domain.ts';

export type HookInput =
  | { phase: 'beforeRoute'; kind: 'event'; id: string; event: Event }
  | {
      phase: 'beforeRoute';
      kind: 'owner';
      id: string;
      description: string;
      sources: readonly { id: string; name: string }[];
    }
  | { phase: 'beforeNotify'; kind: 'result'; id: string; notice: Notice };
export type HookFacts = Record<string, z.core.util.JSONType>;
const proceed = z.strictObject({ kind: z.literal('continue'), context: z.json().optional() });
const halt = z.strictObject({ kind: z.literal('break'), reason: z.string().min(1) });
const resolution = z.discriminatedUnion('kind', [proceed, halt]);
const decision = z.discriminatedUnion('kind', [
  proceed.extend({ effect: z.json().optional() }),
  halt.extend({ effect: z.json().optional() }),
  z.strictObject({
    kind: z.literal('wait'),
    reason: z.string().min(1),
    data: z.json().optional(),
    effect: z.json().optional(),
  }),
]);
export type Resolution = z.infer<typeof resolution>;
export type HookDecision = z.infer<typeof decision>;
export interface HookEffect {
  id: string;
  payload: z.core.util.JSONType;
  ticket: string | null;
}
export interface LifecycleHook {
  id: string;
  phase: HookInput['phase'];
  // Local decision only. Queue external I/O with effect.
  run(input: HookInput, facts: Readonly<HookFacts>): HookDecision;
  deliver?(effect: HookEffect): Promise<void | Resolution>;
  // Optional read of an already authenticated, durable external decision.
  readResolution?(data: z.core.util.JSONType): Resolution | null;
}
type Run = {
  key: string;
  chain: string[];
  index: number;
  status: 'next' | 'ready' | 'wait' | 'break' | 'failed';
  facts: HookFacts;
  reason: string;
  ticket: string | null;
  data: z.core.util.JSONType;
};
export const hookKey = (kind: HookInput['kind'], id: string) => JSON.stringify([kind, id]);

export function factContext(facts: HookFacts) {
  return Object.entries(facts).map(([id, data]) => ({
    text: 'Hook ' + id + ' 提供的资料：' + JSON.stringify(data),
  }));
}

// Single Router service owns this store. Decisions and outgoing effects commit together.
export class Lifecycle {
  private readonly db: DatabaseSync;
  private readonly registered = new Map<string, LifecycleHook>();
  private delivering = false;
  constructor(path: string, hooks: LifecycleHook[]) {
    for (const hook of hooks) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(hook.id) || this.registered.has(hook.id))
        throw Error('Invalid or duplicate hook ID: ' + hook.id);
      this.registered.set(hook.id, hook);
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS hook_runs(key TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hook_tickets(id TEXT PRIMARY KEY,run_key TEXT NOT NULL,answer TEXT);
      CREATE TABLE IF NOT EXISTS hook_effects(id TEXT PRIMARY KEY,hook TEXT NOT NULL,payload TEXT NOT NULL,ticket TEXT,
        sent INTEGER DEFAULT 0,due INTEGER DEFAULT 0,attempts INTEGER DEFAULT 0,error TEXT);`);
  }
  private readonly listeners = new Set<() => void>();
  subscribe(wake: () => void) {
    this.listeners.add(wake);
    return () => {
      this.listeners.delete(wake);
    };
  }
  nextEffectDelay() {
    const row = this.db.prepare('SELECT min(due) AS due FROM hook_effects WHERE sent=0').get();
    return typeof row?.due === 'number' ? Math.max(0, row.due - Date.now()) : Infinity;
  }
  effectFailures() {
    return this.db
      .prepare('SELECT hook,attempts,error FROM hook_effects WHERE sent=0 AND error IS NOT NULL')
      .all();
  }
  close() {
    this.db.close();
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  status(kind: HookInput['kind'], id: string) {
    return this.load(hookKey(kind, id));
  }
  private load(key: string): Run | null {
    const row = this.db.prepare('SELECT body FROM hook_runs WHERE key=?').get(key);
    return row ? JSON.parse(String(row.body)) : null;
  }
  private save(run: Run) {
    this.db.prepare('INSERT OR REPLACE INTO hook_runs VALUES (?,?)').run(run.key, JSON.stringify(run));
  }
  private finish(run: Run, answer: Resolution) {
    if (answer.kind === 'break') {
      run.status = 'break';
      run.reason = answer.reason;
    } else {
      if (answer.context !== undefined) run.facts = { ...run.facts, [run.chain[run.index]!]: answer.context };
      run.index++;
      run.status = run.index === run.chain.length ? 'ready' : 'next';
      run.reason = '';
    }
    run.ticket = null;
    run.data = null;
  }
  resume(ticket: string, raw: Resolution) {
    this.transaction(() => this.applyResolution(ticket, raw));
    for (const wake of this.listeners) wake();
  }
  private applyResolution(ticket: string, raw: Resolution) {
    const answer = resolution.parse(raw);
    const row = this.db.prepare('SELECT run_key,answer FROM hook_tickets WHERE id=?').get(ticket);
    if (!row) throw Error('Unknown hook ticket');
    if (row.answer !== null) {
      if (!isDeepStrictEqual(JSON.parse(String(row.answer)), answer))
        throw Error('Conflicting hook callback');
      return;
    }
    const run = this.load(String(row.run_key));
    if (!run || run.ticket !== ticket || !['wait', 'failed'].includes(run.status))
      throw Error('Hook is not waiting');
    this.finish(run, answer);
    this.db.prepare('UPDATE hook_tickets SET answer=? WHERE id=?').run(JSON.stringify(answer), ticket);
    this.save(run);
  }
  retry(kind: HookInput['kind'], id: string) {
    const run = this.status(kind, id);
    if (run?.status !== 'failed') throw Error('Hook has not failed');
    run.status = run.ticket ? 'wait' : 'next';
    run.reason = '';
    this.save(run);
    for (const wake of this.listeners) wake();
  }
  // The queue skips parked requests. Reconciliation covers callbacks received during downtime.
  runnable(kind: HookInput['kind'], id: string): boolean {
    const run = this.status(kind, id);
    if (run?.status === 'failed') return false;
    if (run?.status !== 'wait') return true;
    const hook = this.registered.get(run.chain[run.index]!);
    try {
      if (!hook) throw Error('Missing waiting hook: ' + run.chain[run.index]);
      const answer = hook.readResolution?.(run.data);
      if (!answer) return false;
      this.resume(run.ticket!, answer);
      return true;
    } catch (error) {
      run.status = 'failed';
      run.reason = error instanceof Error ? error.message : 'Hook recovery failed';
      this.save(run);
      // Let the caller project this failure once, then park the item until retry.
      return true;
    }
  }
  advance(input: HookInput): Run {
    const key = hookKey(input.kind, input.id);
    const stored = this.load(key);
    const run: Run = stored ?? {
      key,
      chain: [...this.registered.values()].filter((h) => h.phase === input.phase).map((h) => h.id),
      index: 0,
      status: 'next',
      facts: {},
      reason: '',
      ticket: null,
      data: null,
    };
    if (!run.chain.length) {
      run.status = 'ready';
      return run;
    }
    while (run.status === 'next') {
      const id = run.chain[run.index]!;
      const hook = this.registered.get(id);
      let d: HookDecision;
      try {
        if (!hook || hook.phase !== input.phase) throw Error('Missing registered hook: ' + id);
        d = decision.parse(hook.run(structuredClone(input), structuredClone(run.facts)));
        if (d.effect !== undefined && !hook.deliver) throw Error('Missing hook effect handler: ' + id);
      } catch (error) {
        run.status = 'failed';
        run.reason = error instanceof Error ? error.message : 'Hook failed';
        this.save(run);
        break;
      }
      this.transaction(() => {
        if (d.kind === 'wait') {
          run.status = 'wait';
          run.reason = d.reason;
          run.data = d.data ?? null;
          run.ticket = randomUUID();
          this.db.prepare('INSERT INTO hook_tickets(id,run_key) VALUES (?,?)').run(run.ticket, key);
        } else this.finish(run, d);
        if (d.effect !== undefined) {
          this.db
            .prepare('INSERT INTO hook_effects(id,hook,payload,ticket) VALUES (?,?,?,?)')
            .run(JSON.stringify([key, id]), id, JSON.stringify(d.effect), run.ticket);
        }
        this.save(run);
      });
    }
    return run;
  }
  async deliverNext(now = Date.now()) {
    return settle(this.prepareDelivery(now));
  }
  prepareDelivery(now = Date.now()): Prepared<boolean> {
    if (this.delivering) return false;
    const row = this.db
      .prepare('SELECT * FROM hook_effects WHERE sent=0 AND due<=? ORDER BY rowid LIMIT 1')
      .get(now);
    if (!row) return false;
    this.delivering = true;
    const fail = (error: unknown): never => {
      this.delivering = false;
      this.db
        .prepare('UPDATE hook_effects SET attempts=attempts+1,due=?,error=? WHERE id=?')
        .run(now + 30000, error instanceof Error ? error.message : 'Delivery failed', String(row.id));
      throw error;
    };
    return Promise.resolve()
      .then(() => {
        const hook = this.registered.get(String(row.hook));
        if (!hook?.deliver) throw Error('Missing effect handler: ' + row.hook);
        const ticket = row.ticket === null ? null : String(row.ticket);
        return hook.deliver({
          id: String(row.id),
          payload: JSON.parse(String(row.payload)),
          ticket,
        });
      })
      .then(
        (answer) => () => {
          const ticket = row.ticket === null ? null : String(row.ticket);
          this.delivering = false;
          try {
            this.transaction(() => {
              if (answer !== undefined) {
                if (!ticket) throw Error('Only a waiting hook can return a resolution');
                this.applyResolution(ticket, answer);
              }
              this.db
                .prepare('UPDATE hook_effects SET sent=1,attempts=attempts+1,error=NULL WHERE id=?')
                .run(String(row.id));
            });
            return true;
          } catch (error) {
            return fail(error);
          }
        },
        (error) => () => fail(error),
      );
  }
}
