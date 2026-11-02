import { join } from 'node:path';
import { EchoHarness, MemorySink } from '../../src/adapters.ts';
import { eventKey } from '../../src/domain.ts';
import type { Plugins } from '../../src/ports.ts';
import { replayFixture } from './fixture.ts';
import { FileEventSource } from './source.ts';

export function createPlugins(): Plugins {
  const directory = process.env.WORK_AGENT_DEMO_DIRECTORY;
  if (!directory) throw new Error('Set WORK_AGENT_DEMO_DIRECTORY to the file replay directory');
  return {
    apiVersion: 1,
    sources: [new FileEventSource({ name: 'synthetic-chat', path: join(directory, 'events.jsonl') })],
    router: {
      async decide(context) {
        if (context.event.key !== eventKey(replayFixture.initial)) throw new Error(`No scripted route for ${context.event.key}`);
        return { kind: 'create', reason: 'Scripted file replay fixture', goal: 'Check loading state', harness: 'echo' };
      },
    },
    harnesses: { echo: new EchoHarness() },
    sinks: { inbox: new MemorySink() },
  };
}
