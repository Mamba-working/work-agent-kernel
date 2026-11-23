import { DatabaseSync } from 'node:sqlite';
import { NoticeSchema } from '../../core/domain.ts';
import type { Notice } from '../../core/domain.ts';
import type { NotificationSink } from '../../core/ports.ts';

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
