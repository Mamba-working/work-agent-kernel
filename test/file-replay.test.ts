import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileEventSource } from '../examples/file-replay/source.ts';
import { ScriptedRouter } from '../src/adapters.ts';
import { EventSchema, eventKey } from '../src/domain.ts';
import { Kernel } from '../src/kernel.ts';

const initial = EventSchema.parse({
  source: 'synthetic-chat', externalId: 'm1', revision: '1', thread: 'topic-7',
  actor: 'colleague', text: 'Check loading state', uri: 'example://synthetic-chat/m1/1',
});
const revision = EventSchema.parse({ ...initial, revision: '2', text: 'Check loading and failure states', uri: 'example://synthetic-chat/m1/2' });
const followup = EventSchema.parse({ ...initial, externalId: 'm2', text: 'Keep the existing retry action', uri: 'example://synthetic-chat/m2/1' });
const jsonl = (...events: unknown[]) => events.map(event => JSON.stringify(event)).join('\n') + '\n';

test('file replay retains revisions and followups after reopen without duplicate work inputs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-file-replay-'));
  const path = join(directory, 'events.jsonl');
  const database = join(directory, 'state.sqlite');
  try {
    writeFileSync(path, jsonl(initial));
    const first = new Kernel({ path: database, router: new ScriptedRouter([
      { kind: 'create', reason: 'Scripted fixture request', goal: 'Check loading state', harness: 'echo' },
    ]) });
    let workId;
    try {
      assert.equal(await first.collect(new FileEventSource({ name: 'synthetic-chat', path })), 1);
      const routed = await first.routeNext();
      assert(routed?.[0]);
      workId = routed[0];
      assert.equal(first.cursor('synthetic-chat'), '1');
    } finally { first.close(); }

    appendFileSync(path, jsonl(initial, revision, followup));
    const reopened = new Kernel({ path: database });
    try {
      const source = new FileEventSource({ name: 'synthetic-chat', path });
      assert.equal(await reopened.collect(source), 2);
      assert.deepEqual(await reopened.routeNext(), [workId]);
      assert.deepEqual(await reopened.routeNext(), [workId]);
      assert.equal(await reopened.routeNext(), null);
      assert.deepEqual(reopened.events().map(record => record.event), [initial, revision, followup]);
      assert.deepEqual(reopened.work(workId).inputs, [eventKey(initial), eventKey(revision), eventKey(followup)]);
      assert.equal(reopened.cursor('synthetic-chat'), '4');

      assert.equal(await reopened.collect(source), 0);
      assert.equal(await reopened.routeNext(), null);
      assert.equal(reopened.events().length, 3);
      assert.equal(reopened.work(workId).inputs.length, 3);
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a malformed unread batch leaves events and checkpoint unchanged until the tail is repaired', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-file-batch-'));
  const path = join(directory, 'events.jsonl');
  const kernel = new Kernel({ path: join(directory, 'state.sqlite') });
  try {
    const source = new FileEventSource({ name: 'synthetic-chat', path });
    writeFileSync(path, jsonl(initial));
    assert.equal(await kernel.collect(source), 1);

    appendFileSync(path, jsonl(revision) + '{"source":\n');
    await assert.rejects(kernel.collect(source));
    assert.equal(kernel.cursor('synthetic-chat'), '1');
    assert.deepEqual(kernel.events().map(record => record.event), [initial]);

    writeFileSync(path, jsonl(initial, revision, followup));
    assert.equal(await kernel.collect(source), 2);
    assert.equal(kernel.cursor('synthetic-chat'), '3');
    assert.deepEqual(kernel.events().map(record => record.event), [initial, revision, followup]);
  } finally { kernel.close(); rmSync(directory, { recursive: true, force: true }); }
});
