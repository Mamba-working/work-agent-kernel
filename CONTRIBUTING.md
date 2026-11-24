# 开发与验证

1. 阅读 README，确认本次任务属于原型修改还是某一项真实接入。
2. 涉及领域和接口变更时，先更新架构或契约，并明确代码与模型各自负责什么。
3. 对新增行为先补一个失败场景，再实现最小修改。通过公开接口测行为，持久化用真实临时 SQLite，外部服务用受控适配器。
4. 运行 `npm run check`、`npm run demo`，以及改动对应的真实验收（若已授权并实现）。
5. PR 说明写清行为变化、验证结果和仍未覆盖的边界。

新增 Harness 不能通过替换全局认证或复用另一个 provider 的私有 Session ID 达成“兼容”。新增来源不能把群聊机器人事件当作本人私聊。新增推送不能自动发送到来源中的其他人。

依赖保持精简。用 `npm ci --ignore-scripts` 按锁文件安装。状态文件和账号凭证不入库。全程使用合成数据示例；真实回放需要脱敏和明确授权。

## 提交内容

示例使用合成数据。提交源码、依赖锁、测试、许可和文档实际引用的素材。构建插件所产生的 dist 含本机路径，应由安装者在本机构建。验收日志、SQLite、环境文件、截图草稿、发布压缩包和私人消息桥接代码留在发布树外。

## 合入 main 与发布 npm

发布由 .github/workflows/publish.yml 驱动。main 发布 package.json 指定的稳定版至 latest；alpha 和 beta 分别发布 x.y.z-alpha.<run_number> 与 x.y.z-beta.<run_number> 到同名 dist-tag。发布下一系列前先更新基础版本。相同版本重跑会跳过已发布版本，普通功能分支和 PR 不发布。发布前需通过 macOS、Ubuntu 测试，发布后从公共 registry 安装并检查入口。首发可在 Actions secret NPM_TOKEN 配置有发布权限的 granular token；后续可在 npm 将本仓库的 publish.yml 配置为允许直接发布的 trusted publisher。

Git 忽略所有层级的 `dist/` 和 `node_modules/`。根包的 npm 文件白名单单独包含构建后的 `dist/`。Core 自身抛出的异常使用英文开发者文案；Router 的 `language` 控制模型指引，面向用户的翻译由应用或适配器负责。
