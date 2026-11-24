import {mergeWork} from '../feishu-codex/profile.ts';
import {queryWork} from '../../src/core/planning/work-query.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../../src/core/kernel.ts';
import { RecordingHarness, ScriptedRouter } from '../support/adapters.ts';
import { RouterInbox } from '../../src/adapters/feishu/inbox.ts';
import { projectRouter } from '../../src/adapters/feishu/context.ts';
import { RouterBot } from '../../src/core/planning/router.ts';
import { incomingPlanner } from '../../src/core/planning/requests.ts';
import { codexPlanner } from '../../src/adapters/codex/planner.ts';

const cases: [string, string, string, string, string?][] = [
  ['私聊寒暄', 'dm', '早上好，哈哈哈', 'ignore'],
  ['群聊闲聊', 'grp', '午饭吃得很开心，路过打个招呼', 'ignore'],
  ['未绑定群闲聊', 'unbound', '周末愉快！', 'ignore'],
  ['纯背景资料', 'grp', '背景备忘：本期上线窗口为周五 18 点，当前无需处理。', 'ignore'],
  ['私聊明确任务', 'dm', '请整理一份会议议程初稿，给我三条议题。', 'create'],
  ['群内明确任务', 'grp', '请按已知窗口拟一份上线检查清单给我。', 'create'],
  ['同项目独立新需求', 'grp', '新需求：请单独准备会员积分过期提醒文案。', 'create', 'existing'],
  ['明确续接', 'grp', '继续刚才的库存接口切换清单，在原清单补上回滚检查。', 'attach', 'existing'],
  ['已有任务获得新信息', 'grp', '补充刚才库存接口切换的验收条件：需要检查库存回滚。', 'attach', 'existing'],
  ['取消闲聊中的伪任务', 'dm', '刚才随口说的“写方案”只是玩笑，不用做，也没有待办。', 'ignore'],
];
async function run(row: (typeof cases)[number]) {
  const [name, chat, content, expected, seed] = row;
  const dir = mkdtempSync(join(tmpdir(), 'router-eval-'));
  const inbox = new RouterInbox(join(dir, 'inbox.sqlite'), {
    demo: { name: '项目', cwd: dir, feishuChatId: 'grp' },
  });
  const kernel = new Kernel({
    path: join(dir, 'kernel.sqlite'),
    harnesses: { codex: new RecordingHarness('generic'), 'codex/demo': new RecordingHarness('demo') },
  });
  try {
    if (seed) {
      inbox.receive({ message_id: 'initial', chat_id: chat, content: '请准备库存接口切换清单' });
      await kernel.collect(inbox);
      kernel.router = new ScriptedRouter([
        { kind: 'create', goal: '准备库存接口切换清单', reason: '准备前置事项', harness: 'codex/demo' },
      ]);
      await kernel.routeNext();
    }
    inbox.receive({ message_id: 'target', chat_id: chat, content });
    await kernel.collect(inbox);
    kernel.router = projectRouter(
      inbox,
      incomingPlanner(new RouterBot(codexPlanner(process.env.CODEX_BIN ?? 'codex'),{extensions:[mergeWork],lookup:(request,opts)=>queryWork(kernel,[inbox],request,opts)}),
        {defaultHarness:'codex',projects:[{id:'demo',name:'项目',harness:'codex/demo'}]},
        AbortSignal.timeout(Number(process.env.EVAL_TIMEOUT_MS ?? 120000))),
      id=>'codex/'+id,
    );
    const before = kernel.works().length;
    const ids = await kernel.routeNext();
    const got = !ids?.length ? 'ignore' : kernel.works().length > before ? 'create' : 'attach';
    const pass = got === expected;
    console.log(JSON.stringify({ name, expected, got, pass }));
    return pass;
  } catch (error) {
    console.log(JSON.stringify({ name, expected, pass: false, error: String(error) }));
    return false;
  } finally {
    kernel.close();
    inbox.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const selected = cases.filter((row) => process.argv.length === 2 || process.argv.slice(2).includes(row[0]));
if (!selected.length) throw new Error('No matching semantic cases');
let passed = 0;
for (let i = 0; i < selected.length; i += 3) {
  const batch = await Promise.all(selected.slice(i, i + 3).map(run));
  passed += batch.filter(Boolean).length;
}
console.log(JSON.stringify({ passed, total: selected.length }));
if (passed !== selected.length) process.exitCode = 1;
