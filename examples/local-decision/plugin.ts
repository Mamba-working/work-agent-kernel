import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ManualSource, SqliteInbox } from '../../src/adapters.ts';
import { EventSchema, eventKey } from '../../src/domain.ts';
import type { Plugins, Router } from '../../src/ports.ts';
import { DurableDemoHarness } from './harness.ts';

export const initialEvent = EventSchema.parse({
  source: 'synthetic-chat', externalId: 'm1', revision: '1', thread: 'topic-7', actor: 'colleague',
  text: 'Can the comparison card support loading states?', uri: 'example://chat/m1',
});

export const fixtureRouter: Router = {
  async decide(context) {
    if (context.event.key !== eventKey(initialEvent)) throw new Error(`No scripted route for ${context.event.key}`);
    return { kind: 'create', reason: 'Scripted initial demo event', goal: 'Assess card loading states', harness: 'offline', workflow: 'general', scope: 'prepare' };
  },
};

export function createPlugins(): Plugins {
  const configuredDirectory = process.env.WORK_AGENT_DEMO_DIRECTORY;
  if (!configuredDirectory) throw new Error('Set WORK_AGENT_DEMO_DIRECTORY to the local demo directory');
  const directory = resolve(configuredDirectory);
  mkdirSync(directory, { recursive: true });
  return {
    apiVersion: 1,
    sources: [new ManualSource(initialEvent.source, [initialEvent])],
    router: fixtureRouter,
    harnesses: { offline: new DurableDemoHarness({ directory }) },
    sinks: { inbox: new SqliteInbox(resolve(directory, 'inbox.sqlite')) },
  };
}
