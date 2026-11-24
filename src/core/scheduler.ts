import { Stage, type Prepared } from './stage.ts';
import type { Host, HostError } from './host.ts';
import type { Lifecycle } from './hooks/lifecycle.ts';
import type { Wakeable } from './ports.ts';
import { watchApplication } from './wakeup.ts';

interface Driver {
  directory: string;
  host: Host;
  hooks: Lifecycle;
  adapters: () => Iterable<Wakeable>;
  plan: () => Prepared<boolean>;
  refresh: () => void;
  interval: () => number;
  onCycle?: (errors: HostError[]) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

// Wakeups carry no state. Only one host pass, one planner and one hook delivery may be in flight.
export class ApplicationScheduler {
  private running = false;
  private dirty = false;
  private readonly commands: (() => void)[] = [];
  command<T>(apply: () => T): Promise<T> {
    if (!this.running && !this.cycle) return new Promise((resolve) => resolve(apply()));
    return new Promise<T>((resolve, reject) => {
      this.commands.push(() => {
        try {
          resolve(apply());
        } catch (error) {
          reject(error);
        }
      });
      this.wake();
    });
  }
  private applyCommands() {
    const queued=this.commands.splice(0);
    for (const run of queued) run();
    if(queued.length && this.running)this.syncAdapters();
  }

  private cycle: Promise<unknown> | undefined;
  private readonly planning = new Stage();
  private readonly delivery = new Stage();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private subscriptions = new Map<Wakeable, () => void>();
  private unwatch: (() => void) | undefined;
  private stopping: Promise<void> | undefined;
  private errors: HostError[] = [];
  private readonly driver: Driver;
  constructor(driver: Driver) {
    this.driver = driver;
  }
  private error(operation: string, error: unknown) {
    this.errors.push({ operation, error: error instanceof Error ? error.message : String(error) });
  }
  private syncAdapters() {
    const current = new Set(this.driver.adapters());
    for (const [adapter, remove] of this.subscriptions) {
      if (!current.has(adapter)) {
        remove();
        this.subscriptions.delete(adapter);
      }
    }
    for (const adapter of current) {
      if (adapter.subscribe && !this.subscriptions.has(adapter)) {
        this.subscriptions.set(adapter, adapter.subscribe(this.wake));
      }
    }
  }
  start() {
    if (this.running) return;
    if (this.cycle || this.stopping) throw Error('A step or stop is in progress');
    this.driver.signal.throwIfAborted();
    this.running = true;
    try {
      this.syncAdapters();
      this.unwatch = watchApplication(this.driver.directory, this.wake);
      this.driver.signal.addEventListener('abort', this.driver.onAbort, { once: true });
      this.wake(); // initial reconciliation after subscriptions are attached
    } catch (e) {
      void this.stop();
      throw e;
    }
  }
  wake = () => {
    if (!this.running) return;
    this.dirty = true;
    clearTimeout(this.timer);
    if (this.cycle) return;
    this.cycle = Promise.resolve()
      .then(async () => {
        while (this.running && this.dirty) {
          this.dirty = false;
          await this.pass(false);
        }
      })
      .catch((e) => this.error('scheduler', e))
      .finally(() => {
        this.cycle = undefined;
        if (!this.running) return;
        if (this.dirty) {
          this.wake();
          return;
        }
        const deadline = this.delivery.busy ? Infinity : this.driver.hooks.nextEffectDelay();
        this.timer = setTimeout(this.wake, Math.min(deadline, this.driver.interval()));
      });
  };
  private async pass(manual: boolean) {
    this.applyCommands();
    if (!manual) this.syncAdapters();
    const wake = manual ? () => {} : this.wake;
    const errors = await this.driver.host.tick({
      route: async () => {
        if (!manual && !this.running) return false;
        const progress = await this.planning.advance(this.driver.plan, manual, wake);
        if (progress) this.driver.refresh();
        return progress;
      },
      onReceipt: wake,
      onSettled: this.driver.refresh,
    });
    try {
      const progress = await this.delivery.advance(() => this.driver.hooks.prepareDelivery(), manual, wake);
      if (progress) wake();
    } catch (error) {
      this.error('hook delivery', error);
    }
    this.applyCommands();
    this.driver.refresh();
    errors.push(...this.errors.splice(0));
    this.driver.onCycle?.(errors);
    return errors;
  }
  async step() {
    if (this.running || this.cycle || this.stopping)
      throw Error('Manual step requires a stopped, idle application');
    const step = this.pass(true);
    this.cycle = step;
    try {
      return await step;
    } finally {
      this.applyCommands();
      this.cycle = undefined;
    }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.running = false;
    this.dirty = false;
    clearTimeout(this.timer);
    this.unwatch?.();
    this.unwatch = undefined;
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    this.driver.signal.removeEventListener('abort', this.driver.onAbort);
    this.stopping = Promise.resolve(this.cycle)
      .catch((error) => this.error('cycle', error))
      .finally(async () => {
        this.applyCommands();
        for (const stage of [this.planning, this.delivery]) {
          try {
            await stage.drain();
          } catch (error) {
            this.error('stop', error);
          }
        }
      })
      .then(() => {
        this.stopping = undefined;
      });
    return this.stopping;
  }
}
