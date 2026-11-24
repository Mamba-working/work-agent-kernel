# Work Agent Kernel

**简体中文** · [English](README.en.md)

> 昨天，你在 Codex Desktop 里起草了一份上线清单。今天，同事在飞书群里补了一句：「把回滚步骤也加进去。」谁还记得昨天那份清单在哪个会话里？

Work Agent Kernel 是一个本地 TypeScript 框架。它为持续推进的工作保存一条独立的**工作事项**记录。两条消息可以来自不同渠道；只要 Router 判断它们在推进同一个目标，内核就能把补充要求挂到原事项，交给 worker 续接原会话。默认应用接入了飞书与 Codex，项目、会话和派单依据都可以在 Desktop 插件里查看。

[运行离线演示](#快速上手) · [查看扩展接口](#接入自己的业务) · [看 demo 怎样产出草稿](#一个外部插件怎样跑完整条链路)

## 从请求到工作会话

![Desktop 和飞书来信在 beforeRoute 汇合。Router 将补充要求归入工作事项，执行器续接 Codex 会话。结果经过 beforeNotify 送入收件箱。](docs/images/kernel-extension-path.webp)

图中有两种扩展点。飞书消息通过 `Source` 进入，Router 调用 `PlanningRuntime` 做判断，Codex 通过 `Harness` 接单；业务规则挂在 `beforeRoute` 和 `beforeNotify` 两处。

回到开头的清单。Desktop 提供你写下的目标，飞书适配器提供来信和群所属的项目。获准处理后，两个入口都把请求交给同一个 **Router**。它可以查看已有事项，提出「续接上线清单」的计划；闲聊也可以只留记录。

**内核**校验项目归属、事项和权限，把这次决定写入 SQLite。**执行器**拿到工作要求和已保存的 session ID，打开原会话继续做。事项记录保存目标、输入和历次结果，session ID 则由具体执行器解释。以后显式换执行器时，新执行器可以从这些记录接手，使用自己的会话。[路由与会话的完整设计](docs/architecture/routing.md)

## 快速上手

### 先在本机看一次续接

准备 **Node.js 24**，在仓库根目录运行：

```sh
npm ci --ignore-scripts
npm run demo
```

演示使用临时 SQLite 数据库、模拟消息和模拟执行器，无需账号或 API 密钥。例子里，同事问「对比卡片能支持加载态吗？」，随后补充「先看移动端」。执行器追问是否也要覆盖失败态。演示重启内核、提交用户的选择，再把一条设计文档评论关联到同一事项。

| 在输出中找 | 你刚验证了什么 |
| --- | --- |
| `workItems: 1`、`events: 3` | 三条输入归到同一件工作。 |
| `sameSessionAfterAnswer: true` | 等到用户回答后，执行器在原会话继续。 |
| `harnessAfterRebind: "echo"` | 最后一步换了执行器；工作事项和此前的结果仍然保留。 |

### 在 Codex Desktop 里用自己的项目

在支持 MCP App 的 macOS 版 Codex Desktop 上，先登录 Codex CLI。完成上面的依赖安装后，在仓库根目录运行以下命令。示例将当前目录登记为 `Demo` 项目，配置写入临时文件。

```sh
npm --prefix plugins/router-inbox ci
npm --prefix plugins/router-inbox run install:codex
project_config=$(mktemp)
node -e 'console.log(JSON.stringify({ demo: { name: "Demo", cwd: process.cwd() } }))' > "$project_config"
ROUTER_PROJECTS_FILE="$project_config" node src/router/cli.ts serve
```

保持服务运行，在 Desktop 插件中打开「项目」即可看到 `Demo`。在「派发」输入「为 Demo 项目起草上线清单」并提交；处理完成后，可从关联事项打开工作会话。「消息流」里可以回看接入记录和路由依据。长期使用时，将项目配置保存在固定位置，再通过 `ROUTER_PROJECTS_FILE` 指向它。

默认 Router 与 worker 沿用本机 Codex 的模型和推理配置。接收飞书来信需要向标准入口交付事件；读取群聊或发送审批卡还需要相应的飞书授权。[插件安装与卸载](plugins/router-inbox/README.md) · [消息接入与飞书配置](docs/ROUTER.md)

## 发出卡片后，要等吗？

![请求 A 发出审批卡后暂停，请求 B 在此期间完成。本人批准后，A 从断点继续。](docs/images/hook-wait-resume.webp)

答案取决于下一步是否需要回复。比如启用准入后，未绑定的群来了一条需求，准入 Hook 返回 `wait`，框架保存当前步骤，再由飞书适配器发卡。卡片送达时，这条请求仍在等你；其他请求可以照常完成。

你选「本次执行」，Hook 用 `continue` 恢复请求，也可以带上后续需要的资料。选「中断」，它用 `break` 结束本次处理。若卡片只是告知「清单已完成」，业务可以直接继续，让通知在后台投递。用 `node examples/lifecycle/demo.ts` 可以在本机看到第一单等待、第二单完成、第一单带着版本信息恢复。[Hook 状态与回调示例](docs/extensions/hooks.md)

要把团队的清单版本带进判断，可写一个本地模块，例如 `business-hooks.mjs`：

```js
export function createHooks() {
  return [{
    id: 'team.checklist',
    phase: 'beforeRoute',
    run() { return { kind: 'continue', context: { checklistVersion: 'v2' } }; }
  }];
}
```

把 `ROUTER_HOOKS_FILE` 设为这个可信模块的绝对路径，再启动服务。框架在 `beforeRoute` 调用它，把版本资料以 Hook ID 分开保存，并继续进入 Router。更晚的通知规则注册在 `beforeNotify`，此时工作结果已经落库。

## 一个外部插件怎样跑完整条链路？

![文件里追加的「加载时保留原图」和本人选择的 Loading only 一起进入 Markdown 草稿；内核另行把通知送入本地收件箱。](docs/images/offline-loop.webp)

`demo:loop` 演示一个团队把自己的输入、执行器和收件箱接到内核。CLI 用 `--plugins` 加载本地模块并调用 `createPlugins()`。模块返回四个具体实现：[示例装配代码](examples/offline-loop/plugin.ts)。

| 插件交给框架 | 这个 demo 实际做的事 |
| --- | --- |
| `sources` → `FileEventSource` | 从 `events.jsonl` 读请求、修订和补充。内核按事件键对重放的同一版本去重。 |
| `router` → `fixtureRouter` | 用固定判断选出工作事项，让离线结果可复现。 |
| `harnesses` → `DurableDemoHarness` | 提出范围问题，等待回答；恢复后把输入和选定范围写成 Markdown 草稿。 |
| `sinks` → `SqliteInbox` | 接收待答问题及最终结果的通知，保存到本地 SQLite。 |

用户的选择也走公开入口。演示脚本在独立 CLI 进程中调用 `answer`，选择 `Loading only`。这是 worker 执行中提出的问题；上一节的准入卡发生在请求进入 Router 之前。

在 macOS 或 Linux 上运行以下命令，亲自打开产物：

```sh
demo_dir=$(mktemp -d)
npm run demo:loop -- --directory "$demo_dir"
cat "$demo_dir"/drafts/*.md
```

草稿会同时包含 `Chosen scope: Loading only` 和等待期间追加的 `Please keep the existing image while loading`。可以逐项对照原始输入、人的决定和最终内容。整个例子使用受控执行器，消息和文件都保存在临时目录。[演示脚本](examples/offline-loop/demo.ts)

## 接入自己的业务

| 你要改什么 | 从哪里开始 |
| --- | --- |
| 从另一个渠道接收请求，或替换负责干活的工具 | 在 `src/adapters/` 实现 `Source` 或 `Harness`，在应用入口注册。[适配器契约](docs/extensions/contracts.md) |
| 某类请求需要审批，或结果要额外通知本人 | 在 `src/hooks/` 实现 `LifecycleHook`，选择路由前或通知前执行。[飞书准入实例](src/hooks/feishu/admission.ts) |
| 更换负责判断的 AI 或提供外部资料 | 分别实现 `PlanningRuntime` 和 `ContextReader`。Codex 的路由判断与 worker 执行可以独立替换。[规划接口](src/core/planning/contracts.ts) |
| 组合自己的 Router 应用 | 用 `createRouterApplication` 注册推理运行时、资料读取器、执行器和通知出口。[默认应用装配](src/router/service.ts) |

[测试指南](docs/TESTING.md) · [贡献指南](CONTRIBUTING.md) · [MIT 许可证](LICENSE)
