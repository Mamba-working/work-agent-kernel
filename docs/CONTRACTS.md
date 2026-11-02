# 插件契约 v1

权威 TypeScript 接口在 [`src/ports.ts`](../src/ports.ts)，运行时 schema 在 [`src/domain.ts`](../src/domain.ts)。对外数据使用 unknown，进入内核时解析。示例模块见 [`examples/custom-plugin.ts`](../examples/custom-plugin.ts)。

插件是显式加载的可信本地代码。当前没有插件市场、自动安装、权限隔离或热更新。模块导出 `createPlugins(): Plugins`；apiVersion 必须为 1；来源名称不能重复，以免共享游标。

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
