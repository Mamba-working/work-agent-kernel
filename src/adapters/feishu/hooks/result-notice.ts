import type { LifecycleHook } from '../../../core/hooks/lifecycle.ts';
import { sendResultNotice } from '../channel.ts';

// Optional informational notification. Register explicitly with a fixed recipient.
export function feishuResultNotice(owner: string): LifecycleHook {
  if (!/^ou_[a-zA-Z0-9]+$/.test(owner)) throw Error('Invalid notification recipient');
  return {
    id: 'feishu.result-notice',
    phase: 'beforeNotify',
    run(input) {
      if (input.kind !== 'result' || input.notice.body.kind !== 'ready') return { kind: 'continue' };
      return { kind: 'continue', effect: { text: input.notice.body.summary, recipient: owner } };
    },
    deliver: ({ id, payload }) => sendResultNotice(id, payload),
  };
}
