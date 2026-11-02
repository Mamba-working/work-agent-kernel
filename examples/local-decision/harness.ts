import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ReceiptSchema, ReportSchema, RequestSchema } from '../../src/domain.ts';
import type { Receipt, Report, WorkRequest } from '../../src/domain.ts';
import type { Harness } from '../../src/ports.ts';

const acceptedRunSchema = z.strictObject({ request: RequestSchema, receipt: ReceiptSchema, report: ReportSchema });
type AcceptedRun = z.infer<typeof acceptedRunSchema>;
const rowSchema = z.object({ body: z.string() });

function readRun(row: unknown): AcceptedRun {
  return acceptedRunSchema.parse(JSON.parse(rowSchema.parse(row).body));
}

/** Offline provider fixture. Reports are synthetic and no model or account is contacted. */
export class DurableDemoHarness implements Harness {
  readonly #directory: string;
  constructor(options: { directory: string }) { this.#directory = resolve(options.directory); }

  #withDatabase<T>(action: (db: DatabaseSync) => T): T {
    mkdirSync(this.#directory, { recursive: true });
    const db = new DatabaseSync(join(this.#directory, 'provider.sqlite'));
    try {
      db.exec('CREATE TABLE IF NOT EXISTS accepted_runs (request_id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL)');
      return action(db);
    } finally { db.close(); }
  }

  async submit(raw: WorkRequest): Promise<Receipt> {
    const request = RequestSchema.parse(raw);
    return this.#withDatabase(db => {
      const existing = db.prepare('SELECT body FROM accepted_runs WHERE request_id = ?').get(request.requestId);
      if (existing) return readRun(existing).receipt;
      const receipt = ReceiptSchema.parse({ sessionId: request.sessionId ?? `offline:${request.workId}`, runId: `offline:${request.requestId}` });
      const history = db.prepare('SELECT body FROM accepted_runs ORDER BY rowid').all().map(readRun)
        .filter(run => run.request.workId === request.workId).map(run => run.request);
      const report = this.#report(request, history);
      const accepted = acceptedRunSchema.parse({ request, receipt, report });
      db.prepare('INSERT INTO accepted_runs (request_id, run_id, body) VALUES (?, ?, ?)')
        .run(request.requestId, receipt.runId, JSON.stringify(accepted));
      return receipt;
    });
  }

  #report(request: WorkRequest, history: WorkRequest[]): Report {
    const decision = [...history, request].flatMap(run => run.decisions).findLast(attention => attention.state.kind === 'resolved');
    if (!decision || decision.state.kind !== 'resolved') {
      return { kind: 'needs_input', summary: 'Synthetic draft needs a scope choice', question: 'Include failure state?', options: ['Loading only', 'Both'] };
    }
    const drafts = join(this.#directory, 'drafts');
    mkdirSync(drafts, { recursive: true });
    const artifact = join(drafts, `${encodeURIComponent(request.requestId)}.md`);
    const inputs = [...history, request].flatMap(run => run.inputs);
    writeFileSync(artifact, [
      '# Synthetic comparison-card draft', '',
      'This offline fixture combines supplied input previews with the owner choice. No model evaluation has run.', '',
      `Chosen scope: ${decision.state.choice}`, '',
      `Goal: ${request.goal}`, '',
      '## Supplied input', '',
      ...inputs.flatMap(input => [`Source: ${input.uri}`, '', input.text, '']),
    ].join('\n'));
    return { kind: 'ready', summary: `Synthetic draft prepared for ${decision.state.choice}`, evidence: [pathToFileURL(artifact).href] };
  }

  async lookup(requestId: WorkRequest['requestId']): Promise<Receipt | null> {
    return this.#withDatabase(db => {
      const row = db.prepare('SELECT body FROM accepted_runs WHERE request_id = ?').get(requestId);
      return row ? readRun(row).receipt : null;
    });
  }

  async poll(runId: string): Promise<Report | null> {
    return this.#withDatabase(db => {
      const row = db.prepare('SELECT body FROM accepted_runs WHERE run_id = ?').get(runId);
      return row ? readRun(row).report : null;
    });
  }
}
