import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

export const stateDirectory = () => resolve(process.env.WORK_AGENT_STATE_DIR ?? join(homedir(), '.local', 'state', 'work-agent-kernel'));

const configSchema = z.object({
  directory: z.string().min(1),
  baseUrl: z.url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  owner: z.string().regex(/^ou_/),
  codexExecutable: z.string().min(1),
  larkExecutable: z.string().min(1),
  intervalMs: z.coerce.number().int().min(100).max(60_000),
});

export function liveConfig(): z.infer<typeof configSchema> {
  const result = configSchema.safeParse({
    directory: stateDirectory(), baseUrl: process.env.WORK_AGENT_API_BASE,
    apiKey: process.env.WORK_AGENT_API_KEY, model: process.env.WORK_AGENT_MODEL,
    owner: process.env.WORK_AGENT_OWNER, codexExecutable: process.env.WORK_AGENT_CODEX_BIN ?? 'codex',
    larkExecutable: process.env.WORK_AGENT_LARK_BIN ?? 'lark-cli',
    intervalMs: process.env.WORK_AGENT_INTERVAL_MS ?? 2000,
  });
  if (!result.success) throw new Error(`Invalid live configuration fields: ${result.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  return result.data;
}
