# Router 接入记录 · Codex Desktop 插件

在 Desktop 的「接入记录」查看消息、项目归属、路由依据与执行结果。项目页按归档时的项目筛选消息；有工作会话的事项可以跳回相应的本地 Codex 聊天。

## 安装到本机

需要 Node.js 24、npm、可用的 Codex CLI 和支持 MCP App 的 Codex Desktop。请保留用于安装的仓库目录。在仓库根目录执行：

```sh
npm ci
npm --prefix plugins/router-inbox ci
npm --prefix plugins/router-inbox run install:codex
```

安装器会在本机构建页面与 stdio MCP 服务，注册本地插件市场，安装 router-inbox，并显式注册同名 MCP 服务，供侧边栏入口使用。如果之前手动安装过同名 MCP 服务，此命令会把它指向新构建产物。生成的机器路径仅保存在本机 dist 和 Codex 配置中。打开插件后可点「刷新」重新读取记录。跳回会话目前支持 macOS 上可由 Desktop 访问的本地会话。

## 接入数据

插件默认读取 `~/.local/state/router-inbox`。要导入第一条模拟消息，在仓库根目录执行：

```sh
printf '%s' '{"message_id":"demo-1","chat_id":"demo-group","sender":"演示","content":"请整理上线检查清单"}' | node src/router/cli.ts ingest
```

要让 Router 实际派单，在另一个终端运行 `node src/router/cli.ts serve`。此步骤会通过当前 Codex 配置调用模型，执行结果写入本机。若自定义 `ROUTER_INBOX_DIR`，请让服务和插件 MCP 进程获得相同的环境变量。项目配置和上下文规则见[Router 业务说明](../../docs/ROUTER.md)。

## 验证和卸载

使用 `npm --prefix plugins/router-inbox test` 可验证打包后的页面资源、标准收件箱读取、项目归属及无效会话处理。测试只使用临时目录和合成数据。

```sh
codex plugin remove router-inbox@work-agent-kernel
codex mcp remove router-inbox
codex plugin marketplace remove work-agent-kernel
```
