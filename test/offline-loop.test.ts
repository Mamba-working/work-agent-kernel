import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOfflineLoop } from '../examples/offline-loop/demo.ts';

test('file input received while waiting survives CLI restarts and reaches the continued session', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-offline-loop-'));
  try {
    const result = runOfflineLoop(directory);
    assert.equal(result.waiting.works.length, 1);
    assert.equal(result.waiting.works[0]?.execution.kind, 'waiting_input');
    assert.equal(result.whileWaiting.works[0]?.execution.kind, 'waiting_input');
    assert.equal(result.whileWaiting.works[0]?.pendingInputs.length, 2);
    assert.deepEqual(result.answered.attentions[0]?.state, { kind: 'resolved', choice: 'Loading only', actor: 'owner' });
    assert.equal(result.final.works[0]?.execution.kind, 'ready');
    assert.equal(result.final.works[0]?.sessionId, result.waiting.works[0]?.sessionId);
    assert.equal(result.final.works[0]?.inputs.length, 3);
    assert.match(result.artifact, /Loading only/);
    assert.match(result.artifact, /original loading requirement/);
    assert.match(result.artifact, /revised mobile requirement/);
    assert.match(result.artifact, /keep the existing image while loading/);
    assert(result.final.notices.some(row => row.notice.body.kind === 'ready' && row.state.kind === 'delivered'));
    assert.deepEqual(result.replayed, result.final);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
