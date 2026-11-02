import { join } from 'node:path';
import { SqliteInbox } from '../../src/adapters.ts';
import type { Plugins } from '../../src/ports.ts';
import { FileEventSource } from '../file-replay/source.ts';
import { DurableDemoHarness } from '../local-decision/harness.ts';
import { fixtureRouter } from '../local-decision/plugin.ts';

export function createPlugins(): Plugins {
  const directory = process.env.WORK_AGENT_DEMO_DIRECTORY;
  if (!directory) throw new Error('Set WORK_AGENT_DEMO_DIRECTORY for the offline example');
  return {
    apiVersion: 1,
    sources: [new FileEventSource({ name: 'synthetic-chat', path: join(directory, 'events.jsonl') })],
    router: fixtureRouter,
    harnesses: { offline: new DurableDemoHarness({ directory }) },
    sinks: { inbox: new SqliteInbox(join(directory, 'inbox.sqlite')) },
  };
}
