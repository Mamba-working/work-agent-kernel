import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Notice } from '../domain.ts';
import type { NotificationSink } from '../ports.ts';

const sent = z.object({ ok: z.literal(true), data: z.object({ message_id: z.string().min(1) }) });

export class LarkOwnerSink implements NotificationSink {
  readonly #owner: string;
  readonly #executable: string;
  readonly #db: DatabaseSync;

  constructor(options: { owner: string; path: string; executable?: string }) {
    this.#owner = options.owner;
    this.#executable = options.executable ?? 'lark-cli';
    this.#db = new DatabaseSync(options.path);
    this.#db.exec('CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, receipt TEXT NOT NULL)');
  }

  async deliver(notice: Notice): Promise<string> {
    if (notice.recipient !== this.#owner) throw new Error('Notice recipient differs from configured owner');
    const prior = this.#db.prepare('SELECT receipt FROM deliveries WHERE id = ?').get(notice.id);
    if (prior) return z.object({ receipt: z.string() }).parse(prior).receipt;
    const body = notice.body;
    const details = body.kind === 'needs_input'
      ? `\n${body.question}\n${body.options.map((option, index) => `${index + 1}. ${option}`).join('\n')}`
      : body.kind === 'ready' ? `\n${body.evidence.join('\n')}` : '';
    const message = `Work Agent · ${body.kind}\n${body.summary}${details}\n事项 ${notice.workId}`;
    const idempotencyKey = createHash('sha256').update(notice.id).digest('hex').slice(0, 40);
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(this.#executable, [
        'im', '+messages-send', '--as', 'user', '--user-id', this.#owner,
        '--text', '-', '--idempotency-key', idempotencyKey, '--format', 'json',
      ], { stdio: 'pipe', env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }, timeout: 30_000 });
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.resume();
      child.on('error', () => reject(new Error('Lark process could not start')));
      child.stdin.on('error', () => reject(new Error('Lark input closed')));
      child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`Lark delivery failed (exit ${code})`)));
      child.stdin.end(message);
    });
    const receipt = sent.parse(JSON.parse(output)).data.message_id;
    this.#db.prepare('INSERT INTO deliveries (id, receipt) VALUES (?, ?)').run(notice.id, receipt);
    return receipt;
  }

  close(): void { this.#db.close(); }
}
