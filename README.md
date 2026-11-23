# Work Agent Kernel

用于持续工作事项的本地 TypeScript 框架。应用可以主动提交任务，也可以从外部来源接收消息。Router 判断要新建、续接还是忽略；内核保存决定、执行进度和结果。默认 Router 应用接入飞书和 Codex，Desktop 插件提供派单、消息流和项目视图。

## 代码放在哪里

| 目录 | 职责 |
| --- | --- |
| [src/core](src/core/) | 项目与事项、路由、执行和持久化。公共类型和应用工厂从 [index.ts](src/core/index.ts) 导出 |
| [src/core/hooks](src/core/hooks/) | 框架的 Hook 生命周期，负责继续、暂停、中断、恢复和后台动作投递 |
| [src/adapters](src/adapters/) | 与外部系统通信。Codex 提供推理和执行，飞书提供消息、卡片与回调，另有文件输入、本地收件箱和 Responses 适配器 |
| [src/hooks](src/hooks/) | 可注册的业务规则。内置示例有飞书会话准入和可选的完成通知 |
| [src/router](src/router/) | 默认应用。配置项目、选择适配器、注册 Hook、启动服务 |
| [plugins/router-inbox](plugins/router-inbox/) | Codex Desktop 插件源码、清单、构建和安装命令 |
| [examples](examples/) · [test](test/) | 可运行示例、测试替身和自动化回归 |

依赖方向由自动化测试检查。框架只依赖自己的模块和基础库；具体适配器实现框架契约；业务 Hook 可以调用适配器；应用负责把它们装在一起。

## 本地试跑

使用 Node.js 24。离线演示使用临时 SQLite 数据库和模拟执行器。

```sh
npm ci --ignore-scripts
npm run check
npm run demo
node examples/lifecycle/demo.ts
```

[Router 配置与启动](docs/ROUTER.md) · [Desktop 插件安装](plugins/router-inbox/README.md) · [架构图](docs/architecture/routing.md)

## 接入自己的能力

- **增加消息来源或执行器**：实现 Source 或 Harness，在 createRouterApplication 中注册。执行器提供提交、按请求 ID 查回执、按运行 ID 取结果三项能力。[接口契约](docs/extensions/contracts.md)
- **增加业务规则**：实现 LifecycleHook，选择 beforeRoute 或 beforeNotify。需要人决定时可以等待回调。默认应用还支持通过 ROUTER_HOOKS_FILE 加载可信的本地规则模块。[业务 Hook 指南](docs/extensions/hooks.md)
- **修改实例的组合**：在应用入口选择推理运行时、资料读取器、执行器和通知出口。默认应用继承 Codex Desktop 的模型、提供商和推理配置。[默认装配](src/router/service.ts)

一个状态目录由一个 Host 管理。自动执行使用只读准备范围，操作外部平台需要部署方显式配置。开发与发布约定见 [CONTRIBUTING](CONTRIBUTING.md)。源码使用 [MIT 许可证](LICENSE)。
