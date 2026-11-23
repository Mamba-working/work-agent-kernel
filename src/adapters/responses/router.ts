import { z } from 'zod';
import type { Route } from '../../core/domain.ts';
import type { Recall, RouteContext, Router } from '../../core/ports.ts';

import {instructions, DecisionSchema, formatSchema} from './policy.ts';

const CompletedResponseSchema = z.object({
  status: z.literal('completed'),
  output: z.array(z.object({ type: z.string(), content: z.unknown().optional() })),
});
const OutputTextSchema = z.array(z.object({ type: z.literal('output_text'), text: z.string() })).min(1);

function parseDecision(raw: unknown): Route {
  const response = CompletedResponseSchema.safeParse(raw);
  if (!response.success) throw new Error('Router received an incomplete or invalid Responses envelope');
  const message = response.data.output.findLast(item => item.type === 'message');
  const content = OutputTextSchema.safeParse(message?.content);
  if (!content.success) throw new Error('Router response is missing structured output');

  let decoded: unknown;
  try {
    decoded = JSON.parse(content.data.map(part => part.text).join(''));
  } catch {
    throw new Error('Router received invalid route JSON');
  }
  const result = DecisionSchema.safeParse(decoded);
  if (!result.success) throw new Error('Router received an invalid route decision');
  return result.data.decision;
}

export class ResponsesRouter implements Router {
  readonly #endpoint: URL;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #timeoutMs: number;

  constructor({ baseUrl, apiKey, model, timeoutMs = 60_000 }: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs?: number;
  }) {
    this.#endpoint = new URL(baseUrl);
    this.#endpoint.pathname = `${this.#endpoint.pathname.replace(/\/+$/, '')}/responses`;
    this.#apiKey = apiKey;
    this.#model = model;
    this.#timeoutMs = timeoutMs;
  }

  async decide(context: RouteContext, recall: Recall): Promise<Route> {
    const { workflows, harnesses, allowedScopes } = context;
    const candidates = context.hasMoreCandidates
      ? recall.listWorks().map(({ id, goal, execution, harness, scope }) => ({ id, goal, execution, harness, scope }))
      : context.candidates;
    const event = { ...context.event, ...recall.event(context.event.key), truncated: false };
    const input = JSON.stringify({ event, candidates, workflows, harnesses, allowedScopes });
    if (Buffer.byteLength(input) > 64 * 1024) throw new Error('Router input exceeds 64 KiB');

    const signal = AbortSignal.timeout(this.#timeoutMs);
    const response = await fetch(this.#endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#apiKey}`, 'content-type': 'application/json' },
      redirect: 'error',
      signal,
      body: JSON.stringify({
        model: this.#model,
        instructions,
        input,
        stream: false,
        store: false,
        max_output_tokens: 4096,
        text: { format: { type: 'json_schema', name: 'work_route', strict: true, schema: formatSchema } },
      }),
    }).catch(() => {
      throw new Error(signal.aborted ? 'Router request timed out' : 'Router request failed');
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Router request failed with HTTP ${response.status}`);
    }
    const raw: unknown = await response.json().catch(() => {
      throw new Error(signal.aborted ? 'Router request timed out' : 'Router received invalid response JSON');
    });
    const decision = parseDecision(raw);
    if (decision.kind === 'attach' && !candidates.some(candidate => candidate.id === decision.workId)) {
      throw new Error('Router selected an unknown work item');
    }
    if (decision.kind === 'create') {
      if (!harnesses.includes(decision.harness)) throw new Error('Router selected an unknown harness');
      if (!workflows.some(workflow => workflow.name === decision.workflow)) throw new Error('Router selected an unknown workflow');
      if (!allowedScopes.includes(decision.scope)) throw new Error('Router selected an unauthorized scope');
    }
    return decision;
  }
}
