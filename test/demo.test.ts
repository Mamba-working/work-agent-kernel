import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDemo } from '../src/demo.ts';

test('demo completes cross-source, human-answer, restart and harness replacement loop', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'work-agent-demo-test-'));
  try {
    const result = await runDemo(directory);
    assert.equal(result.workItems, 1); assert.equal(result.events, 3);
    assert.equal(result.sameSessionAfterAnswer, true); assert.equal(result.harnessAfterRebind, 'echo');
    assert.equal(result.finalStatus, 'ready'); assert.equal(result.allNoticesDelivered, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
