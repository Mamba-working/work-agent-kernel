import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RouterInbox } from '../src/adapters/feishu/inbox.ts';

function fixture(t: import('node:test').TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'router-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = (text: string) =>
    spawnSync(process.execPath, ['src/router/cli.ts', 'ingest'], {
      cwd: new URL('../', import.meta.url),
      input: text,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: dir, ROUTER_INBOX_DIR: dir },
    });
  return { dir, input };
}
test('纯净 HOME 中通过标准入口接收业务 JSON，不安装宿主也能入库', async (t) => {
  const f = fixture(t),
    message = JSON.stringify({ message_id: 'integration', sender: 'tester', content: 'hello' });
  const first = f.input(message),
    second = f.input(message);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(first.stdout).eventId, JSON.parse(second.stdout).eventId);
  const reopened = new RouterInbox(join(f.dir, 'feishu.sqlite'));
  try {
    assert.equal((await reopened.fetch()).events.length, 1);
  } finally {
    reopened.close();
  }
});
test('标准入口拒绝供应商专用 envelope', (t) => {
  const f = fixture(t);
  assert.notEqual(f.input('<event>external wire format</event>').status, 0);
});
