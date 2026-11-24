import { DatabaseSync } from 'node:sqlite';
import { StateSchema, emptyState } from './domain.ts';
import type { State } from './domain.ts';

/** Single-owner prototype: one JSON aggregate, not a production message archive. */
export class Store {
  readonly #db: DatabaseSync;
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(
      'CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)',
    );
    this.#db.prepare('INSERT OR IGNORE INTO state VALUES (1, ?)').run(JSON.stringify(emptyState()));
    this.read();
  }
  read(): State {
    const row = this.#db.prepare('SELECT body FROM state WHERE id=1').get();
    if (typeof row?.body !== 'string') throw new Error('Missing state');
    return StateSchema.parse(JSON.parse(row.body));
  }
  // SQLite selects the requested member(s); only those records cross the JS boundary.
  find<T>(
    collection: 'events' | 'works' | 'runs' | 'outbox',
    key: string,
    schema: { parse(value: unknown): T },
  ): T | undefined {
    const row = this.#db
      .prepare('SELECT j.value FROM state, json_each(body, ?) AS j WHERE state.id=1 AND j.key=?')
      .get('$.' + collection, key);
    return row ? schema.parse(JSON.parse(String(row.value))) : undefined;
  }
  list<T>(collection: 'works' | 'attentions', schema: { parse(value: unknown): T }): T[] {
    return this.#db
      .prepare('SELECT j.value FROM state,json_each(body, ?) AS j WHERE state.id=1')
      .all('$.' + collection)
      .map((row) => schema.parse(JSON.parse(String(row.value))));
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
  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}
