# Router Bot 的入口和测试

本仓库提供业务入口 `RouterInbox.receive`，也可从命令行把一条 JSON 消息交给同一入口。最小示例使用模拟数据。

```sh
npm ci
export ROUTER_INBOX_DIR="$(mktemp -d)"
printf '%s' '{"message_id":"example-1","chat_id":"demo-group","sender":"测试","content":"请整理上线清单"}' | node src/router/cli.ts ingest
```

接收成功只代表消息已持久化。可选的 `ROUTER_PROJECTS_FILE` 指向项目 ID 到 `name`、`cwd`、`feishuChatId` 的 JSON 映射。通过 `node src/router/cli.ts serve` 运行 Router 和 worker。本地需要可用的 Codex。它继承用户的模型与提供商配置，自动执行使用只读准备范围。

| 责任 | 入口 | 输入与产出 |
|---|---|---|
| 外部接入 | 部署方自行维护 | 把事件变成标准消息。协议钩子、账户、文件监听和机器配置在核心仓库之外。 |
| 接收和项目档案 | RouterInbox.receive | 校验标准消息，同一事务内写收件箱和项目归属。消息 ID 和修订号用于去重。 |
| 业务判定 | projectRouter | 提供候选事项和项目证据，模型选择 ignore、create 或 attach；代码校验项目、可用执行器和引用。 |
| 执行与结果 | Kernel、Host、projectWorker | 保存派单、续接同一事项会话、处理完成/失败/待补充、交付结果。 |

闲聊和纯背景都可以不建事项。已绑定群的背景仍进入项目档案。前后文补充已有事项时允许 attach；同一群的不同目标可以各开事项。尚未登记的群不会自动注册项目。项目群历史只来自已接收消息，不能代表完整群聊。

## 如何验证

- `npm run check` 执行类型检查和离线测试，含 CLI、真实 SQLite 以及受控的模型决策和执行器。测试不会读取用户真实聊天、调用模型或发送飞书消息。
- `npm run demo` 运行离线核心流程。
- `npm run eval:router` 用本机 Codex 的真实模型逐条判断合成语料。报告对照预期判断，包含失败和超时。允许在命令后指定场景名称复查。该套评估依赖本地登录和网络，不作为离线 CI 的一部分。
- `test/router-inbox.test.ts` 覆盖接收、群绑定、冲突、修订、归档和上下文。
- `test/router-business.test.ts` 覆盖业务决策执行、派单、归属验证、会话续接和 worker 输入。
- `test/router-cli.test.ts` 在空 HOME 运行公共入口。

本机桥接的日志、钩子、工作目录、会话数据和真实群 ID 均由部署方保管。发布时只从这个独立 Git 工作树取文件。
