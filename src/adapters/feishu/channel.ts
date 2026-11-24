import { createHash } from 'node:crypto';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listChats } from './chats.ts';
import { renderAdmission, parseSubmission } from './card.ts';
import type { Admission, AdmissionChannel, AdmissionGate } from './admission-store.ts';

const local = join(homedir(), '.local/bin/lark-cli');
function command() {
  return process.env.LARK_CLI_BIN ?? (existsSync(local) ? local : 'lark-cli');
}
async function call(args: string[], body: unknown) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(command(), args, { stdio: 'pipe', timeout: 30000 });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        const res = JSON.parse(stdout);
        if (code !== 0 || !res.ok) throw Error('Feishu bot request failed');
        resolve(res.data ?? {});
      } catch {
        reject(Error('Feishu bot request failed'));
      }
    });
    child.stdin.end(JSON.stringify(body));
  });
}
export function createFeishuChannel(gate: AdmissionGate): AdmissionChannel {
  async function card(r: Admission, projects: Record<string, { name: string }>) {
    if (r.status !== 'waiting' || !r.chatId || gate.sourceAddress(r.chatId))
      return renderAdmission(r, projects);
    const types = r.chatType === 'unknown' ? (['p2p', 'group'] as const) : [r.chatType];
    // Keep the link input available if recent chats cannot be listed.
    const lists = await Promise.all(
      types.map((kind) =>
        listChats(kind, '', '').then(
          (page) => page.chats,
          () => [],
        ),
      ),
    );
    return renderAdmission(r, projects, { chats: lists.flat().slice(0, 50) });
  }
  return {
    async send(r, projects) {
      const data = await call(
        [
          'im',
          '+messages-send',
          '--as',
          'bot',
          '--user-id',
          r.ownerId,
          '--msg-type',
          'interactive',
          '--content',
          '-',
          '--idempotency-key',
          'gate-' + r.eventId.slice(0, 40),
        ],
        await card(r, projects),
      );
      if (typeof data.message_id !== 'string' || !data.message_id.startsWith('om_'))
        throw Error('Missing Feishu card receipt');
      return data.message_id;
    },
    async update(r, projects) {
      await call(
        [
          'im',
          'messages',
          'patch',
          '--as',
          'bot',
          '--params',
          JSON.stringify({ message_id: r.receipt }),
          '--data',
          '-',
        ],
        { content: JSON.stringify(await card(r, projects)) },
      );
    },
  };
}

export function startFeishuAdmission(
  gate: AdmissionGate,
  signal: AbortSignal,
  updatesOnly = false,
  channel = createFeishuChannel(gate),
) {
  const owner = process.env.ROUTER_APPROVAL_OWNER;
  if (owner) {
    if (!/^ou_[a-zA-Z0-9]+$/.test(owner)) throw Error('Invalid admission owner open_id');
    gate.enable(owner);
  }
  let closing = false,
    ready = false,
    error = '',
    active: Promise<void> | undefined;
  let listener: ReturnType<typeof spawn> | undefined, retry: ReturnType<typeof setTimeout> | undefined;
  function connect() {
    if (closing || signal.aborted) return;
    const child = spawn(command(), ['event', 'consume', 'card.action.trigger', '--as', 'bot'], {
      stdio: 'pipe',
    });
    listener = child;
    const events = createInterface({ input: child.stdout });
    const diagnostics = createInterface({ input: child.stderr });
    diagnostics.on('line', (line) => {
      if (line.includes('ready event_key=card.action.trigger')) {
        ready = true;
        error = '';
      }
    });
    events.on('line', (line) => {
      try {
        const submission = parseSubmission(JSON.parse(line));
        if (submission) {
          gate.submit(submission.id, submission.actor, submission.receipt, submission.choice);
          error = '';
        }
      } catch {
        error = '卡片提交未生效：请核对操作者、项目及卡片来源';
      }
    });
    child.on('error', () => {
      error = '飞书回调监听不可用';
    });
    child.on('close', () => {
      ready = false;
      events.close();
      diagnostics.close();
      if (!closing && !signal.aborted) {
        error = '飞书回调监听已断开';
        retry = setTimeout(connect, 5000);
      }
    });
  }
  if (gate.owner()) connect();
  const timer = setInterval(() => {
    if (!ready || active || signal.aborted) return;
    active = gate
      .deliverOne(channel, Date.now(), updatesOnly)
      .catch(() => {
        error = '飞书卡片投递或更新失败，稍后重试';
      })
      .finally(() => (active = undefined));
  }, 1000);
  return {
    status: () => ({ enabled: !!gate.owner(), listening: ready, error }),
    async close() {
      closing = true;
      clearInterval(timer);
      clearTimeout(retry);
      listener?.kill();
      await active;
    },
  };
}

export async function sendResultNotice(id: string, payload: unknown) {
  const { text, recipient } = z
    .object({ text: z.string(), recipient: z.string().regex(/^ou_[a-zA-Z0-9]+$/) })
    .parse(payload);
  const data = await call(
    [
      'im',
      '+messages-send',
      '--as',
      'bot',
      '--user-id',
      recipient,
      '--msg-type',
      'text',
      '--content',
      '-',
      '--idempotency-key',
      createHash('sha256').update(id).digest('hex').slice(0, 40),
    ],
    { text },
  );
  if (typeof data.message_id !== 'string' || !data.message_id.startsWith('om_'))
    throw Error('Missing Feishu message receipt');
}
