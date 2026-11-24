# Work Agent Kernel 开发原则

框架围绕可持续跟进的工作事项设计。Router 和 Worker 解释任务，工程代码校验决定、保存状态并交付结果。

1. **先确定框架契约，再接业务。** 先看现有接口能否承载需求。平台能力放在 `src/adapters/`，业务规则放在 `src/hooks/`，应用负责注册。只有多个业务共同依赖的流程或语义需要改变时，才修改核心契约。改路由、会话归属或持久化前，先读[架构与职责](docs/architecture/overview.md)和[设计取舍](docs/architecture/decisions.md)；编写适配器前读[扩展契约](docs/extensions/contracts.md)。
2. **各入口在 AI 判断前汇合。** 主动派单和外部来信各自准备上下文与授权，通过准入后交给同一个 Router。新增入口也复用这条判断和校验链路。见[统一路由](docs/architecture/routing.md)。
3. **框架管 Hook 生命周期，业务给出规则。** 继续、等待、中断和恢复由框架执行。需要外部答复才能推进时只暂停当前请求；单纯通知时可继续，发送动作交给后台。见[业务 Hook 指南](docs/extensions/hooks.md)。

4. **Router 以 Prompt、Tool 和专用 Skill 驱动业务判断。** 业务扩展声明本轮可用的工具和指引，由 Agent 取证、解释与分配。工程代码负责授权范围、契约校验、持久化和审计。见[扩展契约](docs/extensions/contracts.md)。

## 开发与交付

- 使用 TypeScript，在外部边界用运行时 schema 校验输入并推导领域类型。默认 Codex Router 和 Worker 继承 Desktop 的模型、提供商与推理配置。
- 通过公开接口、真实 SQLite 和受控适配器验证行为。编写适配器前核对[验收要求](docs/TESTING.md)；交付前运行 `npm run check` 和 `npm run demo`，分别报告模拟与实跑证据。
- 离线测试和演示使用合成数据。真实账号、模型调用和对外通知需有本次任务的明确授权。标准入口接收结构化消息；机器专用桥接、私有路径、凭证和运行数据保存在仓库外。提交范围见[贡献指南](CONTRIBUTING.md)。
