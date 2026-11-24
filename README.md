# Work Agent Kernel

**简体中文** · [English](README.en.md)

Work Agent Kernel 是一个本地 TypeScript 框架，让同一项工作可以跨会话继续推进。Router 判断新请求该新建事项还是续接已有事项，内核校验决定，并用 SQLite 保存执行进度和结果。

例如，你在 Codex Desktop 派单起草一份上线清单，第二天又在飞书群里说「给昨天的清单补上回滚步骤」。Router 可以把这条补充关联到原事项，让 Codex 在原会话里继续工作。

## 快速开始

使用 **Node.js 24**，在仓库根目录运行离线演示。演示使用临时 SQLite 数据库和模拟执行器，无需账号或 API 密钥。

```sh
npm ci --ignore-scripts
npm run demo
```

演示会暂停一个事项，等待用户回答，再恢复执行。输出中的 `sameSessionAfterAnswer: true` 表示回答后续接了原会话。

## 接入与扩展

- **使用默认应用**：配置 Router 后，安装 Desktop 插件即可按项目查看会话、主动派单和追溯结果。[Router 配置](docs/ROUTER.md) · [插件安装](plugins/router-inbox/README.md)
- **接入其他工具**：在应用启动时注册适配器，替换消息来源、推理运行时、执行器或通知出口。[接口契约](docs/extensions/contracts.md)
- **加入业务规则**：用 Hook 决定请求继续、等待或中断。例如，陌生群的来信可以等待本人确认，同时处理其他请求。[Hook 指南](docs/extensions/hooks.md)

[架构与路由](docs/architecture/routing.md) · [贡献指南](CONTRIBUTING.md) · [MIT 许可证](LICENSE)
