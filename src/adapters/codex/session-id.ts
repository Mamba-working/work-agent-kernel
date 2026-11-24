import { z } from 'zod';

export function codexSessionId(input: string): string {
  const id = input
    .trim()
    .replace(/^codex:\/\/threads\//i, '')
    .replace(/\/$/, '')
    .toLowerCase();
  if (!z.uuid().safeParse(id).success) throw Error('工作会话需要有效的会话 UUID 或 codex://threads/ 链接。');
  return id;
}
