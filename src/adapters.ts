import { DatabaseSync } from 'node:sqlite';
import { EventSchema, NoticeSchema } from './domain.ts';
import type { Event, Notice, Receipt, RunId, WorkRequest } from './domain.ts';
import type { Harness, NotificationSink, Recall, RouteContext, Router, Source } from './ports.ts';

/** Synthetic source for tests and proactive owner input; not a Feishu connector. */
export class ManualSource implements Source {
  readonly name: string;
  readonly events: Event[];
  constructor(name: string, events: unknown[]) { this.name = name; this.events = events.map(e => EventSchema.parse(e)); }
  async fetch(cursor: string | null): Promise<unknown> {
    const offset = Number(cursor ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.events.length) throw new Error('Invalid source cursor');
    return { events: this.events.slice(offset), cursor: String(this.events.length) };
  }
}
/** Explicitly scripted decisions. This does not demonstrate semantic intelligence. */
export class ScriptedRouter implements Router {
  readonly decisions: unknown[];
  readonly contexts: RouteContext[] = [];
  constructor(decisions: unknown[]) { this.decisions = [...decisions]; }
  async decide(context: RouteContext, _recall: Recall): Promise<unknown> {
    this.contexts.push(structuredClone(context));
    if (!this.decisions.length) throw new Error('No scripted routing decision');
    return this.decisions.shift();
  }
}
/** Controllable external-runtime double. Kernel restart does not restart this object. */
export class RecordingHarness implements Harness {
  readonly name: string;
  readonly requests: WorkRequest[] = [];
  readonly #receipts = new Map<RunId, Receipt>();
  readonly #reports = new Map<string, unknown>();
  loseNextAck = false;
  constructor(name: string) { this.name = name; }
  async submit(request: WorkRequest): Promise<Receipt> {
    const previous = this.#receipts.get(request.requestId);
    if (previous) return previous;
    this.requests.push(structuredClone(request));
    const receipt = { sessionId: request.sessionId ?? `${this.name}/session/${request.workId}`, runId: `${this.name}/run/${request.requestId}` };
    this.#receipts.set(request.requestId, receipt);
    if (this.loseNextAck) { this.loseNextAck = false; throw new Error('Admission ACK lost'); }
    return receipt;
  }
  async lookup(id: RunId): Promise<Receipt | null> { return this.#receipts.get(id) ?? null; }
  async poll(runId: string): Promise<unknown | null> { return this.#reports.get(runId) ?? null; }
  complete(runId: string, report: unknown): void { this.#reports.set(runId, report); }
}
/** Independent adapter with different ID format and immediate synthetic completion. */
export class EchoHarness implements Harness {
  readonly #accepted = new Map<string, WorkRequest>();
  async submit(request: WorkRequest): Promise<Receipt> {
    this.#accepted.set(request.requestId, this.#accepted.get(request.requestId) ?? structuredClone(request));
    return { sessionId: request.sessionId ?? `echo:${request.workId}`, runId: request.requestId };
  }
  async lookup(id: RunId): Promise<Receipt | null> {
    const request = this.#accepted.get(id);
    return request ? this.submit(request) : null;
  }
  async poll(id: string): Promise<unknown> {
    const request = this.#accepted.get(id);
    if (!request) throw new Error('Unknown echo run');
    return { kind: 'ready', summary: `Prototype echo: ${request.goal}`, evidence: [`prototype://echo/${id}`] };
  }
}
export class MemorySink implements NotificationSink {
  readonly messages = new Map<string, Notice>();
  loseNextAck = false;
  async deliver(notice: Notice): Promise<string> {
    if (!this.messages.has(notice.id)) this.messages.set(notice.id, structuredClone(notice));
    if (this.loseNextAck) { this.loseNextAck = false; throw new Error('Delivery ACK lost'); }
    return `memory:${notice.id}`;
  }
}
/** Actual durable local output, not a remote messaging integration. */
export class SqliteInbox implements NotificationSink {
  readonly #db: DatabaseSync;
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
  }
  async deliver(notice: Notice): Promise<string> {
    this.#db.prepare('INSERT OR IGNORE INTO notices VALUES (?, ?)').run(notice.id, JSON.stringify(notice));
    return `inbox:${notice.id}`;
  }
  messages(): Notice[] {
    return this.#db.prepare('SELECT body FROM notices ORDER BY rowid').all().map(row => {
      if (typeof row.body !== 'string') throw new Error('Invalid stored notice');
      return NoticeSchema.parse(JSON.parse(row.body));
    });
  }
  close(): void { this.#db.close(); }
}
