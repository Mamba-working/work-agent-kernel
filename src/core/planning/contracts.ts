import { z } from 'zod';

export interface Reference {
  id: string;
  name: string;
}
export interface Evidence {
  id: string;
  chat: string;
  url: string;
  time: string;
}
export interface ContextPage {
  messages: { id: string; sender: string; text: string; url: string; time: string }[];
  next: string;
}
export type ContextReader = (
  source: Reference,
  start: string,
  end: string,
  cursor: string,
) => Promise<ContextPage>;

const evidenceIds = z.array(z.string()).describe('Copy exact message evidenceId strings from tools, or context[].evidence.id or read_selected_chat message IDs. Do not cite work, project or run IDs. Use [] when none.');
export const Action = z.strictObject({
  goal: z.string().min(1),
  project: z.string().min(1).nullable(),
  workId: z.string().min(1).nullable(),
  evidence: evidenceIds,
});
export const Report = z.strictObject({
  answer: z.string().min(1),
  evidence: evidenceIds,
  actions: z.array(Action).max(12),
});
export type Report = z.infer<typeof Report>;

export interface Candidate {
  id: string;
  goal: string;
  project: string | null;
  state: string;
}
export interface Target {
  id: string;
  name: string;
  harness: string;
}
export interface Catalog {
  defaultHarness: string;
  projects: Target[];
}
export interface PlanningRequest {
  id: string;
  origin: { kind: 'owner' | 'event'; actor: string; uri: string; source?:string; conversationId?:string|null };
  description: string;
  created: string;
  sources: Reference[];
  context: { text: string; evidence?: Evidence }[];
  projects: { id: string; name: string; selectedSourceIds: string[] }[];
  // Only these work items and projects may be used in the resulting plan.
  candidates: Candidate[];
  defaultProject: string | null;
  maxActions: number;
}
export interface AgentTools {
  specs: object[];
  call(params: unknown): Promise<unknown>;
}
export type PlanningRuntime = (
  request: PlanningRequest,
  tools: AgentTools,
  signal: AbortSignal,
  instructions: string,
) => Promise<unknown>;
