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
- `done` 按本次请求的输入版本关联各轮执行。多项派发等待全部结果，worker 失败体现在对应的 report 中。需要人回答时保持 pending，界面可用 `app.answer({ attentionId, choice, actor })` 提交授权答复。执行结束与通知投递是两个独立状态。
- `app.on('work.completed' | 'work.failed' | 'work.needs_input', listener)` 订阅当前进程观察到的已落库运行结果，返回取消订阅函数。历史事件不重播。服务重开后，用原请求编号 `app.task(id)` 重新取得等待句柄，已完成的提交可以直接取回结果。
- `stop()` 取消规划，解绑监听，排空在途结算，结束本进程内尚未兑现的等待。外部 worker 与 SQLite 记录保留；可以在外部 signal 仍有效时再次 start。`close()` 同时关闭数据库。测试可以完全不 start，提交后逐次 `await app.step()`；自动模式与手动模式互斥。

## 适配器与跨进程通知

Source 与 Harness 可实现 `subscribe(wake): unsubscribe`。新输入或 worker 结果可读时调用 `wake()`。通知可以合并；应用仍通过 `fetch`、`poll` 获取事实。Codex 的 `turn/completed` 会唤醒观察。一个服务进程拥有内核，外部生产者只提交输入。

Desktop 插件先向 dispatch.sqlite 提交，再写同一目录的唤醒文件。应用通过文件监听立即推进；服务离线也可排队。启动时先订阅再对账。服务被杀在 worker 已接单、内核尚未登记回执的窗口时，通过原 requestId 调用 lookup；回执无法确认时保留待核对运行。应用不会据此重复下单。

同一时刻最多一个 Host 结算、一个 Router 规划、一个 Hook 投递在途。规划等待外部模型时，worker 完成和人工回答仍可被结算。仅拉取的来源或活跃执行器默认每两秒检查；支持通知时默认三十秒兜底对账，亦可用 `scheduling.reconcileMs` 指定。已知的 Hook 重试期限可提前唤醒。定时器只由自动模式建立。

## 验收入口

[test/application-driver.test.ts](../test/application-driver.test.ts) 覆盖手动推进、推送、纯拉取、多事项、续接与等待人工时的恢复。打包插件的 [MCP 集成测试](../plugins/router-inbox/test/inbox.test.mjs) 从另一进程向已休眠的应用提交，再在 worker 接单后强制杀掉服务；重开后检查 submit 次数、lookup 以及重新取得的 done 结果。
