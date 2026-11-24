import { feishuAdmission } from '../hooks/feishu/admission.ts';
import type { AdmissionChannel } from '../adapters/feishu/admission-store.ts';
import type { RouterInbox } from '../adapters/feishu/inbox.ts';
import { inboxContext } from '../adapters/feishu/context.ts';

export function feishuIngress(
  inbox: RouterInbox,
  harnessFor: (id: string) => string,
  channel: AdmissionChannel,
) {
  return {
    source: { name: inbox.name, fetch: () => inbox.fetchForAdmission(), describeInput:(raw:string)=>inbox.describeInput(raw) },
    context: inboxContext(inbox, harnessFor),
    hooks: [feishuAdmission(inbox.name, inbox.admission, channel)],
  };
}
