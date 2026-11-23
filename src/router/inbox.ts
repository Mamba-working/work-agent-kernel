import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { EventSchema } from '../domain.ts';
import type { Source } from '../ports.ts';

export const MessageSchema = z.object({
  message_id: z.string().trim().min(1),
  chat_id: z.string().default(''),
  sender: z.string().default('unknown'),
  content: z.string().refine((value) => value.trim().length > 0),
  raw: z.unknown().optional(),
  revision: z.string().min(1).default('1'),
  open_message_id: z.string().optional(),
});
export interface Project {
  name: string;
  cwd: string;
  feishuChatId?: string | undefined;
}
export type Projects = Record<string, Project>;
interface ContextRow {
  sender: string;
  content: string;
  message_id: string;
  revision: string;
  chat_id: string;
}
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
export function plainText(content: string): string {
  try {
    const value = JSON.parse(content);
    if (typeof value?.text === 'string') return value.text;
  } catch {
    /* Ordinary text. */
  }
  return content;
}

export class RouterInbox implements Source {
  readonly name = 'feishu';
  readonly #db: DatabaseSync;
  readonly #projects: Projects;
  readonly #groups = new Map<string, string>();
  constructor(path: string, projects: Projects = {}) {
    this.#projects = projects;
    for (const [id, project] of Object.entries(projects)) {
      if (project.feishuChatId === undefined) continue;
      const chat = project.feishuChatId;
      if (typeof chat !== 'string' || !chat.trim() || this.#groups.has(chat.trim()))
        throw new Error('Invalid or duplicate project group');
      this.#groups.set(chat.trim(), id);
    }
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS incoming (id TEXT PRIMARY KEY, event TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_events (
        event_id TEXT PRIMARY KEY, project_id TEXT, chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL, revision TEXT NOT NULL, UNIQUE(message_id,revision));
      CREATE INDEX IF NOT EXISTS project_events_by_project ON project_events(project_id);`);
  }

  receive(raw: unknown, sourceUri?: string): string {
    const message = MessageSchema.parse(raw);
    const id = createHash('sha256')
      .update(JSON.stringify([message.message_id, message.revision]))
      .digest('hex');
    const event = EventSchema.parse({
      source: this.name,
      externalId: message.message_id,
      revision: message.revision,
      thread: message.message_id,
      actor: message.sender,
      text: JSON.stringify(message),
      uri: sourceUri ?? 'message://' + encodeURIComponent(message.message_id),
      occurredAt: null,
    });
    const db = this.#db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const prior = db.prepare('SELECT event FROM incoming WHERE id=?').get(id);
      if (prior) {
        const stored = EventSchema.parse(JSON.parse(String(prior.event)));
        if (stored.text !== event.text) throw new Error('Conflicting source message revision');
      } else {
        const original = db
          .prepare('SELECT project_id,chat_id FROM project_events WHERE message_id=? ORDER BY rowid LIMIT 1')
          .get(message.message_id);
        if (original && original.chat_id !== message.chat_id)
          throw new Error('Conflicting conversation on revision');
        const owner = original ? original.project_id : (this.#groups.get(message.chat_id) ?? null);
        db.prepare('INSERT INTO incoming VALUES (?,?)').run(id, JSON.stringify(event));
        db.prepare('INSERT INTO project_events VALUES (?,?,?,?,?)').run(
          id,
          typeof owner === 'string' ? owner : null,
          message.chat_id,
          message.message_id,
          message.revision,
        );
      }
      db.exec('COMMIT');
      return id;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  async fetch() {
    return {
      events: this.#db
        .prepare('SELECT event FROM incoming ORDER BY rowid')
        .all()
        .map((row) => JSON.parse(String(row.event))),
      cursor: null,
    };
  }
  close() {
    this.#db.close();
  }
  context(key: string, text: string, workerProject?: string) {
    const db = this.#db;
    const [source, id, revision] = JSON.parse(key);
    if (source !== this.name) return null;
    const current = db
      .prepare('SELECT rowid AS position,project_id FROM project_events WHERE message_id=? AND revision=?')
      .get(id, revision);
    if (!current) return null;
    const projectId = typeof current.project_id === 'string' ? current.project_id : workerProject;
    if (!projectId) return null;
    const project = this.#projects[projectId];
    if (!project || (workerProject && workerProject !== projectId)) return null;
    const query = plainText(JSON.parse(text).content);
    const terms = [
      ...new Set(
        [...segmenter.segment(query.toLowerCase())]
          .filter((s) => s.isWordLike && s.segment.length > 1)
          .map((s) => s.segment),
      ),
    ].slice(0, 16);
    const scoring = terms.map(() => 'CAST(instr(lower(content),?)>0 AS INTEGER)').join('+') || '0';
    const rows = db
      .prepare(
        `
        WITH revisions AS (
          SELECT p.*,p.rowid AS pos,row_number() OVER(PARTITION BY message_id ORDER BY p.rowid DESC) AS rank
          FROM project_events p WHERE project_id=? AND p.rowid<? AND message_id!=?
        ), messages AS (
          SELECT pos,message_id,revision,chat_id,json_extract(i.event,'$.actor') AS sender,
                 json_extract(json_extract(i.event,'$.text'),'$.content') AS content
          FROM revisions JOIN incoming i ON i.id=revisions.event_id WHERE rank=1
        ), scored AS (SELECT *,(${scoring}) AS score FROM messages),
        recent AS (SELECT * FROM scored ORDER BY pos DESC LIMIT 8),
        relevant AS (SELECT * FROM scored WHERE score>0 AND pos NOT IN (SELECT pos FROM recent)
                     ORDER BY score DESC,pos DESC LIMIT 4)
        SELECT * FROM (SELECT * FROM relevant UNION ALL SELECT * FROM recent) ORDER BY pos
      `,
      )
      .all(projectId, Number(current.position), id, ...terms) as unknown as ContextRow[];
    return {
      project: { id: projectId, name: project.name, harness: 'codex/' + projectId },
      messages: rows.map((row) => ({
        messageId: row.message_id,
        revision: row.revision,
        chatId: row.chat_id,
        sender: row.sender,
        text: plainText(row.content).slice(0, 600),
      })),
    };
  }
}
