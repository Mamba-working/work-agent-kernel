import type { Host, HostError } from './host.ts';
import type { Lifecycle } from './hooks/lifecycle.ts';
import type { Wakeable } from './ports.ts';
import { watchApplication } from './wakeup.ts';

interface Driver {
  directory: string;
  host: Host;
  hooks: Lifecycle;
  adapters: () => Iterable<Wakeable>;
  plan: () => Promise<boolean>;
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
  private cycle: Promise<unknown> | undefined;
  private planning: Promise<void> | undefined;
  private delivery: Promise<void> | undefined;
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
    for (const adapter of this.driver.adapters()) {
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
        const deadline = this.delivery ? Infinity : this.driver.hooks.nextEffectDelay();
        this.timer = setTimeout(this.wake, Math.min(deadline, this.driver.interval()));
      });
  };
  private async pass(manual: boolean) {
    if (!manual) this.syncAdapters();
    const errors = await this.driver.host.tick({
      route: false,
      ...(manual ? {} : { onReceipt: this.wake }),
      onSettled: this.driver.refresh,
    });
    if (manual) {
      await this.driver.plan();
      await this.driver.hooks.deliverNext();
      this.driver.refresh();
      this.driver.onCycle?.(errors);
      return errors;
    }
    if (!this.running) return errors;
    if (!this.planning) {
      this.planning = this.driver
        .plan()
        .then((progress) => {
          if (progress) this.wake();
        })
        .catch((e) => this.error('planning', e))
        .finally(() => {
          this.planning = undefined;
          this.driver.refresh();
        });
    }
    if (!this.delivery) {
      this.delivery = this.driver.hooks
        .deliverNext()
        .then((progress) => {
          if (progress) this.wake();
        })
        .catch((e) => this.error('hook delivery', e))
        .finally(() => {
          this.delivery = undefined;
        });
    }
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
    this.stopping = Promise.allSettled([this.cycle, this.planning, this.delivery]).then(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
}
