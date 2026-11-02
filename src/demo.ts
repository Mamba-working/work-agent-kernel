import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EchoHarness, ManualSource, RecordingHarness, ScriptedRouter, SqliteInbox } from './adapters.ts';
import { Kernel } from './kernel.ts';
import type { Run } from './domain.ts';

function requireRunning(run: Run | null) {
  if (!run || run.state.kind !== 'running') throw new Error('Demo expected admitted execution');
  return { id: run.id, receipt: run.state.receipt };
}
/** Synthetic scenario; the simulated provider survives only the kernel restart. */
export async function runDemo(directory: string) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'state.sqlite');
  if (existsSync(path)) throw new Error('Demo requires a fresh directory; existing state is never overwritten');
  const harness = new RecordingHarness('simulated-codex');
  const inbox = new SqliteInbox(join(directory, 'inbox.sqlite'));
  const router = new ScriptedRouter([{ kind: 'create', reason: 'New request', goal: 'Assess card loading states', harness: 'recording' }]);
  const firstEvent = { source: 'synthetic-chat', externalId: 'm1', revision: '1', thread: 'topic-7', actor: 'colleague', text: 'Can the comparison card support loading states?', uri: 'example://chat/m1' };
  const options = { path, router, harnesses: { recording: harness, echo: new EchoHarness() }, sinks: { inbox } };
  const initial = new Kernel(options);
  try {
    await initial.collect(new ManualSource('synthetic-chat', [firstEvent]));
    const targets = await initial.routeNext(); const workId = targets?.[0];
    if (!workId) throw new Error('Demo expected work item');
    const first = requireRunning(await initial.dispatch(workId));
    initial.ingest({ ...firstEvent, externalId: 'm2', text: 'Please focus on mobile' }); await initial.routeNext();
    harness.complete(first.receipt.runId, { kind: 'needs_input', summary: 'Need scope choice', question: 'Include failure state?', options: ['Loading only', 'Both'] });
    await initial.poll(first.id);
    const attention = initial.attentions()[0]; if (!attention) throw new Error('Demo expected attention');
    await initial.deliver(attention.id);
    initial.close();
    const restored = new Kernel(options);
    try {
      restored.ingest(firstEvent);
      restored.answer({ attentionId: attention.id, choice: 'Loading only', actor: 'owner' });
      router.decisions.push({ kind: 'attach', reason: 'Design comment relates to same task', workId });
      restored.ingest({ ...firstEvent, source: 'synthetic-document', externalId: 'c1', thread: 'comment-3', text: 'Use the updated loading illustration', uri: 'example://doc/comment-3' });
      await restored.routeNext();
      const second = requireRunning(await restored.dispatch(workId));
      harness.complete(second.receipt.runId, { kind: 'ready', summary: 'Reply draft prepared; no external message sent', evidence: ['example://artifact/reply-draft'] });
      await restored.poll(second.id);
      restored.rebind(workId, 'echo');
      const alternative = requireRunning(await restored.dispatch(workId)); await restored.poll(alternative.id);
      for (const row of restored.notices()) await restored.deliver(row.notice.id);
      return {
        mode: 'offline architecture prototype', workItems: restored.works().length, events: restored.events().length,
        sameSessionAfterAnswer: first.receipt.sessionId === second.receipt.sessionId,
        harnessAfterRebind: restored.work(workId).harness, finalStatus: restored.work(workId).execution.kind,
        allNoticesDelivered: restored.notices().every(row => row.state.kind === 'delivered'), database: path,
      };
    } finally { restored.close(); }
  } finally { initial.close(); inbox.close(); }
}
