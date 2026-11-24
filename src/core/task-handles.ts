import type { DispatchRun, DispatchStore } from './dispatch/store.ts';
import type { Run, State, Report, Attention } from './domain.ts';

export type WorkEvent = 'work.completed' | 'work.failed' | 'work.needs_input';
export type WorkChange = Run & { attention?: Attention };
export interface TaskResult {
  dispatch: DispatchRun;
  outcomes: { workId: string; runId: string | null; report: { kind: 'ignored' | 'stopped' } | Report }[];
}
export interface TaskHandle {
  id: string;
  routed: Promise<DispatchRun>;
  done: Promise<TaskResult>;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  const result = { promise, resolve, reject };
  // Either promise can be consumed independently.
  void result.promise.catch(() => {});
  return result;
}
function terminalEvent(run: Run): WorkEvent | undefined {
  if (!('report' in run.state)) return;
  switch (run.state.report.kind) {
    case 'needs_input':
      return 'work.needs_input';
    case 'ready':
      return 'work.completed';
    case 'failed':
      return 'work.failed';
  }
}

// Match the specific owner input revision. An unrelated later turn on the same work cannot finish this task.
function resultFor(dispatch: DispatchRun, state: State): TaskResult | undefined {
  const outcomes: TaskResult['outcomes'] = [];
  const runs = Object.values(state.runs);
  for (const [i, workId] of dispatch.workIds.entries()) {
    const key = JSON.stringify(['owner', dispatch.id + '/' + i, '1']);
    let attentionRun: string | undefined;
    let finished = false;
    for (const run of runs) {
      const matches = attentionRun
        ? run.request.decisions.some((a) => a.runId === attentionRun)
        : run.request.inputs.some((input) => input.key === key);
      if (!matches || !('report' in run.state)) continue;
      const report = run.state.report;
      if (report.kind === 'needs_input') {
        attentionRun = run.id;
        continue;
      }
      if (report.kind === 'reroute') {
        attentionRun = undefined;
        continue;
      }
      outcomes.push({ workId: run.workId, runId: run.id, report });
      finished = true;
      break;
    }
    if (!finished) {
      const disposition = state.events[key]?.disposition;
      if (disposition !== 'ignored' && disposition !== 'stopped') return;
      outcomes.push({ workId, runId: null, report: { kind: disposition } });
    }
  }
  return { dispatch, outcomes };
}

export class TaskObservers {
  private readonly waiting = new Map<
    string,
    { routed: ReturnType<typeof deferred<DispatchRun>>; done: ReturnType<typeof deferred<TaskResult>> }
  >();
  private readonly published: Set<string>;
  private readonly listeners = new Map<WorkEvent, Set<(run: WorkChange) => void>>();
  constructor(state: State) {
    this.published = new Set(
      Object.values(state.runs)
        .filter(terminalEvent)
        .map((r) => r.id),
    );
  }
  on(event: WorkEvent, listener: (run: WorkChange) => void) {
    const group = this.listeners.get(event) ?? new Set();
    this.listeners.set(event, group);
    group.add(listener);
    return () => {
      group.delete(listener);
    };
  }
  attach(job: DispatchRun, state: State): TaskHandle {
    const waiter = this.waiting.get(job.id) ?? {
      routed: deferred<DispatchRun>(),
      done: deferred<TaskResult>(),
    };
    this.waiting.set(job.id, waiter);
    this.settle(job, state);
    return { id: job.id, routed: waiter.routed.promise, done: waiter.done.promise };
  }
  private settle(job: DispatchRun, state: State) {
    const w = this.waiting.get(job.id)!;
    if (job.status === 'failed' || job.status === 'stopped') {
      const error = Error(job.error ?? job.status);
      w.routed.reject(error);
      w.done.reject(error);
      this.waiting.delete(job.id);
    } else if (job.status === 'done') {
      w.routed.resolve(job);
      const result = resultFor(job, state);
      if (result) {
        w.done.resolve(result);
        this.waiting.delete(job.id);
      }
    }
  }
  refresh(store: DispatchStore, state: State) {
    for (const id of this.waiting.keys()) this.settle(store.get(id), state);
    for (const run of Object.values(state.runs)) {
      const event = terminalEvent(run);
      if (!event || this.published.has(run.id)) continue;
      this.published.add(run.id);
      const attention =
        event === 'work.needs_input'
          ? Object.values(state.attentions).find((a) => a.runId === run.id)
          : undefined;
      const change = attention ? { ...run, attention } : run;
      for (const listener of this.listeners.get(event) ?? []) {
        try {
          void Promise.resolve(listener(change)).catch((error) => process.emitWarning(String(error)));
        } catch (error) {
          process.emitWarning(String(error));
        }
      }
    }
  }
  detach() {
    const error = Error('Application stopped; reopen the task by id to continue waiting');
    for (const w of this.waiting.values()) {
      w.routed.reject(error);
      w.done.reject(error);
    }
    this.waiting.clear();
  }
}
