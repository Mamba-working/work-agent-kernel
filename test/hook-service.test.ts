import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { RouterInbox } from '../src/adapters/feishu/inbox.ts';

test('default service delivers wait card, accepts callback and runs optional continue notification through both CLI adapters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-service-'));
  const file = (name: string) => fileURLToPath(new URL(name, import.meta.url));
  const projects = { p: { name: 'Demo', cwd: dir } };
  const config = join(dir, 'projects.json'),
    module = join(dir, 'business.mjs');
  writeFileSync(config, JSON.stringify(projects));
  writeFileSync(
    module,
    `import {feishuResultNotice} from ${JSON.stringify(new URL('../src/adapters/feishu/hooks/result-notice.ts', import.meta.url).href)};
  export const createHooks=()=>[feishuResultNotice('ou_owner')];`,
  );
  const inbox = new RouterInbox(join(dir, 'feishu.sqlite'), projects);
  inbox.admission.enable('ou_owner');
  const child = spawn(process.execPath, [file('../examples/feishu-codex/cli.ts'), 'serve'], {
    stdio: 'ignore',
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      ROUTER_HOOKS_FILE: module,
      ROUTER_INBOX_DIR: dir,
      ROUTER_PROJECTS_FILE: config,
      ROUTER_APPROVAL_OWNER: 'ou_owner',
      CODEX_BIN: file('./fixtures/desktop-runner.mjs'),
      LARK_CLI_BIN: file('./fixtures/hook-lark.mjs'),
    },
  });
  const exit = once(child, 'exit');
  const logs = (): { args: string[]; body: object }[] => {
    const path = join(dir, 'lark-log');
    return existsSync(path)
      ? readFileSync(path, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  };
  async function until(predicate: () => boolean) {
    const limit = Date.now() + 25000;
    while (!predicate()) {
      assert.equal(child.exitCode, null);
      assert(Date.now() < limit, 'service did not advance');
      await sleep(50);
    }
  }
  try {
    const health = join(dir, 'health.json');
    await until(() => existsSync(health) && JSON.parse(readFileSync(health, 'utf8')).admission.listening);
    const id = inbox.receive({ message_id: 'demo', chat_id: 'new', chat_type:'group', content: 'prepare a result' });
    await until(() => inbox.admission.get(id)?.receipt === 'om_transport');
    assert.equal(inbox.admission.get(id)?.status, 'waiting');
    assert(!existsSync(join(dir, 'fixture-history.json')));
    writeFileSync(
      join(dir, 'callback.json'),
      JSON.stringify({
        type: 'card.action.trigger',
        action_tag: 'button',
        action_name: 'router_admit_' + id,
        operator_id: 'ou_owner',
        message_id: 'om_transport',
        form_value: { binding: 'project:p', execution: 'run_context',source_chat:'oc_demo' },
      }),
    );
    await until(
      () => logs().some((r) => r.args.includes('text')) && logs().some((r) => r.args.includes('patch')),
    );
    assert.equal(inbox.admission.get(id)?.status, 'allowed');
    assert.equal(inbox.admission.boundProject('new'), 'p');
    const rows = logs();
    assert.equal(rows.filter((r) => r.args.includes('interactive')).length, 1);
    assert(rows.some(r=>r.args.includes('+chat-messages-list') && r.args.includes('oc_demo')));
    assert.equal(inbox.admission.context.read(id)?.messages[0]?.text,'验收专用上文');
    const notifications = rows.filter((r) => r.args.includes('text'));
    assert.equal(notifications.length, 1);
    assert(notifications[0]?.args.includes('ou_owner'));
    assert.match(JSON.stringify(notifications[0]?.body), /可继续追问的模拟结果/);
  } finally {
    child.kill('SIGTERM');
    await exit;
    inbox.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
