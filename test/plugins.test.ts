import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EchoHarness, ManualSource, MemorySink, ScriptedRouter } from '../src/adapters.ts';
import { Host, loadPlugins, validatePlugins } from '../src/host.ts';
import { createDecision, event, setup } from './support.ts';

test('external ESM plugin supplies all four ports without editing kernel', async t => {
  const f = setup(t); const file = join(f.directory, 'plugin.mjs');
  writeFileSync(file, `import { EchoHarness, ManualSource, MemorySink, ScriptedRouter } from ${JSON.stringify(new URL('../src/adapters.ts', import.meta.url).href)};
export function createPlugins() { return { apiVersion: 1, sources: [new ManualSource('manual', [${JSON.stringify(event())}])], router: new ScriptedRouter([${JSON.stringify(createDecision({ harness: 'echo' }))}]), harnesses: { echo: new EchoHarness() }, sinks: { inbox: new MemorySink() } }; }`);
  const plugins = await loadPlugins(file); const k = f.open(plugins); const host = new Host({ kernel: k, sources: plugins.sources });
  assert.deepEqual(await host.tick(), []); assert.deepEqual(await host.tick(), []);
  assert.equal(k.works()[0]?.execution.kind, 'ready'); assert.equal(k.notices()[0]?.state.kind, 'delivered');
});
test('broken source is isolated; active execution count respects host limit', async t => {
  const f = setup(t); const router = new ScriptedRouter([createDecision(), createDecision()]); const k = f.open({ router });
  const host = new Host({ kernel: k, maxRunning: 1, sources: [
    { name: 'offline', async fetch() { throw new Error('Offline'); } },
    new ManualSource('manual', [event({ thread: 'a' }), event({ externalId: 'm2', thread: 'b' })]),
  ] });
  const errors = await host.tick(); assert.equal(errors[0]?.operation, 'collect:offline');
  assert.deepEqual(k.works().map(work => work.execution.kind), ['running', 'queued']);
});
test('plugin versions and duplicate cursor owners are rejected', () => {
  const base = { apiVersion: 1, sources: [], router: new ScriptedRouter([]), harnesses: { echo: new EchoHarness() }, sinks: { inbox: new MemorySink() } };
  assert.throws(() => validatePlugins({ ...base, apiVersion: 2 }));
  assert.throws(() => validatePlugins({ ...base, sources: [new ManualSource('same', []), new ManualSource('same', [])] }), /Duplicate/);
});
