import { settle, type Prepared } from '../stage.ts';
import { factContext } from '../hooks/lifecycle.ts';
import type { Lifecycle } from '../hooks/lifecycle.ts';
import type { Kernel } from '../kernel.ts';
import type { Catalog, PlanningRequest } from '../planning/contracts.ts';
import { RouterBot, routesFor } from '../planning/router.ts';
import { candidates } from '../planning/requests.ts';
import { DispatchStore } from './store.ts';

export async function processDispatch(...args: Parameters<typeof prepareDispatch>) {
  return settle(prepareDispatch(...args));
}

export function prepareDispatch(
  store: DispatchStore,
  kernel: Kernel,
  catalog: Catalog,
  bot: RouterBot,
  signal: AbortSignal,
  boundProject: (sourceId: string) => string | null,
  hooks?: Lifecycle,
  actionLimit: (description: string) => number = () => 12,
  progress: (save: () => void) => void = (save) => save(),
): Prepared<boolean> {
  const job = store.next((id) => hooks?.runnable('owner', id) ?? false);
  if (!job) return false;
  const log = (text: string) => {
    job.steps.push(text);
    store.save(job);
  };
  const fail = (error: unknown) => {
    if (signal.aborted) return false;
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : '主动派发失败';
    store.save(job);
    return true;
  };
  const apply = () => {
    const result = job.result!;
    const decisions = routesFor(result, catalog, null);
    const items = result.actions.map((a, i) => {
      const id = job.id + '/' + i;
      const references = a.evidence
        .map((e) => job.refs.find((r) => r.id === e))
        .filter((r) => !!r)
        .map((r) => r.chat + ' ' + (r.url || r.id));
      return {
        event: {
          source: 'owner',
          externalId: id,
          revision: '1',
          thread: id,
          actor: '本人',
          text: [a.goal, ...references].join('\n'),
          uri: 'router://dispatch/' + job.id,
          occurredAt: job.created,
        },
        decision: decisions[i]!,
      };
    });
    job.workIds = kernel.applyOwnerPlan(items);
    job.status = 'done';
    log(job.workIds.length ? '已派发 ' + job.workIds.length + ' 个事项' : '分析完成');

    return true;
  };
  try {
    if (job.status !== 'planned') {
      const gate = hooks?.advance({
        phase: 'beforeRoute',
        kind: 'owner',
        id: job.id,
        description: job.description,
        sources: job.sources,
      });
      if (gate && gate.status !== 'ready') {
        job.status =
          gate.status === 'break' ? 'stopped' : gate.status === 'wait' ? 'waiting_hook' : 'hook_failed';
        log(gate.reason);
        return true;
      }
      job.status = 'running';
      log('Router 开始分析任务');
      const request: PlanningRequest = {
        id: job.id,
        origin: { kind: 'owner', actor: '本人', uri: 'router://dispatch/' + job.id },
        description: job.description,
        created: job.created,
        sources: job.sources,
        context: factContext(gate?.facts ?? {}),
        projects: catalog.projects.map((p) => ({
          id: p.id,
          name: p.name,
          selectedSourceIds: job.sources.filter((s) => boundProject(s.id) === p.id).map((s) => s.id),
        })),
        candidates: candidates(kernel.works(), catalog),
        defaultProject: null,
        maxActions: actionLimit(job.description),
      };
      return bot
        .plan(request, signal, (text) => {
          job.steps.push(text);
          progress(() => {
            if (job.status === 'running') store.save(job);
          });
        })
        .then(
          ({ report, refs }) =>
            () => {
              try {
                job.result = report;
                job.refs = refs;
                job.status = 'planned';
                store.save(job);
                return apply();
              } catch (error) {
                return fail(error);
              }
            },
          (error) => () => fail(error),
        );
    }
    return apply();
  } catch (error) {
    return fail(error);
  }
}
