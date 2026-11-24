import type { Project } from './inbox.ts';
import type { DatabaseSync } from 'node:sqlite';

import { ContextAccess, openChatId } from './context-access.ts';

export type ChatType = 'p2p' | 'group' | 'unknown';

export interface Admission {
  chatType: ChatType;
  eventId: string;
  ownerId: string;
  chatId: string;
  chatName: string;
  sender: string;
  excerpt: string;
  status: 'waiting' | 'allowed' | 'stopped';
  receipt: string | null;
  chosenProject: string | null;
}
export interface Choice {
  project?: string | null;
  execute: boolean;
  readContext?: boolean;
  openChat?: string;
}
export interface AdmissionChannel {
  send(request: Admission, projects: Record<string, { name: string }>): Promise<string>;
  update(request: Admission, projects: Record<string, { name: string }>): Promise<void>;
}
export class AdmissionGate {
  readonly context: ContextAccess;
  private readonly db: DatabaseSync;
  private readonly projects: Record<string, Pick<Project,'name'|'groups'>>;
  private readonly configured: Map<string, string>;
  private readonly assignProject: (eventId: string, projectId: string) => void;
  constructor(
    db: DatabaseSync,
    projects: Record<string, Pick<Project,'name'|'groups'>>,
    configured: Map<string, string>,
    assignProject: (eventId: string, projectId: string) => void,
  ) {
    this.assignProject = assignProject;
    this.db = db;
    this.context = new ContextAccess(db);
    this.projects = projects;
    this.configured = configured;
    db.exec(`CREATE TABLE IF NOT EXISTS admission_policy (id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_bindings (chat_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_types(chat_id TEXT PRIMARY KEY, kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admissions (
        eventId TEXT PRIMARY KEY,ownerId TEXT NOT NULL,chatId TEXT NOT NULL,chatName TEXT NOT NULL,
        sender TEXT NOT NULL,excerpt TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'waiting',
        chatType TEXT NOT NULL DEFAULT 'unknown',receipt TEXT UNIQUE,chosenProject TEXT,updated INTEGER DEFAULT 0,nextAttempt INTEGER DEFAULT 0);`);
    if (
      !db
        .prepare('PRAGMA table_info(admissions)')
        .all()
        .some((column) => column.name === 'chatType')
    ) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (
          !db
            .prepare('PRAGMA table_info(admissions)')
            .all()
            .some((column) => column.name === 'chatType')
        ) {
          db.exec("ALTER TABLE admissions ADD COLUMN chatType TEXT NOT NULL DEFAULT 'unknown'");
          db.exec(
            "UPDATE admissions SET updated=-1,nextAttempt=0 WHERE status='waiting' AND receipt IS NOT NULL",
          );
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  }
  chatType(chat: string): ChatType {
    const kind = this.db.prepare('SELECT kind FROM conversation_types WHERE chat_id=?').get(chat)?.kind;
    return kind === 'p2p' || kind === 'group' ? kind : 'unknown';
  }
  rememberChatType(chat: string, kind: Exclude<ChatType, 'unknown'>) {
    if (!chat) return;
    this.db
      .prepare(
        'INSERT INTO conversation_types VALUES (?,?) ON CONFLICT(chat_id) DO UPDATE SET kind=excluded.kind',
      )
      .run(chat, kind);
    this.db
      .prepare(
        "UPDATE admissions SET chatType=?,updated=CASE WHEN receipt IS NULL THEN 0 ELSE -1 END,nextAttempt=0 WHERE chatId=? AND status='waiting' AND chatType!=?",
      )
      .run(kind, chat, kind);
  }
  enable(owner: string) {
    if (!owner.trim()) throw Error('Missing admission owner');
    this.db.prepare('INSERT OR IGNORE INTO admission_policy VALUES (1,?)').run(owner);
    if (this.owner() !== owner) throw Error('Admission owner does not match existing configuration');
  }
  owner() {
    return this.db.prepare('SELECT owner FROM admission_policy WHERE id=1').get()?.owner as
      | string
      | undefined;
  }
  sourceAddress(chat: string) {
    const known = this.context.address(chat);
    if (known) return known;
    if (this.chatType(chat)==='p2p') return null;
    const project = this.projects[this.configured.get(chat) ?? ''];
    const group = project?.groups?.find(g=>g.id===chat || g.aliases?.includes(chat));
    return [group?.id,...(group?.aliases ?? [])].find(id=>id && openChatId.test(id)) ?? null;
  }
  boundProject(chat: string) {
    if (this.chatType(chat) === 'p2p') return null;
    const id =
      this.configured.get(chat) ??
      this.db.prepare('SELECT project_id FROM conversation_bindings WHERE chat_id=?').get(chat)?.project_id;
    return typeof id === 'string' && Object.hasOwn(this.projects, id) ? id : null;
  }
  // Called inside the same transaction as the original incoming record.
  onReceive(
    id: string,
    known: string | null,
    chat: string,
    name: string,
    sender: string,
    text: string,
    kind: ChatType,
  ) {
    const owner = this.owner();
    if (!owner || (known && kind !== 'p2p')) return;
    const excerpt = text.length > 420 ? text.slice(0, 419) + '…' : text;
    this.db
      .prepare(
        'INSERT INTO admissions (eventId,ownerId,chatId,chatName,sender,excerpt,chatType) VALUES (?,?,?,?,?,?,?)',
      )
      .run(id, owner, chat, name, sender, excerpt, kind);
  }
  bindings() {
    return this.db
      .prepare(
        "SELECT chat_id,project_id,name FROM conversation_bindings WHERE chat_id NOT IN (SELECT chat_id FROM conversation_types WHERE kind='p2p')",
      )
      .all() as unknown as {
      chat_id: string;
      project_id: string;
      name: string;
    }[];
  }
  get(id: string) {
    return this.db.prepare('SELECT * FROM admissions WHERE eventId=?').get(id) as unknown as
      | Admission
      | undefined;
  }
  async sendPending(id: string, channel: AdmissionChannel) {
    const r = this.get(id);
    if (!r) throw Error('Missing admission request');
    if (r.receipt || r.status !== 'waiting') return;
    const receipt = await channel.send(r, this.projects);
    if (!receipt) throw Error('Missing card receipt');
    this.db.prepare('UPDATE admissions SET receipt=?,nextAttempt=0 WHERE eventId=?').run(receipt, id);
  }
  async deliverOne(channel: AdmissionChannel, now = Date.now(), updatesOnly = false) {
    const r = this.db
      .prepare(
        "SELECT * FROM admissions WHERE nextAttempt<=? AND ((?=0 AND status='waiting' AND receipt IS NULL) OR (receipt IS NOT NULL AND status='waiting' AND updated=-1) OR (status!='waiting' AND updated=0)) ORDER BY rowid LIMIT 1",
      )
      .get(now, Number(updatesOnly)) as unknown as Admission | undefined;
    if (!r) return;
    try {
      if (!r.receipt) {
        await this.sendPending(r.eventId, channel);
      } else {
        await channel.update(r, this.projects);
        this.db
          .prepare('UPDATE admissions SET updated=? WHERE eventId=? AND status=? AND chatType=?')
          .run(r.status === 'waiting' ? 0 : 1, r.eventId, r.status, r.chatType);
      }
    } catch (e) {
      this.db.prepare('UPDATE admissions SET nextAttempt=? WHERE eventId=?').run(now + 30000, r.eventId);
      throw e;
    }
  }
  submit(id: string, actor: string, receipt: string, choice: Choice) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = this.get(id);
      if (!r || r.ownerId !== actor || !receipt || receipt !== r.receipt)
        throw Error('Unknown card or unexpected operator');
      if (r.status === 'waiting') {
        const bindable = r.chatType === 'group' && Boolean(r.chatId);
        if (bindable && choice.project === undefined) throw Error('Missing group binding choice');
        if (!bindable && choice.project != null) throw Error('This card authorizes one message only');
        const prior = bindable ? this.boundProject(r.chatId) : null;
        if (choice.project != null) {
          if (!r.chatId || !Object.hasOwn(this.projects, choice.project))
            throw Error('Invalid project selection');
          if (prior && prior !== choice.project)
            throw Error('Conversation is already bound to a different project');
          this.db
            .prepare(
              'INSERT INTO conversation_bindings VALUES (?,?,?) ON CONFLICT(chat_id) DO UPDATE SET project_id=excluded.project_id,name=excluded.name',
            )
            .run(r.chatId, choice.project, r.chatName);
        }
        if (choice.execute && choice.readContext) this.context.grant(id, r.chatId, choice.openChat ?? this.sourceAddress(r.chatId) ?? undefined, r.chatType === 'p2p');
        const project = choice.project ?? prior;
        if (project) this.assignProject(id, project);
        this.db
          .prepare('UPDATE admissions SET chosenProject=?,status=?,nextAttempt=0,updated=0 WHERE eventId=?')
          .run(choice.project ?? null, choice.execute ? 'allowed' : 'stopped', id);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
