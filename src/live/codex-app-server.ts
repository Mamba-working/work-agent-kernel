import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';

const messageSchema = z.union([
  z.object({ id: z.union([z.number(), z.string()]), method: z.string() }),
  z.object({ id: z.number(), error: z.object({ code: z.number() }) }),
  z.object({ id: z.number(), result: z.json() }),
]);

const approvalDenials = new Map<string, object>([
  ['item/commandExecution/requestApproval', { decision: 'decline' }],
  ['item/fileChange/requestApproval', { decision: 'decline' }],
  ['item/permissions/requestApproval', { permissions: {}, scope: 'turn' }],
  ['execCommandApproval', { decision: 'abort' }],
  ['applyPatchApproval', { decision: 'abort' }],
  ['mcpServer/elicitation/request', { action: 'decline' }],
]);

class CodexRpcError extends Error {
  override readonly name = 'CodexRpcError';
}

export class CodexAppServer {
  readonly ready: Promise<void>;
  readonly #child: ChildProcessByStdio<Writable, Readable, null>;
  readonly #closed: Promise<void>;
  readonly #pending = new Map<number, (reply: { result: unknown } | { error: Error }) => void>();
  #stopped = false;
  #nextId = 0;

  constructor(options: { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }) {
    this.#child = spawn(options.executable, options.args, {
      cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.#child.on('error', () => this.#stop());
    this.#child.stdin.on('error', () => this.#stop());
    this.#closed = new Promise(resolve => this.#child.once('close', () => {
      this.#stop();
      resolve();
    }));
    createInterface({ input: this.#child.stdout }).on('line', line => this.#receive(line));
    this.ready = this.#initialize();
  }

  get open(): boolean { return !this.#stopped; }

  async #initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'work_agent_kernel', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.#send({ method: 'initialized', params: {} });
  }

  #stop(): void {
    this.#stopped = true;
    for (const complete of this.#pending.values()) complete({ error: new CodexRpcError('Codex App Server disconnected') });
    this.#pending.clear();
  }

  #send(message: object): void {
    this.#child.stdin.write(JSON.stringify(message) + '\n');
  }

  #receive(line: string): void {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return; }
    const parsed = messageSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    if ('method' in message) {
      const result = approvalDenials.get(message.method);
      const error = { code: -32601, message: 'Interactive requests are unavailable in prepare scope' };
      this.#send({ id: message.id, ...(result ? { result } : { error }) });
    } else {
      this.#pending.get(message.id)?.('error' in message
        ? { error: new CodexRpcError(`Codex App Server rejected request (${message.error.code})`) }
        : { result: message.result });
    }
  }

  request(method: string, params: object): Promise<unknown> {
    if (!this.open) return Promise.reject(new CodexRpcError('Codex App Server disconnected'));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => complete({ error: new CodexRpcError(`Codex App Server timed out: ${method}`) }), 30_000);
      const complete = (reply: { result: unknown } | { error: Error }) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        if ('error' in reply) reject(reply.error);
        else resolve(reply.result);
      };
      this.#pending.set(id, complete);
      this.#send({ id, method, params });
    });
  }

  async close(): Promise<void> {
    this.#stop();
    this.#child.stdin.end();
    this.#child.kill();
    const timeout = setTimeout(() => this.#child.kill('SIGKILL'), 2_000);
    try { await this.#closed; } finally { clearTimeout(timeout); }
  }
}
