// An external worker's durable receipts survive termination of the Router process.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createRouterApplication } from '../../src/core/application.ts';

const [directory, mode, jobId] = process.argv.slice(2);
const provider = new DatabaseSync(join(directory!, 'provider.sqlite'));
provider.exec(
  'CREATE TABLE IF NOT EXISTS accepted(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS calls(method TEXT)',
);
const count = (method: string) => provider.prepare('INSERT INTO calls VALUES (?)').run(method);
const receipt = (id: string) => ({ runId: id, sessionId: 'durable-session' });
const app = createRouterApplication({
  directory: directory!,
  catalog: { defaultHarness: 'fixture', projects: [] },
  signal: new AbortController().signal,
  runtime: async () => {
    count('plan');
    return {
      actions: [{ goal: 'sample', workId: null, project: null, evidence: [] }],
      answer: 'approved',
      evidence: [],
    };
  },
  sinks: {
    inbox: {
      async deliver() {
        return 'ack';
      },
    },
  },
  harnesses: {
    fixture: {
      async submit(request) {
        count('submit');
        provider.prepare('INSERT INTO accepted VALUES (?)').run(request.requestId);
        if (mode === 'crash') process.kill(process.pid, 'SIGKILL');
        return receipt(request.requestId);
      },
      async lookup(id) {
        count('lookup');
        return provider.prepare('SELECT id FROM accepted WHERE id=?').get(id) ? receipt(id) : null;
      },
      async poll() {
        return { kind: 'ready', summary: 'recovered', evidence: ['fixture://result'] };
      },
    },
  },
  scheduling: {
    reconcileMs: 60000,
    onCycle() {
      if (!announced) {
        announced = true;
        process.send?.('idle');
      }
    },
  },
});
let announced = false;
app.start();
if (mode === 'recover') {
  const task = app.task(jobId!);
  const result = await task.done;
  const calls = provider
    .prepare('SELECT method FROM calls ORDER BY rowid')
    .all()
    .map((r) => r.method);
  await app.close();
  provider.close();
  process.send?.({ calls, result });
  process.disconnect?.();
}
