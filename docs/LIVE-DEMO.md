# 运行真实最小 demo

这条链路接收你的主动请求，让模型决定新建或关联事项，在 Codex 原生线程生成 Markdown 草稿，并用已登录的飞书账号通知你自己。它会实际调用模型和发送消息。

## 配置本机

安装 Node 24、Codex Desktop 和已登录的 `lark-cli`。在仓库运行 `npm ci --ignore-scripts`。将 `examples/live/live.env.example` 复制到仓库外的 `~/.config/work-agent-kernel/live.env`，设为仅自己可读写。

配置模型代理的基础地址、API key、代理返回的准确模型 ID、自己的飞书 open ID，以及 Codex、飞书 CLI 和状态目录的绝对路径。基础地址以 `/v1` 结尾，适配器追加 `/responses`。不要把密钥写进命令参数、源码或 GitHub。

Router 和 Codex 使用同一个配置的模型 API。Codex 通过 Desktop 自带的 App Server 执行，保持现有 Codex home 和线程存储。该版本通过原生配置接口读取有效配置，并在子进程或线程层覆盖工具设置；不修改全局 Codex 配置文件，也没有配置订阅 token 分享。换成其他 provider 或订阅登录需要独立验收。

## 先运行模型分流验收

```bash
node --env-file="$HOME/.config/work-agent-kernel/live.env" examples/live/router-eval.ts
```

命令发起三次真实模型请求。输出应依次为 `create`、`attach`、`ignore`，且第二条关联第一条的事项。它是小样本语义验收，不代表复杂工作场景准确率。

## 启动与输入

macOS 常驻服务使用 launchd。

```bash
bash scripts/service-macos.sh install
node --env-file="$HOME/.config/work-agent-kernel/live.env" src/live/cli.ts submit \
  --thread acorn-plan \
  --text '请写一份个人工作 Agent 的试运行方案，最多500字，供我审阅。不要调用工具。'
node --env-file="$HOME/.config/work-agent-kernel/live.env" src/live/cli.ts status
```

`install` 安装并启动当前用户的 `com.mamba.work-agent-kernel` LaunchAgent。它记住当前 checkout 的绝对路径，后续不要删除或移动该 checkout。进程退出时 launchd 会重新启动它。macOS 用户未登录或设备休眠时不承诺持续执行。

状态依次出现 `queued`、`running`、`ready`。完成后检查 Markdown 产物和飞书消息。飞书消息中的本地文件路径只能在执行机器访问；Codex 线程链接用于在本机 Desktop 打开历史。飞书接收人由本机配置固定，模型不能改收件人。

补充同一事项时沿用 `--thread acorn-plan`。新讨论省略 `--thread`，由 Router 判断是否关联旧事项。重复提交命令会创建新事件，不等同于重放同一个来源事件。

## 观察、停止和续接

```bash
bash scripts/service-macos.sh status
bash scripts/service-macos.sh stop
bash scripts/service-macos.sh start
```

`status` 的 `health` 是最近一轮已完成 tick 的快照，不能单凭该文件判断进程当前仍存活。使用 launchd 状态和时间戳一起检查。错误日志不会记录 API key 或原始远端错误正文。

状态目录保存 `kernel.sqlite`、`events.jsonl`、`health.json`、服务日志、飞书回执和 `codex/artifacts`。Codex 的 transcript 仍由原生运行时保存。API 网络调用和 RPC 均有超时。launchd 只监控进程退出，没有监控“模型是否在有效推进任务”。

如收到 `needs_input`，先停止服务，读取 `status` 中的 attention ID 和选项，再回答。

```bash
node src/cli.ts answer --db /absolute/state/kernel.sqlite \
  --attention attention-ID --choice '实际选项'
bash scripts/service-macos.sh start
```

这仍是本机拥有者命令，不是飞书按钮回调。不要同时启动两个总控指向同一状态目录。

## Codex 的执行边界

Adapter 创建或续接原生线程，提交回合后保存 ID，再读取该回合的终态。模型返回的真实 Markdown 会保存为产物。仅 `prepare` 可执行，使用原生只读沙箱，关闭该线程的 MCP、应用、插件和相关扩展工具；不会修改全局配置。它适合准备草稿，不承诺不可信输入的强隔离。

同一事项复用线程；不同事项创建独立线程。Desktop 原生线程可通过 `codex://threads/<ID>` 打开。运行中不要同时从 Desktop 向该线程发消息，先停止总控再接管。两个 App Server 争抢线程时可能触发原生单写入者冲突。这里没有实现透明双向接管。

进程重启后可以读取已完成结果和继续下一回合。活动回合可能被中断。丢失提交回执时，只在原生历史中找到唯一请求标记才恢复 receipt；否则保留 `uncertain`，不会自动重新执行。当前没有对不确定事项的管理 UI。

## 接入其他输入与 Harness

`src/live/service.ts` 是本机的组合入口。替换其中的 `Source` 实例即可接入实际采集插件，保留 `fetch(cursor)` 和事件契约。真实飞书用户消息采集仍未实现。

实现 `Harness.submit / lookup / poll`，在 `harnesses` 注册新名称即可让 Router 选择其他执行器。Claude Code 尚无适配器。模型只选择已注册的名称和允许的 scope。

更换通知出口需实现 `NotificationSink.deliver`。目前 LarkOwnerSink 保存远端回执，并用稳定通知 ID 派生飞书幂等键。远端去重时间窗口由飞书负责，不能保证无限期的跨系统 exactly-once。

Linux 可前台运行 `node --env-file=... src/live/cli.ts serve`。本仓库尚未提供或验收 systemd 安装脚本。
