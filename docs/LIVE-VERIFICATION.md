# 真实链路验证记录

2026-11-03，在 macOS、Node 24 和 Desktop 自带 `codex-cli 0.166.0-alpha.5.1` 上运行。模型使用用户配置的 Responses 兼容代理与 `gpt-6.1-sol[1M]`。输入全为合成的 Acorn 试运行方案要求，没有采集同事消息。

| 检查 | 实际结果 | 边界 |
| --- | --- | --- |
| 模型 Router | 三次真实请求分别得到 create、attach、ignore，关联到原事项 | 三个固定验收样本，不是准确率评测 |
| Codex 执行 | 原生 thread/start、turn/start 完成，返回结构化结果并保存真实 Markdown | 草稿准备，没有执行业务写入 |
| 独立进程恢复 | 首轮完成后终止总控，launchd 启动新 PID；原工作及回执保留 | 不等同于活动回合无损迁移 |
| 原线程续接 | 新进程处理补充要求，Session ID 保持不变，产生第二个回合和修订文稿 | 单写入者，无 Desktop 同时接管 |
| 活动回合中断 | 独立原生探针在接单后关闭 App Server，新进程读回 interrupted，映射 failed | 不自动重跑 |
| 飞书通知 | 两次结果各发给本人；第一条用消息读取 API 回查内容、发送人和回执 | 收到远端记录，不证明本人已读或弹出横幅 |
| 通知去重 | 首轮后重启服务，仍只有一条原通知；第二轮产生一条新通知 | 本机回执与飞书幂等窗口，不是无限 exactly-once |
| Desktop 记录 | Desktop 的 read_thread 接口读到原生回合和模型正文 | 已请求官方 deep link；电脑控制工具拒绝读取该应用 UI，未截图验收 |
| 受控测试 | 真实本地 HTTP、子进程 JSON-RPC、SQLite 和 CLI，覆盖正常及失败路径 | 外部端点在单元测试中受控，不能替代以上实跑 |

## 复现入口

- `npm run check` 验证类型与离线测试。
- `npm run demo` 验证原架构 demo。
- `node --env-file=/absolute/private/live.env examples/live/router-eval.ts` 发出真实模型请求。
- [真实 demo 使用说明](LIVE-DEMO.md) 说明安装、提交、续接、通知和停止。

## 未交付部分

真实飞书输入 Source、Claude Code Adapter、远端人工决定回调、任务语义 Watchdog、运行中 steering 和双向人机接管未实现。进程保活不代表这些能力已经具备。

## 依据

协议字段以本机 `codex app-server generate-json-schema` 的导出为准。集成方式参照 [Codex App Server](https://learn.chatgpt.com/docs/app-server)，线程跳转使用官方 [Desktop deep links](https://learn.chatgpt.com/docs/reference/commands)。配置的第三方模型代理能力以本轮实际请求为准。

## 独立复核后的修正

复核发现启动失败会占住唯一运行位置。针对缺失 Codex 可执行文件增加一条公开接口测试：旧版断言得到 uncertain 而失败，修正后为 failed，输入保留；重启并换回可用适配器后，另一事项实际完成。确定未提交的失败与回执未知分别处理，没有增加自动重试。
