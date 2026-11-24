# 插件契约 v1

运行服务、提交并等待结果、订阅完成或待输入事件，见 [Application 生命周期](../application.md)。

权威 TypeScript 接口在 [`src/core/ports.ts`](../../src/core/ports.ts)，运行时 schema 在 [`src/core/domain.ts`](../../src/core/domain.ts)。对外数据使用 unknown，进入内核时解析。示例模块见 [`examples/primitives/custom-plugin.ts`](../../examples/primitives/custom-plugin.ts)。

插件是显式加载的可信本地代码。当前没有插件市场、自动安装、权限隔离或热更新。模块导出 `createPlugins(): Plugins`；apiVersion 必须为 1；来源名称不能重复，以免共享游标。

## 注册适配器和业务规则

示例使用 [createRouterApplication](../../src/core/index.ts) 注册推理运行时、只读资料源、执行器和通知出口。业务 Hook 也可以通过配置文件独立加载。新增执行器放在 `src/adapters/<系统>/`，新增可复用规则放在 `src/adapters/<平台>/hooks/`。框架的等待和恢复实现位于 `src/core/hooks/`。

应用扩展从 `work-agent-kernel` 导入接口；飞书完成通知工厂位于 [result-notice.ts](../../src/adapters/feishu/hooks/result-notice.ts)。飞书收件和服务已迁至 `examples/feishu-codex/`，原 `src/router/cli.ts` 命令改为 `node examples/feishu-codex/cli.ts`。

## Source

`fetch(cursor: string | null): Promise<unknown>` 返回：

```json
{
  "events": [{
    "source": "feishu-personal",
    "externalId": "message-123",
    "revision": "1",
    "thread": "topic-456",
    "actor": "colleague-7",
    "text": "请评估加载态支持情况",
    "uri": "example://message-123",
    "occurredAt": "2026-11-03T01:00:00Z"
  }],
  "cursor": "page-2"
}
```

以上 ID 和 URI 都是合成示例，不是飞书接口格式。

- 去重键是 `[source, externalId, revision]` 的无歧义编码；内容更新必须增加 revision。
- 同键不同内容会失败，避免悄悄把更新当成重复事件。
- cursor 只能在整个批次成功落库后前移，由 Kernel 拥有。
- 客户端与 OpenAPI 的 ID 映射由采集插件解决。不同 source 不会自动语义去重；无法确认同一事件时保留两个来源证据，交由 Router 关联事项。
- 私聊整体通常不是一个工作话题。采集器无法细分时，应把线程粒度限制明确交给 Router，避免永久把某个人的所有消息送给一个事项。
- 主动输入可直接调用 `ingest`；定时输入使用独立 source 与稳定 occurrence ID。

## Router

`decide(context, recall): Promise<unknown>`。context 包含当前摘要、候选事项、工作流目录、已注册 Harness 与允许 scope。recall 只暴露读取原文和事项的方法，不暴露执行或发消息。

```json
{
  "kind": "create",
  "reason": "首次出现的独立工作",
  "goal": "评估组件能力并给出有依据的回复草稿",
  "harness": "codex",
  "workflow": "research",
  "scope": "prepare"
}
```

其他决定为 `{ "kind": "attach", "workId": "work-…", "reason": "同一事项的新来源" }` 或 `{ "kind": "ignore", "reason": "无需执行" }`。

当前 ScriptedRouter 只供确定性测试。真实模型适配器必须保留模型拥有的归属判断，不能用固定业务矩阵取代。内核验证输出格式不等于验证判断正确；后续需要真实消息回放评估。

## WorkflowProfile

```json
{
  "name": "research",
  "version": "1",
  "instructions": "先核对原文与实现，再生成可审阅结论",
  "skills": ["source-research"],
  "acceptance": ["重要结论附来源", "未验证内容明确标注"]
}
```

创建事项时保存完整版本快照。更新配置影响新事项，不静默改变旧事项。skills 是逻辑引用，不是自动执行命令；具体解析由 Harness 实现。acceptance 只是传递给执行者的要求，当前不含自动验收器。

## Harness

| 方法 | 合同 |
| --- | --- |
| `submit(request)` | 接单后及时返回 `{sessionId, runId}`；稳定 requestId 应避免重复运行 |
| `lookup(requestId)` | 查明已有接单回执；null 始终表示未知 |
| `poll(runId)` | null 表示还在运行；否则返回 terminal Report |

WorkRequest 包含 workId、requestId、goal、scope、workflow、sessionId、输入预览、已回答的 Attention 和近期结果。原文通过适配器提供的只读 Recall 工具取得。

报告：

```json
{
  "kind": "needs_input",
  "summary": "需要确定首期范围",
  "question": "是否包含失败态？",
  "options": ["仅加载态", "加载态与失败态"]
}
```

```json
{
  "kind": "ready",
  "summary": "已准备回复草稿，尚未发送",
  "evidence": ["example://artifact/reply-draft"]
}
```

其他报告为 `failed`、`reroute`，均要求 summary。reroute 归还本轮的来源输入，不自动撤销其他事项已收到的上下文。它不是取消 API。

### Codex 适配设计（尚未实现）

1. initialize 后创建或恢复 thread；映射当前事项到原生 thread ID。
2. 将目标、profile、scope 与数据性质说明放入适当指令层，外部消息作为上下文传入。
3. turn/start 后保存原生 turn ID；订阅通知得到最终结果。
4. 将结构化报告转换为 Report；非结构化输出不能靠“包含 done”判定成功。
5. 正常后续使用原 thread。steering、取消和并发控制作为显式 capability 后续加入。
6. requestId 接单日志由适配器维护。App Server 的 turn/start 并不自动满足本项目的幂等契约；丢 ACK 必须核对，不可盲重放。
7. Desktop 展示、单 writer、人机接管、订阅认证分别实测；真实 thread 存在不代表 Sidebar 自动可见。

其他 Harness 只需满足同一接口；若不支持持续 Session，必须明确设计新会话重建策略，不能伪装成 resume。

## NotificationSink 与个人决定

`deliver(notice): Promise<string>` 接收固定 notice ID、workId、recipient、结构化 report，返回渠道回执。目标来自 Host 配置，不取外部消息中的地址。

SQLiteInbox 演示真实本地持久化。MemorySink 演示幂等投递。飞书卡片、应用推送、邮件等均未实现。

owner 点击卡片后，渠道适配器先验证回调和身份，再调用：

```ts
kernel.answer({ attentionId, choice: '仅加载态', actor: authenticatedOwner });
```

这里的 actor 不能从模型输出或普通消息中猜测。一个 Attention 只接受一次有效选择；同选项重复回调不重复继续，冲突回答被拒绝。回答是事项上下文，不扩大执行 scope。更改已作出的决定应作为新的明确事项输入，未来可增加带版本的决策替换接口。

## 确定未提交与未知回执

`SubmissionRejectedError` 只用于适配器能证明没有提交原生执行的失败，例如 Codex 进程启动或 thread/start 在 turn/start 之前失败。Kernel 将 Run 记为 rejected、事项记为 failed，保留输入并通知本人。后续新输入可重新请求。

开始调用 turn/start 后的断线、超时或解析错误仍是普通异常，进入 uncertain。不能为了释放运行位置将这种异常改成 SubmissionRejectedError。进程在提交前突然退出而未能持久化确定失败时，也可能保留 uncertain。

## 给 Router 注册工具与 Skill

在应用装配时传入 `router: { extensions: [feishuIncomingContext(inbox), myExtension] }`。
每个 `RouterExtension` 接受本轮 `PlanningRequest`。返回 `undefined` 表示本轮不用这个扩展。
显式启动飞书与 Codex 示例时，也可将 `ROUTER_EXTENSIONS_FILE` 指向受信任的本地模块，导出 `createRouterExtensions()` 返回扩展数组，重启后生效。
需要启用时，返回 `instructions`、`tools` 中的一项或两项。业务可以从自己的 Markdown 文件加载 Skill。

扩展可返回每轮独立的 `verify()` 以校验业务约束。示例的选聊扩展用它确认每个选定会话都已读取；长消息通过第二个参数的 `rememberLive` 保存本轮引用。

工具用 Zod 声明参数，通过 `run` 返回模型可见的 `value` 以及可引用的 `evidence`。
设为 `required: true` 时，Router 必须在这次规划内获得该工具的结果才能提交决定。
工具可以正常返回「没有资料」等业务结果。每轮独立挂载，工具与指引只进入 Router 的运行时。
编码时按业务请求绑定对象和授权范围。如何理解证据、是否续接由 Agent 根据 Skill 判断。

飞书扩展使用这个接口。来源已确认时，批准卡的一次提交授权读取这个会话前一天内最多十二条邻近消息，以及能验证来源的直接回复原文。读取以消息时间为准，缺少时使用收件时间。一个会话只需确认一次地址，私聊仍逐条批准。已登记群有明确飞书地址时沿用项目准入。旧版卡片的“执行”仅授权处理单条来信。若上文不可用，Skill 要求记录缺失并保留歧义。

本机查询快照随输入修订保存。插件消息详情和会话追溯展示来源、时间上界、读取数量、实际引用。Worker 接收 Router 引用的上文。测试入口为 `node --test test/incoming-context.test.ts`。设置 `ROUTER_CONTEXT_LIVE_CODEX=1` 可用本机 Codex 复验，飞书仍使用隔离的 CLI 替身。

## 包入口和应用选项

Node.js 24 的 ESM 消费者从 `work-agent-kernel` 导入 Application 和扩展契约。官方适配器通过 `work-agent-kernel/adapters/codex`、`/adapters/feishu`、`/adapters/file`、`/adapters/local`、`/adapters/responses` 按需导入。包内包含可执行 JS 和声明文件；内部源码路径不属于导出契约。

```ts
import {createRouterApplication} from 'work-agent-kernel';
import {codexPlanner} from 'work-agent-kernel/adapters/codex';
const app = createRouterApplication({
  ...config,
  owner: 'incident-operator', maxSources: 8,
  runtime: codexPlanner('codex'),
  router: {archiveTools: true, language: 'en', maxActions: 4, maxToolCalls: 10},
});
```

owner 同时用于 owner 请求的 actor 以及人工答复身份。缺省沿用 local-owner。基础 Router 指引支持 zh（默认）与 en，instructions 可另附应用指引。默认预算分别为 12 个来源、12 个行动、14 次工具调用；单次请求可以进一步收紧。归档搜索、追溯与完整读取由内置扩展按配置挂载，默认关闭；基础事项查询与来源可见性校验仍在。证据来源显示字段为 sourceLabel；历史队列中的 chat 在读取和恢复时转换。

详细示例按用途见[示例导航](../../examples/README.md)。仓库锁定防误发设置，包可通过 npm pack 在本地验证，正式发布需另行决定。

从仓库旧版迁移时，`Evidence.chat` 改用 `Evidence.sourceLabel`，飞书准入 Hook 改从 `work-agent-kernel/adapters/feishu` 导入。旧的直接调用 `node src/cli.ts demo` 可换成 `npm run demo`。低层 live 示例搬到 `examples/primitives/live/`，原项目状态目录保持可用。
