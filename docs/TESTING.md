# 验证计划与当前证据

## 可复现命令

```bash
npm ci --ignore-scripts
npm run check
npm run demo
```

`check` 先严格类型检查，再运行 Node 原生测试。测试使用独立临时目录、真实 SQLite 和受控外部适配器；不读取个人账号或项目资料。`test/types.ts` 还包含 compile-only 反例，确保不同 ID 与不完整报告不能通过类型检查。

## 场景矩阵

| 场景 | 对应测试 | 证明范围 |
| --- | --- | --- |
| 重启后去重、保留修改和补充 | ingestion.test.ts | 同 source＋ID＋revision；不含跨接口 ID 映射 |
| 来源批次与游标一致、错误来源不污染数据 | routing.test.ts | 来源插件合同；不含飞书搜索索引延迟 |
| 新建、跨来源关联、直达、多订阅者 | routing.test.ts | 决策执行；不含真实模型判断准确率 |
| 摘要限长与完整原文读取 | routing.test.ts | 引用可回查；不含语义检索质量 |
| 内核重开后原 Session 延续 | execution.test.ts | 外部模拟 Harness 仍存活的恢复 |
| 同事项串行、不同事项独立 | execution.test.ts | 单 Host 内的运行归属；不是多进程压力测试 |
| 两种 Harness 交接 | execution.test.ts | 两个独立测试适配器、不同 ID 格式；不含真实模型兼容性 |
| submit 丢回执、无法确认时不重放 | execution.test.ts | 有状态外部 double；真实适配器仍需专项测试 |
| 需要证据才可 ready | execution.test.ts | 格式要求；不证明证据真实性 |
| WorkflowProfile 版本固定 | execution.test.ts | 更新配置不改变已有事项 |
| 个人回答、重复回调、冒充与过期通知 | attention.test.ts | 已认证 actor 的接口约束；不实现 OAuth／回调验签 |
| 稳定通知 ID、恢复投递、SQLite 收件箱 | attention.test.ts | 幂等 Sink 合同，不保证所有消息平台 exactly-once |
| 外部 ESM 插件、版本校验、来源故障隔离 | plugins.test.ts | 真正通过独立模块接入；插件本身仍是可信代码 |
| 跨来源 → 待决 → 重启 → 继续 → 换 Harness | demo.test.ts | 原型整体闭环 |

本地首版为 36 个行为测试，实际数量以 test runner 输出为准。GitHub Actions 在 Linux 和 macOS 上执行同样的 check、demo 与外部插件示例。

## 后续真实接入的验收门槛

### 个人飞书来源

- 使用本人身份读取真实群 @、人对人私聊、文档通知；机器人聊天不能替代。
- 对照客户端记录，核对事件覆盖、分页、延迟、编辑、断线补采。
- 明确客户端 ID 与 OpenAPI ID 的映射；未确认的跨来源重复不得悄悄合并。
- 主动输入和同事消息形成同一工作事项的证据可回查。

### 模型 Router

- 回放经授权且脱敏的消息序列，覆盖新任务、补充、跨渠道关联、无关信息、范围变化。
- 同时测误建事项、错误关联、漏事件和不必要打扰；不要只测 JSON 合法率。
- 模型不能从来源文字获得扩大执行权限或代替 owner 回答的能力。

### Codex／第二种 Harness

- 实际提交、恢复、失败和 lookup；模拟提交前断线与接单后丢 ACK。
- 真实同一 Session 多轮运行；执行中补充先入队；取消与 steering 在实现 capability 后独立验收。
- 从客户端看见对应 Session，并验证人机接管；文件落盘不是 UI 验收。
- 用真实请求确认订阅／模型权限，模型列表不是可用性证据。

### 通知与决策

- 接收卡片或应用通知，点击后原事项继续；回调重复不产生第二次执行。
- 已解决问题不重新发问，错误身份不改变事项；明确已发送、已送达、已读的区别。

### 持久工作上下文

- 先在 A 事项作出决定，重启并新建 B 事项；能查到对应决定、范围、时间和原文。
- 新决定替换旧决定时，旧事实保留但不再当作当前约束。

以上均为待实施验收；当前没有跑过真实飞书、真实模型或真实 Harness 闭环。
