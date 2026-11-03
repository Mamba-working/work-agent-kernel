import { setTimeout as delay } from 'node:timers/promises';
import type { Host, HostError } from '../host.ts';

export async function runController(options: {
  host: Pick<Host, 'tick'>;
  signal: AbortSignal;
  intervalMs: number;
  onTick: (errors: HostError[]) => void;
}): Promise<void> {
  while (!options.signal.aborted) {
    options.onTick(await options.host.tick());
    try { await delay(options.intervalMs, undefined, { signal: options.signal }); }
    catch (error) { if (!options.signal.aborted) throw error; }
  }
}
