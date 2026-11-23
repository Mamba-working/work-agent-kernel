# 运行验证

使用 Node.js 24，在仓库根目录运行：

```sh
npm ci --ignore-scripts
npm run check
npm run demo
npm --prefix plugins/router-inbox ci
npm --prefix plugins/router-inbox test
```

核心测试使用临时目录、SQLite、子进程和本地回环 HTTP 服务。飞书、模型和执行器等外部服务在自动化测试中使用受控替身。插件测试先构建可安装资源，再通过 MCP 读取页面、提交合成派单并验证会话跳转约束。

| 修改范围 | 建议优先运行的测试 |
| --- | --- |
| 模块边界、插件装配 | test/module-boundaries.test.ts、test/plugins.test.ts、test/router-application.test.ts |
| 路由、续接和恢复 | test/routing.test.ts、test/execution.test.ts、test/router-service.test.ts |
| 业务 Hook | test/hooks.test.ts、test/hook-service.test.ts、test/admission.test.ts |
| Codex 或飞书 | test/codex-harness.test.ts、test/lark-sink.test.ts、test/router-inbox.test.ts |
| Desktop 插件 | npm --prefix plugins/router-inbox test |

`npm run eval:router` 使用本机 Codex 和合成语料，需要已配置的账号及网络。部署方可以单独验收真实渠道的授权、消息接收、卡片回调与工作会话续接。请在本机保存账号、原始消息和实跑日志。Linux 与 macOS 的 CI 使用相同的离线验证入口。
