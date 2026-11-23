import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { StateSchema } from '../src/core/domain.ts';

test('产品入口跨进程全流程：入库、派单、完成、重启后追加到原 Desktop session', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'portable-router-'));
  const executable = fileURLToPath(new URL('./fixtures/desktop-runner.mjs', import.meta.url));
  const script = fileURLToPath(new URL('../src/router/cli.ts', import.meta.url));
  const catalog = join(dir, 'projects.json');
  writeFileSync(catalog, JSON.stringify({ alpha: { name: 'Alpha', cwd: dir, feishuChatId: 'G' } }));
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    ROUTER_INBOX_DIR: dir,
    CODEX_BIN: executable,
    ROUTER_PROJECTS_FILE: catalog,
  };
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [index, content] of ['准备发布清单', '原清单增加检查项'].entries()) {
    const sent = spawnSync(process.execPath, [script, 'ingest'], {
      env,
      input: JSON.stringify({ message_id: String(index), chat_id: 'G', content }),
      encoding: 'utf8',
    });
    assert.equal(sent.status, 0, sent.stderr);
    const child = spawn(process.execPath, [script, 'serve'], { env, stdio: 'ignore' });
    const closed = once(child, 'close');
    try {
      const deadline = Date.now() + 20000;
      while (true) {
        let completed = false;
        try {
          const db = new DatabaseSync(join(dir, 'kernel.sqlite'), { readOnly: true, timeout: 2000 });
          try {
            const row = db.prepare('select body from state').get();
            const state = StateSchema.parse(JSON.parse(String(row?.body)));
            completed = Object.values(state.works).some(
              (w) => w.execution.kind === 'ready' && w.results.length === index + 1,
            );
          } finally {
            db.close();
          }
        } catch (error) {
          if (!(error instanceof Error) || !/(open database|no such table)/.test(error.message)) throw error;
        }
        if (completed) break;
        assert.equal(child.exitCode, null);
        assert(Date.now() < deadline, 'worker completion timed out');
        await sleep(100);
      }
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  }
  const history = JSON.parse(readFileSync(join(dir, 'fixture-history.json'), 'utf8'));
  assert.equal(Object.keys(history).length, 1);
  const turns = history['fixture-session-0'].turns;
  assert.equal(turns.length, 2);
  assert.match(turns[1].items[0].content[0].text, /原清单增加检查项/);
  assert.doesNotMatch(turns[1].items[0].content[0].text, /"goal"|"raw"/);
  assert.equal(turns[1].items[1].text, '可继续追问的模拟结果');
});
