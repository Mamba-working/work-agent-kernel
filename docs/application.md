# Application 的运行与等待接口

服务创建应用后调用 `start()`。应用订阅适配器通知，首次启动即读取持久化队列和已有运行，之后由提交、回调或对账截止时间唤醒。生产入口无需驱动 `host.tick()` 或 `processNextDispatch()`。

```ts
const app = createRouterApplication(config);
const off = app.on('work.needs_input', ({ attention }) => {
  if (attention) showQuestion(attention); // 应用自己的界面
});
app.start();

try {
  const task = app.submit({ id: crypto.randomUUID(), description, sources: [] });
  const plan = await task.routed;       // 已经持久化分配，含 result 和 workIds
  const result = await task.done;       // 本次输入产生的各项最终结果
  console.log(plan.workIds, result.outcomes);
} finally {
  off();
  await app.stop();
  await app.close();
}
```

- `routed` 在计划实际提交后兑现。路由失败、准入中断会拒绝两个等待。Router 直接回答时，`done` 也会兑现，`outcomes` 为空。
- `done` 按本次请求的输入版本关联各轮执行。多项派发等待全部结果，worker 失败体现在对应的 report 中。需要人回答时保持 pending，界面可用 `await app.answer({ attentionId, choice, actor })` 提交授权答复。执行结束与通知投递是两个独立状态。
- `app.on('work.completed' | 'work.failed' | 'work.needs_input', listener)` 订阅当前进程观察到的已落库运行结果，返回取消订阅函数。它是本进程的即时视图，无持久订阅、投递回执或历史重播；即使 beforeNotify 中断通知，已落库的执行结果仍会触发其监听器。要可靠通知业务方，请注册 NotificationSink，使用 beforeNotify、持久化 outbox 与幂等投递回执。服务重开后，用原请求编号 `app.task(id)` 重新取得等待句柄，已完成的提交可以直接取回结果。
- `stop()` 取消规划，解绑监听，排空在途结算，以公开的 `ApplicationStoppedError` 拒绝本进程内尚未兑现的 routed 和 done，可用 `instanceof ApplicationStoppedError` 识别并在重连后调用 task(id)。外部 worker 与 SQLite 记录保留；可以在外部 signal 仍有效时再次 start。`close()` 同时关闭数据库。测试可以完全不 start，提交后逐次 `await app.step()`；自动模式与手动模式互斥。

## 适配器与跨进程通知

Source 与 Harness 可实现 `subscribe(wake): unsubscribe`。新输入或 worker 结果可读时调用 `wake()`。通知可以合并；应用仍通过 `fetch`、`poll` 获取事实。Codex 的 `turn/completed` 会唤醒观察。一个服务进程拥有内核，外部生产者只提交输入。

Desktop 插件先向 dispatch.sqlite 提交，再写同一目录的唤醒文件。应用通过文件监听立即推进；服务离线也可排队。启动时先订阅再对账。服务被杀在 worker 已接单、内核尚未登记回执的窗口时，通过原 requestId 调用 lookup；回执无法确认时保留待核对运行。应用不会据此重复下单。

手动与自动推进使用同一阶段顺序：收件与观察已有执行 → 路由（每轮最多 20 次，主动与被动交替取件）→ 在可用执行槽内派发 → 结果通知与 Hook effect 结算。手动 step 等待本轮外部规划；自动模式可以挂起外部 I/O，只把完成结果放回调度器，在下一次相应阶段串行提交。规划等待外部模型时，worker 完成和人工回答仍可被结算。仅拉取的来源或活跃执行器默认每两秒检查；支持通知时默认三十秒兜底对账，亦可用 `scheduling.reconcileMs` 指定。已知的 Hook 重试期限可提前唤醒。定时器只由自动模式建立。

## 验收入口

[test/application-driver.test.ts](../test/application-driver.test.ts) 覆盖手动推进、推送、纯拉取、多事项、续接与等待人工时的恢复。打包插件的 [MCP 集成测试](../plugins/router-inbox/test/inbox.test.mjs) 从另一进程向已休眠的应用提交，再在 worker 接单后强制杀掉服务；重开后检查 submit 次数、lookup 以及重新取得的 done 结果。

## 应用命令与查询

使用 `app.getEvent(key)`、`app.getWork(id)` 和 `app.getNotice(id)` 读取单条记录（找不到时返回 undefined），用 `app.listWorks()` 与 `app.listAttentions()` 获取按实体分组的列表，`app.getDispatch(id)` 查询派发，`app.hookStatus(kind, id)` 查询断点。
`await app.ingest(event)`、`await app.answer(answer)`、`await app.rebind(workId, harness)`、`await app.resume(ticket, decision)` 与 `await app.retryHook(kind, id)` 在调度边界执行并唤醒服务。运行时通过 `await app.setHarness(name, adapter)` 更换适配器，传 undefined 移除；仍持有执行中或待核对运行的执行器须先结算。只有显式的手动测试工厂暴露原始 host、kernel、dispatch 和单队列推进入口。

飞书示例中的项目登记使用独立的 projects.wake，监听建立后先恢复未完成的登记。审批卡更新由收件信号、卡片提交、监听就绪及到期重试驱动。onCycle 只发布服务健康状态。


### 登记项目目标

```ts
const workIds = await app.registerProjectTarget({
  target: { id: 'hotel', name: '酒店卡片', harness: 'codex/hotel' },
  adapter: hotelWorker,
  sessions: [{ id: sessionId, title: '组件扩充' }],
});
```

应用复制启动 catalog，在同一个调度命令内校验目标、事务性登记全部会话、发布执行器与项目。相同目标与会话可以重复登记；同 ID、同执行器允许更新名称或补充会话。替换执行器或迁移项目需显式处理。用 `app.listProjectTargets()` 读取副本。执行器对象与 catalog 属于当前应用实例，宿主在重启时从自己的项目配置恢复；飞书示例由 ProjectRegistry 承担该职责。
