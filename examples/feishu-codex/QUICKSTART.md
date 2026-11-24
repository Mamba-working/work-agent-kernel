# Quick Start · 构建一个分发任务的 Router Bot

**Work Agent Kernel 是一个 TypeScript 任务分发框架。** 开发者用它搭建 Router Bot，接收请求，判断该把任务分到哪个项目、哪个工作事项，再交给执行器（worker）去做。补充请求可以续接原事项和原会话。只需要回答时，Router 可以直接返回答案。

飞书 + Codex 是一个可选应用。飞书提供消息来源，Codex 运行 Router 和 worker，Desktop 插件提供主动派单与查看结果的界面。

## 1. 提交请求，查看分配去了哪里

框架面向应用代码提供 TypeScript API。`createRouterApplication(options)` 创建应用并返回 `app`。下面使用示例服务已经创建的 `app`：

```ts
const job = app.submit({
  id: crypto.randomUUID(),             // 本次请求编号
  description: '检查当前项目的发布配置', // 给 Router 的任务描述
  sources: [],                         // 可选聊天的列表，本次留空
});

// 服务启动时调用 app.start()，提交后直接等待分配。
const result = await job.routed;
console.log(result.status);     // 请求目前的派发状态
console.log(result.workIds);    // 实际分配到的工作事项 ID
console.log(result.result?.answer); // Router 的回答或分配理由
const completed = await job.done;
console.log(completed.outcomes); // 本次提交触发的各项执行结果
```

`job.id` 标识一次请求；`workIds` 标识持续跟进的工作。两次请求可以分到同一个事项。直接回答时，`workIds` 可以为空。要查看执行进度，用 `app.listWorks()` 按事项 ID 找到对应记录，读取其 `execution`、`sessionId` 和 `results`。

## 2. 配置 Router：选运行方式、消息入口和业务能力

这是 [profile.ts](profile.ts) 里的三项配置。先选一个负责分配任务的 AI，再按业务需要添加消息来源和工具。

```ts
runtime: codexPlanner(executable),
ingress: [feishuIngress(inbox, harnessFor, channel)],
router: {
  extensions: [
    mergeWork,
    feishuIncomingContext(inbox),
    selectedChats(readChat, maxDays),
    ...extra,
  ],
},
```

### `runtime`：用谁来判断如何分配？

必填，一个规划函数。使用 Codex 时传 `codexPlanner(executable)`；`executable` 是本机 Codex 可执行文件的名称或路径。无论请求来自飞书还是主动派发，都使用这个配置。它给出分配计划或直接回答；接单后实际干活的 worker 在 `harnesses` 中单独配置。

### `ingress`：Router 接收哪些外部来源的消息？

可选，一个入口数组。只通过 `app.submit(...)` 主动派单时可以省略。希望飞书来信也能触发 Router，就注册 `feishuIngress(inbox, harnessFor, channel)`。三个参数分别是飞书收件箱、按项目 ID 查执行器名称的函数、发送与更新审批卡的渠道。示例入口同时带上了本来源的审批规则。

增加另一种消息来源时，往数组追加一个入口。自定义入口形状是 `{ source, context?, hooks }`：`source` 提供新消息，`context` 可补充消息背景，`hooks` 填本来源的规则，没有规则就传空数组。

### `router.extensions`：处理请求时，Router 需要哪些额外能力？

可选，一个扩展函数数组。每个扩展根据当前请求决定提供什么：可以给一段指引（`instructions`），可以给可调用的工具（`tools`），也可以两者一起给。

| 示例里的扩展 | 适用场景 | 用户能得到什么 |
| --- | --- | --- |
| `mergeWork` | 判断新建还是续接时 | Router 有一份比较目标和交付物的指引 |
| `feishuIncomingContext(inbox)` | 处理有读取授权的飞书来信时 | Router 能读来信所在会话的上文 |
| `selectedChats(readChat, maxDays)` | 用户主动派单并选择了聊天时 | Router 能读选中的聊天；`readChat` 提供读取方法，`maxDays` 决定允许回看的天数 |

**如何选配置？** 如果飞书已经能触发 Router，但你还希望它能读前面的对话，保留现有 `ingress`，在 `router.extensions` 添加 `feishuIncomingContext(inbox)` 即可。如果以后想换负责分配的模型运行方式，调整的是 `runtime`。

## 3. 自定义这五项：从现有配置换成自己的函数

[custom-profile.ts](custom-profile.ts) 是完整的可选配置。在同目录的 `service.ts` 把导入改为下面一行，保留原有调用参数，就会选用教学配置：

```ts
import { customProfile as localRouterProfile } from './custom-profile.ts';
```

| 想改什么 | 你写哪段代码 | 这份示例的做法 |
| --- | --- | --- |
| `codexPlanner` | 写一个 `PlanningRuntime`。参数依次是请求、可用工具、停止信号、指引；返回含 `answer`、`actions`、`evidence` 的规划结果。 | `myPlanner` 给每次规划设 90 秒上限，再调用原 Codex 规划函数。如果替换整个运行时，你的模型请求要接收工具定义，模型要求用工具时调用 `tools.call({ tool, arguments })`，把结果交回模型直到得到最终计划。 |
| `mergeWork` | 写一个返回 `{ instructions }` 的函数。Markdown Skill 的正文也可以直接读成这个字符串。 | `myMergeWork` 用自己的规则指导 Router 判断哪些交付物可以续接。 |
| `feishuIncomingContext` | 保留飞书准入，传入自己的读取回调 `(chat, until, anchor) => Promise<消息[]>`。参数分别是获准的会话、截止时间、触发消息与直接回复标识。 | `myIncomingContext` 按时间倒序，只提供最近三条。 |
| `selectedChats` | 传两个函数：分页读取器 `(source, start, end, cursor) => Promise<{ messages, next }>`，以及由任务描述确定最大回看天数的函数。 | `readReleaseMessages` 只返回正文含“发布”的消息，保留下一页游标；`() => 2` 将上限设为两天。 |
| `ingress` | 它是入口对象的数组。一个入口至少给 `source.name`、`source.fetch(cursor)` 和 `hooks`。按需加 `context` 以提供项目等背景。 | `ticketIngress` 把工单转成标准事件，凭游标读取新增工单。它和原飞书入口并列；工单示例使用按顺序追加的内存数组。 |

配置里使用 `runtime: myPlanner(executable)`、`ingress: [...base.ingress, ticketIngress(tickets)]`、`router: { extensions: [myMergeWork, myIncomingContext(inbox), mySelectedChats, ...extra] }`。这三组扩展各自替换原先的位置。选聊示例同步把本地归档的时间范围配置为两天。

## 4. 从零增加一个工具

开发者增加自己的业务能力也沿用同一入口。例如下面的教学扩展把本地发布计划作为工具交给 Router：

```ts
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { RouterExtension } from 'work-agent-kernel';

export const releasePlan: RouterExtension = () => ({
  instructions: '用户问演示卡片的发布日期时，调用 read_release_plan，依据返回值回答。',
  tools: [{
    name: 'read_release_plan',
    description: '查询演示卡片的发布计划',
    schema: z.strictObject({}),
    async run() {
      const file = new URL('./release-plan.example.json', import.meta.url);
      return { value: JSON.parse(await readFile(file, 'utf8')) };
    },
  }],
});
```

将 `releasePlan` 导入 [profile.ts](profile.ts) 并追加到现有 `router.extensions` 数组，就注册了这个工具。示例数据在 [release-plan.example.json](release-plan.example.json)；Router 调用它后可以回答发布日期。该教学扩展按需启用。

[完整示例配置](profile.ts) · [创建应用和注册 worker 的服务代码](service.ts) · [扩展接口定义](../../src/core/planning/extensions.ts)
