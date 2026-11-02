import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../src/kernel.ts';

const first = { source: 'personal-im', externalId: 'm1', revision: '1', thread: 'topic', actor: 'colleague', text: 'Check loading state', uri: 'example://m1' };
test('deduplication survives restart, while revisions and followups remain separate', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-test-'));
  try {
    const path = join(directory, 'state.sqlite');
    const a = new Kernel({ path });
    const id = a.ingest(first);
    a.close();
    const b = new Kernel({ path });
    try {
      assert.equal(b.ingest(first), id);
      b.ingest({ ...first, revision: '2', text: 'Updated requirement' });
      b.ingest({ ...first, externalId: 'm2', text: 'Another message' });
      assert.equal(b.events().length, 3);
      assert.equal(b.event(id).event.text, first.text);
      assert.throws(() => b.ingest({ ...first, text: 'Different content without revision' }), /Conflicting/);
    } finally { b.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
