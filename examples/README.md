# 示例入口

| 层级 | 目录 | 用途 |
| --- | --- | --- |
| 推荐应用 | [feishu-codex](feishu-codex/README.md) | 用公开包入口创建 Application，显式注册飞书、Codex 和业务扩展 |
| 推荐应用 | [lifecycle](lifecycle/demo.ts) | 用 start、submit、routed、done、resume 演示等待和恢复 |
| 底层原语 | [kernel](primitives/kernel/demo.ts)、[custom-plugin](primitives/custom-plugin.ts)、[file-replay](primitives/file-replay/demo.ts)、[local-decision](primitives/local-decision/demo.ts)、[offline-loop](primitives/offline-loop/demo.ts) | 直接操作 Kernel / Host，用于理解底层状态转换 |
| 低层真实服务示例 | [live](primitives/live/service.ts) | 文件输入、Responses、Codex 和飞书通知的组合；保留显式 Host 驱动以便对照 |
| 验收 | [router-eval](router-eval/) | 隔离数据的真实模型验收 |
| 示例辅助代码 | [support](support/) | 可控来源、执行器和收件箱 |

源码检出后执行 `npm run build` 生成公共 ESM 入口和类型声明。Desktop 插件单独构建于 `plugins/router-inbox/`。两处 dist 都由构建生成。
