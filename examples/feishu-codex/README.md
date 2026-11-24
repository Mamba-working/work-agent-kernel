# 飞书 + Codex 本地示例

[Quick Start：Router Bot 如何分发任务，以及怎样接入自己的业务](QUICKSTART.md)

[profile.ts](profile.ts) 是这套应用的配置。框架入口是 [createRouterApplication](../../src/core/application.ts)。只使用框架的应用自行选择 runtime、worker 和扩展。

| 本地选择 | 作用 |
| --- | --- |
| 飞书收件适配器及 `feishuAdmission` Hook | 收件、确认来源及批准范围，批准后进入 Router |
| `feishuIncomingContext` | 为获准的来信挂载读取同一会话上文的工具和指引 |
| `selectedChats(readChat)` | 为主动派单挂载选聊读取工具，限制会话和时间范围 |
| `mergeWork` | 用本地 Skill 指导 Router 判断新建或续接 |
| Codex planner 和 worker | 用本机 Desktop 的模型配置规划和执行，续接时复用原会话 |

[service.ts](service.ts) 创建 SQLite 存储、worker、项目目录和通知出口，将它们与示例配置交给框架。启动时可用 `ROUTER_EXTENSIONS_FILE` 和 `ROUTER_HOOKS_FILE` 显式追加受信任的模块。项目配置、账号和机器专用的消息桥接由部署方保存。

从仓库根目录运行：

```sh
node examples/feishu-codex/cli.ts serve
```

已有部署使用相同的 `ROUTER_INBOX_DIR` 和 `ROUTER_PROJECTS_FILE` 即可继续读取原数据。收件指令、审批配置与插件安装见[使用说明](../../docs/ROUTER.md)。
