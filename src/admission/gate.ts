import type { DatabaseSync } from 'node:sqlite';

export interface Admission {
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
  project: string | null;
  execute: boolean;
}
export interface AdmissionChannel {
  send(request: Admission, projects: Record<string, { name: string }>): Promise<string>;
  update(request: Admission, projects: Record<string, { name: string }>): Promise<void>;
}
export class AdmissionGate {
  private readonly db: DatabaseSync;
  private readonly projects: Record<string, { name: string }>;
  private readonly configured: Map<string, string>;
  constructor(db: DatabaseSync, projects: Record<string, { name: string }>, configured: Map<string, string>) {
    this.db = db;
    this.projects = projects;
    this.configured = configured;
    db.exec(`CREATE TABLE IF NOT EXISTS admission_policy (id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_bindings (chat_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admissions (
        eventId TEXT PRIMARY KEY,ownerId TEXT NOT NULL,chatId TEXT NOT NULL,chatName TEXT NOT NULL,
        sender TEXT NOT NULL,excerpt TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'waiting',
        receipt TEXT UNIQUE,chosenProject TEXT,updated INTEGER DEFAULT 0,nextAttempt INTEGER DEFAULT 0);`);
  }
  enable(owner: string) {
    if (!/^ou_[a-zA-Z0-9]+$/.test(owner)) throw Error('Invalid admission owner open_id');
    this.db.prepare('INSERT OR IGNORE INTO admission_policy VALUES (1,?)').run(owner);
    if (this.owner() !== owner) throw Error('Admission owner does not match existing configuration');
  }
  owner() {
    return this.db.prepare('SELECT owner FROM admission_policy WHERE id=1').get()?.owner as string | undefined;
  }
  boundProject(chat: string) {
    const id =
      this.configured.get(chat) ??
      this.db.prepare('SELECT project_id FROM conversation_bindings WHERE chat_id=?').get(chat)?.project_id;
    return typeof id === 'string' && Object.hasOwn(this.projects, id) ? id : null;
  }
  // Called inside the same transaction as the original incoming record.
  onReceive(id: string, known: string | null, chat: string, name: string, sender: string, text: string) {
    const owner = this.owner();
    if (!owner || known) return;
    const excerpt = text.length > 420 ? text.slice(0, 419) + '…' : text;
    this.db
      .prepare('INSERT INTO admissions (eventId,ownerId,chatId,chatName,sender,excerpt) VALUES (?,?,?,?,?,?)')
      .run(id, owner, chat, name, sender, excerpt);
  }
  bindings() {
    return this.db.prepare('SELECT chat_id,project_id,name FROM conversation_bindings').all() as unknown as {
      chat_id: string;
      project_id: string;
      name: string;
    }[];
  }
  get(id: string) {
    return this.db.prepare('SELECT * FROM admissions WHERE eventId=?').get(id) as unknown as Admission | undefined;
  }
  async deliverOne(channel: AdmissionChannel, now = Date.now()) {
    const r = this.db
      .prepare(
        "SELECT * FROM admissions WHERE nextAttempt<=? AND ((status='waiting' AND receipt IS NULL) OR (status!='waiting' AND updated=0)) ORDER BY rowid LIMIT 1",
      )
      .get(now) as unknown as Admission | undefined;
    if (!r) return;
    try {
      if (!r.receipt) {
        const receipt = await channel.send(r, this.projects);
        if (!receipt) throw Error('Missing card receipt');
        this.db.prepare('UPDATE admissions SET receipt=?,nextAttempt=0 WHERE eventId=?').run(receipt, r.eventId);
      } else {
        await channel.update(r, this.projects);
        this.db.prepare('UPDATE admissions SET updated=1 WHERE eventId=?').run(r.eventId);
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
        const prior = this.boundProject(r.chatId);
        if (choice.project !== null) {
          if (!r.chatId || !Object.hasOwn(this.projects, choice.project)) throw Error('Invalid project selection');
          if (prior && prior !== choice.project)
            throw Error('Conversation is already bound to a different project');
          this.db
            .prepare(
              'INSERT INTO conversation_bindings VALUES (?,?,?) ON CONFLICT(chat_id) DO UPDATE SET project_id=excluded.project_id,name=excluded.name',
            )
            .run(r.chatId, choice.project, r.chatName);
        }
        const project = choice.project ?? prior;
        if (project)
          this.db
            .prepare('UPDATE project_events SET project_id=? WHERE event_id=? AND project_id IS NULL')
            .run(project, id);
        this.db
          .prepare('UPDATE admissions SET chosenProject=?,status=?,nextAttempt=0 WHERE eventId=?')
          .run(choice.project, choice.execute ? 'allowed' : 'stopped', id);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
