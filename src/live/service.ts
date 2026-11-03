import { mkdirSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Kernel } from '../kernel.ts';
import { Host } from '../host.ts';
import { FileEventSource } from '../../examples/file-replay/source.ts';
import { liveConfig } from './config.ts';
import { ResponsesRouter } from './responses-router.ts';
import { CodexHarness } from './codex-harness.ts';
import { LarkOwnerSink } from './lark-sink.ts';
import { runController } from './controller.ts';

export async function serve(signal: AbortSignal): Promise<void> {
  const config = liveConfig();
  mkdirSync(join(config.directory, 'workspace'), { recursive: true, mode: 0o700 });
  const input = join(config.directory, 'events.jsonl');
  if (!existsSync(input)) writeFileSync(input, '', { mode: 0o600 });
  const harness = new CodexHarness({
    executable: config.codexExecutable, directory: join(config.directory, 'codex'),
    cwd: join(config.directory, 'workspace'), baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model,
  });
  const sink = new LarkOwnerSink({ owner: config.owner, path: join(config.directory, 'deliveries.sqlite'), executable: config.larkExecutable });
  const kernel = new Kernel({
    path: join(config.directory, 'kernel.sqlite'),
    router: new ResponsesRouter({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model }),
    harnesses: { codex: harness }, sinks: { inbox: sink }, owner: config.owner,
  });
  const host = new Host({ kernel, sources: [new FileEventSource({ name: 'owner', path: input })], maxRunning: 1 });
  let ticks = 0;
  let lastState = '';
  try {
    await runController({ host, signal, intervalMs: config.intervalMs, onTick: errors => {
      ticks++;
      const works = kernel.works().map(work => ({ id: work.id, state: work.execution.kind, sessionId: work.sessionId }));
      const health = { pid: process.pid, tick: ticks, lastTickAt: new Date().toISOString(), errors, works };
      const temporary = join(config.directory, 'health.tmp');
      writeFileSync(temporary, JSON.stringify(health, null, 2), { mode: 0o600 });
      renameSync(temporary, join(config.directory, 'health.json'));
      const state = { errors, works, delivered: kernel.notices().filter(entry => entry.state.kind === 'delivered').length };
      const serialized = JSON.stringify(state);
      if (serialized !== lastState) { process.stdout.write(JSON.stringify({ at: health.lastTickAt, ...state }) + '\n'); lastState = serialized; }
    } });
  } finally { await harness.close(); sink.close(); kernel.close(); }
}
