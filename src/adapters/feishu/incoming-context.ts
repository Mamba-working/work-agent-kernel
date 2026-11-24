import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { RouterExtension } from '../../core/planning/extensions.ts';
import type { ContextRead } from './context-access.ts';
import { messageKey, type RouterInbox } from './inbox.ts';
import { readPrecedingMessages } from './chats.ts';

const instructions = readFileSync(new URL('./skills/incoming-context.md', import.meta.url), 'utf8');

export function feishuIncomingContext(inbox: RouterInbox, read = readPrecedingMessages): RouterExtension {
  return (request) => {
    if (request.origin.kind !== 'event' || request.origin.source !== inbox.name) return;
    const [, id, revision] = JSON.parse(request.id);
    const key = messageKey(id, revision);
    const store = inbox.admission.context;
    const sourceChat = request.origin.conversationId ?? '';
    const group =
      request.defaultProject && !inbox.admission.get(key) && inbox.admission.boundProject(sourceChat);
    const address = group ? inbox.admission.sourceAddress(sourceChat) : null;
    const permit = store.permission(key) ?? (address ? { chat: address } : undefined);
    if (!permit) return;
    const until = request.origin.receivedAt!;
    async function snapshot(): Promise<ContextRead> {
      const previous = store.read(key);
      if (previous) return previous;
      const chat = permit!.chat;
      let result: ContextRead = { chat, until, status: 'unmapped', messages: [] };
      if (chat) {
        const anchor = inbox.messageAnchor(key);
        try {
          const messages = await read(chat, until, anchor);
          result = { chat, until, status: messages.length ? 'read' : 'empty', messages };
        } catch {
          result.status = 'unavailable';
        }
      }
      return store.save(key, result);
    }
    let loaded: Promise<ContextRead> | undefined;
    return {
      instructions,
      tools: [
        {
          name: 'read_incoming_context',
          description: 'Read earlier messages in the approved incoming conversation. No arguments.',
          schema: z.strictObject({}),
          required: true,
          async run() {
            const result = await (loaded ??= snapshot());
            return {
              value: { ...result, messages: result.messages.map((m) => ({ ...m, evidenceId: m.id })) },
              evidence: result.messages.map((m) => ({
                id: m.id,
                sourceLabel: result.chat!,
                time: m.time,
                url: m.url,
              })),
            };
          },
        },
      ],
    };
  };
}
