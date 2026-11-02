import { EchoHarness, ManualSource, MemorySink, ScriptedRouter } from '../src/adapters.ts';
import type { Plugins } from '../src/ports.ts';

export function createPlugins(): Plugins {
  return {
    apiVersion: 1,
    sources: [new ManualSource('custom', [{ source: 'custom', externalId: '1', revision: '1', thread: 'topic', actor: 'owner', text: 'Prepare a brief', uri: 'example://request/1' }])],
    router: new ScriptedRouter([{ kind: 'create', reason: 'Owner request', goal: 'Prepare a brief', harness: 'echo' }]),
    harnesses: { echo: new EchoHarness() }, sinks: { inbox: new MemorySink() },
  };
}
