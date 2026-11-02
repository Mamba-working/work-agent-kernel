# Work Agent Kernel

一个以**持续工作事项**为中心、可以替换底层 Harness 的个人工作 Agent 架构原型。

输入可以来自别人 @你、个人私聊、文档评论、定时事件，也可以来自你主动提出的请求。Router 判断它属于新事项还是已有事项；Worker 在独立 Session 中推进；需要你决定时，经统一通知出口提出问题，你的决定再回到原事项。

**当前是可执行架构与测试骨架，不是生产 Agent。** 所有示例均使用合成数据和测试 Harness，不读取真实账号、不调用模型、不发送外部消息。项目独立实现，借鉴 DeepSeek Super-agent 的领域划分，不依赖其 Harness 或 OpenClaw。

## 从一个例子理解

同事在群里问“卡片能否支持加载态”，随后在私聊补充限制，又在文档中更新设计：这应是一件工作，关联多个输入来源，而不是三个互不知情的 Agent。

```mermaid
flowchart LR
    sources[输入插件与主动请求] --> inbox[持久事件收件箱]
    inbox --> route[Router 判断新工作与关联]
    route --> work[持续工作事项]
    inbox -->|已订阅讨论串直达| work
    work --> adapter[Harness 接口]
    adapter --> sessions[独立 Worker Sessions]
    sessions --> reports[结果或待决问题]
    reports --> outbox[持久通知发件箱]
    outbox --> channels[本地应用或飞书出口]
    channels -->|已认证的个人决定| work
    work --- recall[原文与事项关联检索]
```

## 快速验证

使用 Node.js **24.21.0**（CI 在 Linux 和 macOS 使用此版本）。运行时使用 Node 原生 TypeScript 支持和 `node:sqlite`；Zod 是唯一运行时 npm 依赖。

```bash
npm ci --ignore-scripts
npm run check
npm run demo
```

`demo` 创建独立临时目录并打印数据库位置。它真实执行 SQLite 持久化、内核重启和通知落库，模拟来源与 Harness：

1. 接收群聊请求并创建事项。
2. 同一讨论串的补充直接进入原事项。
3. Worker 提出问题，通知写入本地收件箱。
4. 重启内核，接收个人决定。
5. Router 将文档评论关联回原事项。
6. 继续同一模拟 Session，生成草稿结果。
7. 显式换成另一种 Harness，保留事项及结果，创建新的执行 Session。

关键输出应为 `workItems: 1`、`events: 3`、`sameSessionAfterAnswer: true`、`finalStatus: "ready"`。`ready` 表示有待审阅产物，**不表示已经发消息、发布或完成业务验收**。

## 分支迭代的 demo

新增演示通过实际文件和独立 CLI 进程验证输入、决定与执行的连续性。

```bash
npm run demo:replay
npm run demo:decision
npm run demo:loop
```

- `demo:replay` 读取追加式 JSONL，保留修订和补充，重启后继续读取。
- `demo:decision` 通过本地 `answer` 命令回答待决问题，再由新的 CLI 进程继续同一模拟 Session。
- `demo:loop` 组合两条流程，在等待决定时追加输入，之后生成包含范围决定与消息内容的 Markdown 草稿。

每个命令默认创建独立临时目录。输出给出状态和产物路径，便于回查。执行者和 Router 仍是明确标注的测试替身。详见[这轮 demo 的设计和验证](docs/DEMO-ITERATION.md)。

## 已有能力

| 能力 | 原型实现 |
| --- | --- |
| 输入插件 | `Source.fetch(cursor)`；批次与游标一起落库 |
| 主动输入 | `Kernel.ingest(event)`，与外部来源共享事件模型 |
| Router | 类型化 `create / attach / ignore` 决策；测试用 ScriptedRouter |
| 订阅 | 来源讨论串与工作事项多对多；后续输入直达；无关输入可退回 Router |
| 工作流配置 | 版本化 WorkflowProfile：指令、Skill 引用、验收要求，创建事项时固定版本 |
| Harness 替换 | `submit / lookup / poll`；事项身份不随 provider Session 变化 |
| 人工决策 | 持久 Attention；已认证 owner 回答；重复回答幂等 |
| 通知 | 可替换 Sink、持久 Outbox、稳定通知 ID；内存和 SQLite 示例 |
| 持久上下文基础 | 原文保留、限长预览、关联 ID 和只读 Recall 接口 |
| 运行可靠性 | 同事项串行、独立事项分别运行、来源故障隔离、未知提交状态不盲重跑 |

## 插件示例

```bash
node src/cli.ts run \
  --plugins ./examples/custom-plugin.ts \
  --db /tmp/work-agent-plugin.sqlite \
  --ticks 2

node src/cli.ts inspect --db /tmp/work-agent-plugin.sqlite
```

插件导出 `createPlugins(): Plugins`，提供 Source、Router、Harness 和 NotificationSink。这里是显式加载可信本地代码，不是沙箱插件市场。命令只运行指定次数，不安装常驻服务。

## 设计与后续推进

- [架构、职责与状态流](docs/ARCHITECTURE.md)
- [插件契约与 JSON 示例](docs/CONTRACTS.md)
- [DeepSeek 原型对照和技术决策](docs/DESIGN-DECISIONS.md)
- [测试与真实接入验收](docs/TESTING.md)
- [分阶段路线图](docs/ROADMAP.md)
- [面向后续开发 Agent 的约定](AGENTS.md)

## 当前限制

- 尚无真实 Feishu、Codex、其他 Harness、模型 Router 或远端通知适配器；测试通过不证明这些接入可用。
- SQLite 保存单个 JSON aggregate，适合验证结构与事务，不能直接作为海量飞书归档。
- 一个数据库只由一个 Host 拥有；未提供多进程协调、集群或可抢占调度。
- 原有 demo 验证内核重启。新增 demo 验证离线模拟 Harness 的记录跨进程保留；不承诺真实模型服务崩溃后的恢复。
- 当前不提供自动取消、运行中 steering、长时间任务 Watchdog、语义向量记忆或桌面 GUI。
- `scope` 和 `actor` 是 Host 传入的控制信息；生产适配器还必须实现实际认证、权限映射与沙箱。

不会因为开着这个仓库就自动执行未来路线图；后续每个阶段都应依据明确任务和验收推进。
