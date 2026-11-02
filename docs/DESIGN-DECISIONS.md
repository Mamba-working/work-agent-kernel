# 设计依据与取舍

## 参考基线

2026-11-03 阅读 DeepSeek 官方原型，固定参考 commit：`6337fc823ce20251c8de8085948165c81aaa701e`。

- [原型 README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/README.md)
- [领域模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/001-domain.md)
- [执行与恢复](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/003-execution.md)
- [实现架构](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/007-architecture.md)
- [Super-agent 文章](https://x.com/DeepSeekHarness/status/2116857257245987236)
- [卡兹克自动化系统文章](https://x.com/khazix0918/status/2117054043868860521)
- [Codex App Server 官方接口](https://learn.chatgpt.com/docs/app-server)

DeepSeek 自称研究原型，文章还包括未来方向。此仓库借鉴概念，独立实现小型参考内核，没有复制其源码，也不宣称是其兼容实现。

## 对照

| 上游概念 | 本项目采用 | 差异 |
| --- | --- | --- |
| Source / Trigger | Source / Event | 通用来源插件；不绑定 GitHub 或飞书机器人 |
| Thread / Subscription | SourceThread / Subscription | 保留多对多和 pass-through |
| Eval / Router | Router 接口＋运行时 schema 校验 | 原型注入确定性测试 Router，真实模型后接 |
| Ticket | WorkItem | 面向个人工作，不限定单仓库编码 |
| Executor / Assignment | Harness / Run | provider 会话与核心事项独立 |
| Mandate | scope＋固定 WorkflowProfile | 仅做最小授权范围；完整版本化授权策略后续设计 |
| Attention | Attention＋owner 回答接口 | 采集入口与通知出口分离 |
| Inline & Spill | 有界预览＋原文引用＋Recall | 未实现长期记忆、向量检索和知识自动整理 |
| Watchdog / 多端环境 | 后续阶段 | 当前只有有界 Host tick 和异常状态，不做自动修复 |

## ADR-001：TypeScript 与 Node.js 24

用户明确偏好 TypeScript；原型使用 ESM、Node 原生 TS 执行、内置 test runner、内置 SQLite 和 Zod。通过 strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes、branded ID 与可区分联合表达核心状态。

Node 24 的 node:sqlite 仍有版本稳定性边界，因此 CI 固定 24.21.0。此选择减少原型的安装步骤，不构成生产数据库实现的承诺。

## ADR-002：事项身份独立于 Session

保留 WorkItem，允许多次 Run 和显式 Harness rebind。替换 Harness 不迁移私有 transcript，只交接目标、输入引用、WorkflowProfile 和结果。这样后续接 Codex、其他 CLI 或远端 Agent 时，不需要改领域对象。

## ADR-003：智能决策与机械调度分开

Router 决定任务归属、目标和工作流。代码只验证结构、允许的 scope、实体引用并执行状态转换。工作流 profile 不是固定业务 DAG，也不在核心里按群名、关键词或场景数量写死组合。

## ADR-004：先建立单机闭环

一个 Host、一个 SQLite aggregate、显式插件。暂不引入 Temporal、消息中间件或组织管理平台。原型的收益来自证明跨来源工作连续性，不来自部署组件数量。后续若存在长时间恢复、多设备租约或吞吐需求，再迁移存储或调度实现。

## ADR-005：不把重试当成恢复

SQLite 无法和外部 Harness 提交组成一个原子事务。先记录请求，丢回执时保持 uncertain 并 lookup。无法确认就保留不确定状态。这是普通网络提交的实际边界，不实现分布式事务或假想的 exactly-once。

通知采用稳定 ID 和发件箱；重试不重复展示依赖 Sink 的幂等能力。真实渠道如不支持幂等，需要适配器明确自己的投递与对账方案。

## ADR-006：先准备结果，再谈发布

原型只产出 ready、needs_input、failed、reroute。ready 要有证据引用，但引用存在不等于证据被核实。发布、共享文档修改、代发消息的授权与交付验收必须单独实现。CI 检查的是架构契约，不能替代业务验收。

## ADR-007：插件通过可信本地 ESM 工厂接入

apiVersion 固定为 1；显式文件路径加载；边界返回数据仍校验。没有自动扫描与安装插件，没有跨租户或不可信插件沙箱。未来插件市场需要新的隔离设计，不能直接暴露当前 import 路径。
