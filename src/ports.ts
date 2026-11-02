import type { EventKey, Notice, Receipt, Report, Route, Scope, WorkItem, WorkRequest, Workflow } from './domain.ts';

/** Plugins are trusted host code. Their returned data is parsed at the boundary. */
export interface Source {
  readonly name: string;
  fetch(cursor: string | null): Promise<unknown>;
}
export interface Recall {
  event(key: EventKey): { text: string; uri: string };
  work(id: WorkItem['id']): WorkItem;
  listWorks(): WorkItem[];
}
export interface RouteContext {
  event: { key: EventKey; source: string; thread: string; actor: string; text: string; uri: string; truncated: boolean };
  candidates: Pick<WorkItem, 'id' | 'goal' | 'execution' | 'harness' | 'scope'>[];
  hasMoreCandidates: boolean;
  workflows: Workflow[];
  harnesses: string[];
  allowedScopes: Scope[];
}
export interface Router {
  decide(context: RouteContext, recall: Recall): Promise<unknown>;
}
export interface Harness {
  /** Same requestId must not start two runs. Return after admission, not completion. */
  submit(request: WorkRequest): Promise<unknown>;
  /** null = unknown. Never treat this as proof that replay is safe. */
  lookup(requestId: WorkRequest['requestId']): Promise<unknown | null>;
  /** null = still running; otherwise a terminal Report. */
  poll(runId: string): Promise<unknown | null>;
}
export interface NotificationSink {
  /** Stable notice.id is an idempotency key. Delivery is to owner, not event actor. */
  deliver(notice: Notice): Promise<string>;
}
export interface Plugins {
  apiVersion: 1;
  sources: Source[];
  router: Router;
  harnesses: Record<string, Harness>;
  sinks: Record<string, NotificationSink>;
  workflows?: Workflow[];
}
// Convenient export surface for plugin authors; domain schemas own wire validation.
export type { Notice, Receipt, Report, Route, WorkRequest, Workflow };
