import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LarkOwnerSink } from '../src/live/lark-sink.ts';
import { WorkId, type Notice } from '../src/domain.ts';

test('owner sink persists the remote receipt across restart and refuses other recipients', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lark-sink-'));
  const executable = join(dir, 'lark');
  const calls = join(dir, 'calls.jsonl');
  writeFileSync(executable, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nlet text = ''; for await (const chunk of process.stdin) text += chunk;\nappendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), text }) + '\\n');\nprocess.stdout.write(JSON.stringify({ok:true,data:{message_id:'remote-message-1'}}));\n`, { mode: 0o700 });
  const notice: Notice = { id: 'notice-1', workId: WorkId.parse('work-1'), recipient: 'ou_owner', body: { kind: 'ready', summary: 'A real review draft', evidence: ['file:///draft.md'] } };
  try {
    const options = { owner: 'ou_owner', path: join(dir, 'deliveries.sqlite'), executable };
    const first = new LarkOwnerSink(options);
    try { assert.equal(await first.deliver(notice), 'remote-message-1'); } finally { first.close(); }
    const second = new LarkOwnerSink(options);
    try {
      assert.equal(await second.deliver(notice), 'remote-message-1');
      await assert.rejects(second.deliver({ ...notice, id: 'notice-2', recipient: 'ou_other' }));
    } finally { second.close(); }
    const records = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.ok(records[0].args.includes('ou_owner'));
    assert.ok(records[0].args.includes('--idempotency-key'));
    assert.match(records[0].text, /A real review draft/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
