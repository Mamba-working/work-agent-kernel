import { notifyApplication, watchApplication } from '../../core/wakeup.ts';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Project, Projects } from './inbox.ts';

const text = z.string().trim().min(1);
const group = z.object({ name: text, id: text, aliases: z.array(text).optional() });
export const projectsSchema = (sessionId: (id: string) => string = (id) => id) =>
  z.record(
    z.string().min(1),
    z.object({
      name: z.string().min(1),
      cwd: z.string().min(1),
      feishuChatId: z.string().min(1).optional(),
      groups: z
        .array(
          z.object({
            name: z.string().min(1),
            id: z.string().min(1),
            aliases: z.array(z.string().min(1)).optional(),
          }),
        )
        .optional(),
      sessions: z.array(z.object({ title: z.string().min(1), id: text.transform(sessionId) })).optional(),
      context: z.string().optional(),
      artwork: z.literal('architecture').optional(),
    }),
  );
export const ProjectsSchema = projectsSchema();
export const CreateProjectInput = z.strictObject({
  requestId: z.string().uuid(),
  name: text,
  cwd: text,
  context: z.string().trim().optional(),
  groups: z.array(group).optional(),
  sessions: z.array(z.object({ title: text, id: text })).optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

function unique(values: string[], message: string) {
  if (new Set(values).size !== values.length) throw Error(message);
}
function definition(input: CreateProjectInput, normalizeSessionId: (id: string) => string): Project {
  const path =
    input.cwd === '~'
      ? homedir()
      : input.cwd.startsWith('~/')
        ? join(homedir(), input.cwd.slice(2))
        : input.cwd;
  if (!isAbsolute(path) || !statSync(path, { throwIfNoEntry: false })?.isDirectory())
    throw Error('请填写本机已存在的工作目录，例如 ~/code/my-project。');
  const groups = input.groups ?? [];
  unique(
    groups.flatMap((g) => [g.id, ...(g.aliases ?? [])]),
    '飞书群 ID 或别名重复，请检查关联群。',
  );
  const sessions = (input.sessions ?? []).map((s) => {
    const id = normalizeSessionId(s.id);
    return { title: s.title, id };
  });
  unique(
    sessions.map((s) => s.id),
    '同一工作会话只能添加一次。',
  );
  return {
    name: input.name,
    cwd: resolve(path),
    ...(input.context ? { context: input.context } : {}),
    ...(groups.length ? { groups } : {}),
    ...(sessions.length ? { sessions } : {}),
  };
}

// The UI proposes a definition; the running application admits it against the live catalog.
export class ProjectRegistry {
  private readonly db: DatabaseSync;
  private readonly directory: string;
  private readonly normalizeSessionId: (id: string) => string;
  constructor(directory: string, normalizeSessionId: (id: string) => string = (id) => text.parse(id)) {
    this.normalizeSessionId = normalizeSessionId;
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'projects.sqlite'), { timeout: 3000 });
    this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS projects(
      id TEXT PRIMARY KEY, definition TEXT NOT NULL, status TEXT NOT NULL, error TEXT)`);
  }
  close() {
    this.db.close();
  }
  async create(raw: CreateProjectInput) {
    const input = CreateProjectInput.parse(raw),
      project = definition(input, this.normalizeSessionId),
      id = 'project-' + input.requestId;
    const body = JSON.stringify(project);
    this.db
      .prepare(
        "INSERT INTO projects(id,definition,status) VALUES (?,?,'pending') ON CONFLICT(id) DO UPDATE SET status='pending',error=NULL WHERE projects.status='failed' AND projects.definition=excluded.definition",
      )
      .run(id, body);
    notifyApplication(this.directory, 'projects.wake');
    const get = this.db.prepare('SELECT definition,status,error FROM projects WHERE id=?');
    const deadline = Date.now() + 10000;
    let nextHint = Date.now() + 1000;
    while (true) {
      const row = get.get(id);
      if (!row) throw Error('Router 未接收此项目，请重试。');
      if (row.definition !== body) throw Error('本次提交编号已用于其他项目。');
      if (row.status === 'active') return { id, project };
      if (row.status === 'failed') throw Error(String(row.error));
      if (Date.now() >= deadline) {
        if (row.status === 'registering')
          throw Error('Router 已接收该项目，正在登记；请使用同一编号查询或重试。');
        if (this.db.prepare("DELETE FROM projects WHERE id=? AND status='pending'").run(id).changes)
          throw Error('Router 暂未响应。请确认服务已启动后重试。');
      }
      if (row.status === 'pending' && Date.now() >= nextHint) {
        notifyApplication(this.directory, 'projects.wake');
        nextHint = Date.now() + 1000;
      }
      await delay(120);
    }
  }
  listen(register: (id: string, project: Project) => Promise<void>, onError: (error: unknown) => void) {
    let active: Promise<void> | undefined,
      dirty = false,
      closed = false;
    const trigger = () => {
      dirty = true;
      if (active || closed) return;
      active = Promise.resolve()
        .then(async () => {
          while (dirty && !closed) {
            dirty = false;
            if (await this.acceptNext(register)) dirty = true;
          }
        })
        .catch(onError)
        .finally(() => {
          active = undefined;
          if (dirty && !closed) trigger();
        });
    };
    const unsubscribe = watchApplication(this.directory, trigger, 'projects.wake');
    trigger();
    return async () => {
      closed = true;
      unsubscribe();
      await active;
    };
  }
  private async acceptNext(register: (id: string, project: Project) => Promise<void>) {
    // A claimed row survives a process restart. A waiting client can withdraw only unclaimed rows.
    const row = this.db
      .prepare(
        "UPDATE projects SET status='registering' WHERE id=(SELECT id FROM projects WHERE status IN ('pending','registering') ORDER BY rowid LIMIT 1) RETURNING id,definition",
      )
      .get();
    if (!row) return false;
    try {
      await register(String(row.id), JSON.parse(String(row.definition)));
    } catch (error) {
      this.db
        .prepare("UPDATE projects SET status='failed',error=? WHERE id=?")
        .run(error instanceof Error ? error.message : '项目登记失败', row.id!);
      return true;
    }
    this.db.prepare("UPDATE projects SET status='active' WHERE id=?").run(row.id!);
    return true;
  }
}

export function loadProjects(directory: string, configured: Projects): Projects {
  if (!existsSync(join(directory, 'projects.sqlite'))) return { ...configured };
  const db = new DatabaseSync(join(directory, 'projects.sqlite'), { readOnly: true, timeout: 3000 });
  try {
    const managed: Projects = Object.fromEntries(
      db
        .prepare("SELECT id,definition FROM projects WHERE status='active' ORDER BY rowid")
        .all()
        .map((r) => [String(r.id), JSON.parse(String(r.definition))]),
    );
    for (const id of Object.keys(managed))
      if (Object.hasOwn(configured, id)) throw Error('项目标识与配置文件冲突：' + id);
    return { ...configured, ...managed };
  } finally {
    db.close();
  }
}
