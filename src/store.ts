import { DatabaseSync } from 'node:sqlite';
import { StateSchema, emptyState } from './domain.ts';
import type { State } from './domain.ts';

/** Single-owner prototype: one JSON aggregate, not a production message archive. */
export class Store {
  readonly #db: DatabaseSync;
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)');
    this.#db.prepare('INSERT OR IGNORE INTO state VALUES (1, ?)').run(JSON.stringify(emptyState()));
    this.read();
  }
  read(): State {
    const row = this.#db.prepare('SELECT body FROM state WHERE id=1').get();
    if (typeof row?.body !== 'string') throw new Error('Missing state');
    return StateSchema.parse(JSON.parse(row.body));
  }
  transaction<T>(command: (state: State) => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.read();
      const result = command(state);
      this.#db.prepare('UPDATE state SET body=? WHERE id=1').run(JSON.stringify(StateSchema.parse(state)));
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void { if (this.#db.isOpen) this.#db.close(); }
}
