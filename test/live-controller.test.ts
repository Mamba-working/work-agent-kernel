import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runController } from '../src/live/controller.ts';

test('controller finishes the current tick and stops without overlapping or starting another tick', async () => {
  const abort = new AbortController();
  let completeTick: (() => void) | undefined;
  let enteredTick: (() => void) | undefined;
  const entered = new Promise<void>(resolve => { enteredTick = resolve; });
  let calls = 0;
  const observations: unknown[] = [];
  const running = runController({
    host: { tick: async () => {
      calls++;
      enteredTick?.();
      await new Promise<void>(resolve => { completeTick = resolve; });
      return [{ operation: 'route', error: 'ProviderUnavailable' }];
    } },
    signal: abort.signal, intervalMs: 60_000, onTick: errors => observations.push(errors),
  });
  await entered;
  abort.abort(); completeTick?.();
  await running;
  assert.equal(calls, 1);
  assert.deepEqual(observations, [[{ operation: 'route', error: 'ProviderUnavailable' }]]);
});
