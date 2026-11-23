import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { RouterInbox } from '../adapters/feishu/inbox.ts';
import { serve, ProjectsSchema } from './service.ts';

process.umask(0o077);
const dir = resolve(process.env.ROUTER_INBOX_DIR ?? join(homedir(), '.local/state/router-inbox'));
const projects = ProjectsSchema.parse(
  process.env.ROUTER_PROJECTS_FILE ? JSON.parse(readFileSync(process.env.ROUTER_PROJECTS_FILE, 'utf8')) : {},
);
mkdirSync(dir, { recursive: true });
switch (process.argv[2]) {
  case 'ingest': {
    const inbox = new RouterInbox(join(dir, 'feishu.sqlite'), projects);
    try {
      const message = JSON.parse(readFileSync(0, 'utf8'));
      console.log(JSON.stringify({ ok: true, eventId: inbox.receive(message) }));
    } finally {
      inbox.close();
    }
    break;
  }
  case 'serve': {
    const stop = new AbortController();
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stop.abort());
    await serve(dir, projects, process.env.CODEX_BIN ?? 'codex', stop.signal);
    break;
  }
  default:
    throw new Error('Expected ingest or serve');
}
