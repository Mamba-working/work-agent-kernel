import { readFile } from 'node:fs/promises';
import { EventSchema } from '../../src/domain.ts';
import type { Source } from '../../src/ports.ts';

export class FileEventSource implements Source {
  readonly name: string;
  readonly #path: string;
  constructor(options: { name: string; path: string }) {
    this.name = options.name;
    this.#path = options.path;
  }
  async fetch(cursor: string | null): Promise<unknown> {
    const offset = cursor === null ? 0 : Number(cursor);
    if (cursor !== null && !/^(0|[1-9]\d*)$/.test(cursor) || !Number.isSafeInteger(offset)) throw new Error('Invalid file source cursor');
    const content = await readFile(this.#path, 'utf8');
    const rows = content === '' ? [] : content.split('\n');
    if (content.endsWith('\n')) rows.pop();
    if (offset > rows.length) throw new Error('File has fewer rows than the committed source cursor');
    const events = rows.slice(offset).map((row, index) => {
      try {
        const raw: unknown = JSON.parse(row);
        return EventSchema.parse(raw);
      } catch (cause) { throw new Error(`Invalid event at ${this.#path}:${offset + index + 1}`, { cause }); }
    });
    return { events, cursor: String(rows.length) };
  }
}
