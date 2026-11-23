import type { LifecycleHook, Resolution } from '../../core/hooks/lifecycle.ts';
import type { AdmissionGate, AdmissionChannel, Admission } from '../../adapters/feishu/admission-store.ts';
import { messageKey } from '../../adapters/feishu/inbox.ts';

function answer(row: Admission): Resolution | null {
  if (row.status === 'stopped') return { kind: 'break', reason: '本人已中断本条消息' };
  if (row.status === 'allowed')
    return { kind: 'continue', context: { approved: true, selectedProject: row.chosenProject } };
  return null;
}
export function feishuAdmission(
  source: string,
  gate: AdmissionGate,
  channel: AdmissionChannel,
): LifecycleHook {
  return {
    id: 'feishu.admission',
    phase: 'beforeRoute',
    run(input) {
      if (input.kind !== 'event' || input.event.source !== source) return { kind: 'continue' };
      const id = messageKey(input.event.externalId, input.event.revision);
      const row = gate.get(id);
      if (!row) return { kind: 'continue' };
      return answer(row) ?? { kind: 'wait', reason: '等待本人提交飞书决定卡', data: id, effect: id };
    },
    async deliver(effect) {
      await gate.sendPending(String(effect.payload), channel);
    },
    readResolution(data) {
      const row = gate.get(String(data));
      return row ? answer(row) : null;
    },
  };
}
