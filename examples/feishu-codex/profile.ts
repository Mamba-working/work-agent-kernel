import { readFileSync } from 'node:fs';
import type { RouterExtension } from '../../src/core/index.ts';
import { feishuIncomingContext } from '../../src/adapters/feishu/incoming-context.ts';
import { selectedChats } from '../../src/adapters/feishu/selected-chats.ts';
import { readChat } from '../../src/adapters/feishu/chats.ts';
import { feishuAdmission } from '../../src/hooks/feishu/admission.ts';
import type { AdmissionChannel } from '../../src/adapters/feishu/admission-store.ts';
import type { RouterInbox } from '../../src/adapters/feishu/inbox.ts';
import { inboxContext } from '../../src/adapters/feishu/context.ts';

import { codexPlanner } from '../../src/adapters/codex/planner.ts';

export function maxDays(description: string) {
  const m = description.match(/(?:最近|过去|近)\s*(\d+|一|两|二|三|七|十)\s*天/);
  if (description.includes('24小时') || description.includes('24 小时') || description.includes('最近一天'))
    return 1;
  const n = m?.[1];
  if (n)
    return Math.min(30, Math.max(1, Number(n) || ({ 一: 1, 两: 2, 二: 2, 三: 3, 七: 7, 十: 10 }[n] ?? 1)));
  return /一周|本周/.test(description) ? 7 : /一个月|本月/.test(description) ? 30 : 3;
}

const guide = readFileSync(new URL('./skills/merge-work/SKILL.md', import.meta.url), 'utf8');
export const mergeWork: RouterExtension = () => ({ instructions: guide });

export function localRouterProfile(
  inbox: RouterInbox,
  executable: string,
  harnessFor: (id: string) => string,
  channel: AdmissionChannel,
  extra: RouterExtension[] = [],
) {
  return {
    runtime: codexPlanner(executable),
    ingress: [feishuIngress(inbox, harnessFor, channel)],
    router: {
      extensions: [mergeWork, feishuIncomingContext(inbox), selectedChats(readChat, maxDays), ...extra],
    },
    selectedArchive: { source: inbox.name, historyDays: maxDays },
    ownerActionLimit: (description: string) =>
      /仅分析|只(?:做)?分析|不(?:要|用)(?:创建|派发|分配|执行)任务|不(?:要)?派单/u.test(description) ? 0 : 12,
  };
}

export function feishuIngress(
  inbox: RouterInbox,
  harnessFor: (id: string) => string,
  channel: AdmissionChannel,
) {
  return {
    source: {
      name: inbox.name,
      fetch: () => inbox.fetchForAdmission(),
      describeInput: inbox.describeInput.bind(inbox),
      archiveRecord: inbox.archiveRecord.bind(inbox),
    },
    context: inboxContext(inbox, harnessFor),
    hooks: [feishuAdmission(inbox.name, inbox.admission, channel)],
  };
}
