import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { Kernel } from '../src/kernel.ts';
import type { KernelOptions } from '../src/kernel.ts';
import { RecordingHarness, ScriptedRouter } from '../src/adapters.ts';
import { EventSchema } from '../src/domain.ts';
import type { Event, Run, WorkId } from '../src/domain.ts';

export const event = (change: Partial<Event> = {}) => EventSchema.parse({ source: 'manual', externalId: 'm1', revision: '1', thread: 'topic', actor: 'person', text: 'Check proposal', uri: 'example://m1', ...change });
export const createDecision = (change: Record<string, unknown> = {}) => ({ kind: 'create', reason: 'New work', goal: 'Check proposal', harness: 'recording', ...change });
export function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-contract-'));
  const path = join(directory, 'state.sqlite');
  const harness = new RecordingHarness('alpha');
  const kernels: Kernel[] = [];
  t.after(() => { for (const kernel of kernels) kernel.close(); rmSync(directory, { recursive: true, force: true }); });
  const open = (options: Omit<KernelOptions, 'path'> = {}) => {
    const kernel = new Kernel({ path, harnesses: { recording: harness }, ...options });
    kernels.push(kernel);
    return kernel;
  };
  return { directory, path, harness, open };
}
export async function createWork(kernel: Kernel, change: Partial<Event> = {}, decision: Record<string, unknown> = {}): Promise<WorkId> {
  kernel.router = new ScriptedRouter([createDecision(decision)]);
  kernel.ingest(event(change));
  const result = await kernel.routeNext();
  assert(result?.[0]);
  return result[0];
}
export function running(run: Run | null) {
  assert(run && run.state.kind === 'running');
  return { ...run, receipt: run.state.receipt };
}
export const ready = { kind: 'ready', summary: 'Draft prepared', evidence: ['example://artifact/draft'] };
