import type { DatabaseSync } from 'node:sqlite';
import type { ContextPage } from '../../core/planning/contracts.ts';

export const openChatId = /^oc_[a-zA-Z0-9]+$/;
export const openUserId = /^ou_[a-zA-Z0-9]+$/;
export interface ContextRead {
  status: 'read' | 'empty' | 'unmapped' | 'unavailable';
  chat: string | null;
  until: string;
  messages: ContextPage['messages'];
}

export class ContextAccess {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS chat_addresses(source_chat TEXT PRIMARY KEY,open_chat TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_grants(event_id TEXT PRIMARY KEY,open_chat TEXT);
      CREATE TABLE IF NOT EXISTS context_reads(event_id TEXT PRIMARY KEY,body TEXT NOT NULL)`);
  }
  address(chat: string) {
    if (openChatId.test(chat)) return chat;
    const address = this.db.prepare('SELECT open_chat FROM chat_addresses WHERE source_chat=?').get(chat);
    return address ? String(address.open_chat) : null;
  }
  /** Runs inside the admission transaction, once for an authenticated card submission. */
  grant(event: string, chat: string, selected?: string, privateChat = false) {
    const prior = this.address(chat);
    if (
      selected &&
      (!chat ||
        !(openChatId.test(selected) || (privateChat && openUserId.test(selected))) ||
        (prior && prior !== selected))
    )
      throw Error('会话标识与已确认的来源不一致');
    if (selected && !prior) this.db.prepare('INSERT INTO chat_addresses VALUES (?,?)').run(chat, selected);
    this.db.prepare('INSERT INTO context_grants VALUES (?,?)').run(event, prior ?? selected ?? null);
  }
  permission(event: string) {
    const row = this.db.prepare('SELECT open_chat FROM context_grants WHERE event_id=?').get(event);
    return row ? { chat: row.open_chat === null ? null : String(row.open_chat) } : undefined;
  }
  save(event: string, read: ContextRead) {
    this.db.prepare('INSERT OR REPLACE INTO context_reads VALUES (?,?)').run(event, JSON.stringify(read));
    return read;
  }
  read(event: string): ContextRead | undefined {
    const row = this.db.prepare('SELECT body FROM context_reads WHERE event_id=?').get(event);
    if (row) return JSON.parse(String(row.body));
  }
}
