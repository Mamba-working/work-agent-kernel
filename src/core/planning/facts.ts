import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { State, EventRecord, WorkItem } from '../domain.ts';
import type { Source } from '../ports.ts';
import type { Candidate, ContextPage, Evidence, PlanningRequest } from './contracts.ts';

const refSchema = z.object({
  type: z.enum(['project', 'message', 'work', 'run', 'attention', 'notice', 'live_message']),
  id: z.string().min(1),
});
type Ref = z.infer<typeof refSchema>;
const ref = (type: Ref['type'], id: string): Ref => ({ type, id });
const conversation = z.object({ source: z.string(), id: z.string() });
const paging = { limit: z.number().int().min(1).max(50).optional(), cursor: z.string().optional() };
const views = z.enum(['index', 'records']).optional();
const searchProjects = z
  .object({ ...paging, view: views, name: z.string().optional(), conversation: conversation.optional() })
  .strict();
const searchMessages = z
  .object({
    ...paging,
    view: views,
    projectId: z.string().optional(),
    conversation: conversation.optional(),
    workId: z.string().optional(),
    text: z.string().optional(),
    sender: z.string().optional(),
    since: z.iso.datetime().optional(),
    until: z.iso.datetime().optional(),
    disposition: z.enum(['routed', 'ignored', 'pending']).optional(),
    revisions: z.enum(['all', 'latest']).optional(),
  })
  .strict();
const trace = z.object({ ...paging, ref: refSchema.optional() }).strict();
const read = z
  .object({
    refs: z.array(refSchema).min(1).max(8).optional(),
    view: z.enum(['record', 'raw']).optional(),
    cursor: z.string().optional(),
  })
  .strict();
const descriptors: [string, string, z.ZodType][] = [
  [
    'find_projects',
    'Find visible projects by name or bound conversation. Follow a project ref for its registration.',
    searchProjects,
  ],
  [
    'find_messages',
    'Search admitted local archive (not live chat). Return versioned message refs, snippets and routing state. Use cursor alone for the next page.',
    searchMessages,
  ],
  [
    'trace_routing',
    'Trace a message revision or a work item through recorded decisions, actual worker runs, questions and notification delivery. Follow refs for full records.',
    trace,
  ],
  [
    'read_records',
    'Read complete authorized records by typed refs. view=raw reads the source-supplied business payload of a message. Join JSON text chunks in order when paginated.',
    read,
  ],
];
export const factSpecs = descriptors.map(([name, description, schema]) => ({
  name,
  description,
  inputSchema: z.toJSONSchema(schema),
}));

export interface ProjectFact {
  definition: unknown;
  bindings: { source: string; id: string }[];
}
export interface FactOptions {
  snapshot: () => State;
  sources: Source[];
  project?: (id: string) => ProjectFact | undefined;
  readerSource?: string;
}
type Message = {
  record: EventRecord;
  projectId: string | null;
  chat: string | null;
  text: string;
  admission: string;
  normalized: unknown;
  raw?: unknown;
  rawRestricted?: boolean;
};
const unavailable = () => Error('记录不可用或超出本次范围');
const own = <T>(items: Record<string, T>, id: string) => (Object.hasOwn(items, id) ? items[id] : undefined);

// One immutable set of records and opaque continuations per planning call.
export class RouterFacts {
  private readonly live = new Map<
    string,
    { sourceId: string; observedAt: string; message: ContextPage['messages'][number] }
  >();
  rememberLive(sourceId: string, message: ContextPage['messages'][number]) {
    const id = JSON.stringify([sourceId, message.id]);
    this.live.set(id, { sourceId, observedAt: new Date().toISOString(), message });
    return ref('live_message', id);
  }
  private state?: State;
  private archive?: Map<string, Message>;
  private projects?: Map<string, ProjectFact | undefined>;
  private readonly cursors = new Map<string, { tool: string; next: () => unknown }>();
  readonly inspectedWorks = new Set<string>();
  private observedAt = '';
  private readonly request: PlanningRequest;
  private readonly options: FactOptions;
  private readonly start: number;
  constructor(request: PlanningRequest, options: FactOptions, days: number) {
    this.request = request;
    this.options = options;
    this.start = Date.parse(request.created) - days * 86400000;
  }
  private snapshot() {
    if (!this.state) {
      this.state = this.options.snapshot();
      this.observedAt = new Date().toISOString();
      this.projects = new Map(
        this.request.projects.map((p) => [p.id, structuredClone(this.options.project?.(p.id))]),
      );
    }
    return this.state;
  }
  private messages() {
    if (this.archive) return this.archive;
    const result = new Map<string, Message>(),
      q = this.request;
    for (const record of Object.values(this.snapshot().events)) {
      const e = record.event,
        current = q.origin.kind === 'event' && record.key === q.id;
      const processed = record.disposition === 'ignored' || record.disposition === 'routed';
      if (!processed && !(current && record.disposition === 'pending')) continue;
      const source = this.options.sources.find((s) => s.name === e.source);
      const origin = source?.describeInput?.(e.text) ?? { conversationId: e.thread, text: e.text };
      const same =
        q.origin.source === e.source &&
        !!origin.conversationId &&
        q.origin.conversationId === origin.conversationId;
      const meta = source?.archiveRecord?.(e);
      if (meta && !['allowed', 'not_required'].includes(meta.admission)) continue;
      const projectId = meta?.projectId ?? null,
        projectAllowed = !!projectId && q.projects.some((p) => p.id === projectId);
      let visible = current;
      if (q.origin.kind === 'owner') {
        if (q.sources.length) {
          const time = Date.parse(e.occurredAt ?? record.receivedAt);
          visible =
            e.source === this.options.readerSource &&
            q.sources.some((s) => s.id === origin.conversationId) &&
            time >= this.start &&
            time <= Date.parse(q.created);
        } else visible = e.source === 'owner' || projectAllowed;
      } else if (!current)
        visible =
          (same && (!projectId || !q.defaultProject || projectId === q.defaultProject)) ||
          (projectAllowed && projectId === q.defaultProject);
      if (visible)
        result.set(record.key, {
          record,
          projectId,
          chat: origin.conversationId,
          text: origin.text,
          admission: meta?.admission ?? 'not_recorded',
          normalized: meta?.normalized ?? e,
          ...(meta?.rawRestricted ? { rawRestricted: true } : {}),
          ...(meta?.raw !== undefined ? { raw: meta.raw } : {}),
        });
    }
    this.archive = result;
    return result;
  }
  hasMessage(key: string) {
    return this.messages().has(key);
  }
  private work(id: string) {
    return this.request.candidates.some((c) => c.id === id) ? own(this.snapshot().works, id) : undefined;
  }
  private fullWork(w: WorkItem) {
    return w.inputs.length
      ? w.inputs.every((k) => this.hasMessage(k))
      : (this.request.origin.kind === 'owner' && !this.request.sources.length) ||
          Boolean(w.projectId && w.projectId === this.request.defaultProject);
  }
  private routedProjects(m: Message) {
    return [
      ...new Set(
        m.record.deliveries.flatMap((id) => {
          const project = this.work(id)?.projectId;
          return project ? [project] : [];
        }),
      ),
    ];
  }
  private history(m: Message) {
    const r = m.record;
    return {
      completeness: r.decisions === undefined || r.legacyHistory ? 'legacy_partial' : 'recorded',
      decisions:
        r.decisions?.map((d) => ({
          ...d,
          limited:
            d.workIds.some((id) => !this.work(id)) ||
            d.evidence.some((id) => !this.hasMessage(id) && id !== r.key),
          workIds: d.workIds.filter((id) => this.work(id)),
          evidence: d.evidence.filter((id) => this.hasMessage(id) || id === r.key),
        })) ?? [],
      targets: r.deliveries.filter((id) => this.work(id)).map((id) => ref('work', id)),
      reasons: r.reasons,
    };
  }
  private resolve(r: Ref, view: 'record' | 'raw') {
    const s = this.snapshot();
    if (r.type === 'live_message') {
      const item = this.live.get(r.id);
      if (!item) throw unavailable();
      return view === 'raw' ? { availability: 'not_retained' } : item;
    }
    if (view === 'raw' && r.type !== 'message') throw Error('raw 视图仅用于消息');
    if (r.type === 'project') {
      const p = this.request.projects.find((p) => p.id === r.id);
      if (!p) throw unavailable();
      const full =
        this.request.defaultProject === p.id ||
        (this.request.origin.kind === 'owner' && !this.request.sources.length);
      return full ? (this.projects?.get(p.id) ?? p) : { id: p.id, name: p.name, scope: 'index' };
    }
    if (r.type === 'message') {
      const m = this.messages().get(r.id);
      if (!m) throw unavailable();
      if (view === 'raw')
        return m.raw === undefined
          ? { availability: m.rawRestricted ? 'withheld' : 'not_retained' }
          : { availability: 'available', payload: m.raw };
      const { record, raw: _raw, ...data } = m;
      return {
        ...data,
        ref: r,
        event: { ...record.event, text: m.text },
        receivedAt: record.receivedAt,
        disposition: record.disposition,
        rawAvailable: m.raw !== undefined,
        ...this.history(m),
      };
    }
    if (r.type === 'work') {
      const w = this.work(r.id);
      if (!w) throw unavailable();
      if (this.fullWork(w)) return w;
      return {
        id: w.id,
        goal: w.goal,
        projectId: w.projectId,
        state: w.execution.kind,
        scope: 'limited',
        inputs: w.inputs.filter((k) => this.hasMessage(k)),
      };
    }
    const linked =
      r.type === 'run'
        ? own(s.runs, r.id)
        : r.type === 'attention'
          ? own(s.attentions, r.id)
          : own(s.outbox, r.id);
    if (!linked) throw unavailable();
    const w = this.work('notice' in linked ? linked.notice.workId : linked.workId);
    if (!w || !this.fullWork(w)) throw unavailable();
    if ('notice' in linked) {
      // Delivery receipts belong to the transport. Only expose business delivery state.
      return { ...linked, state: linked.state.kind === 'delivered' ? { kind: 'delivered' } : linked.state };
    }
    if ('request' in linked)
      return {
        ...linked,
        request: {
          ...linked.request,
          inputs: linked.request.inputs.map((input) => {
            const m = this.messages().get(input.key);
            if (!m) throw unavailable();
            return m.rawRestricted ? { ...input, text: m.text, transportRedacted: true } : input;
          }),
        },
      };
    return linked;
  }
  private page(
    tool: string,
    items: unknown[],
    limit: number,
    mode: string,
    offset = 0,
    onRead?: (item: unknown) => void,
  ): unknown {
    const end = Math.min(offset + limit, items.length);
    let nextCursor: string | null = null;
    if (end < items.length) {
      nextCursor = randomUUID();
      this.cursors.set(nextCursor, { tool, next: () => this.page(tool, items, limit, mode, end, onRead) });
    }
    for (const item of items.slice(offset, end)) onRead?.(item);
    return {
      source: tool === 'read_records' ? 'scoped_records' : 'local_archive',
      observedAt: this.observedAt,
      mode,
      items: items.slice(offset, end),
      nextCursor,
      complete: nextCursor === null,
    };
  }
  workPage(rows: Candidate[], limit: number, listed: Set<string>) {
    this.snapshot();
    return this.page('list_work_items', rows, limit, 'index', 0, (row) => listed.add((row as Candidate).id));
  }
  private trace(r: Ref) {
    const s = this.snapshot(),
      rows: unknown[] = [];
    if (r.type !== 'work' && r.type !== 'message') throw Error('从消息或事项引用开始追溯');
    const message = r.type === 'message' ? this.messages().get(r.id) : undefined;
    const work = r.type === 'work' ? this.work(r.id) : undefined;
    if (!message && !work) throw unavailable();
    if (message)
      rows.push({
        evidenceId: message.record.key,
        ref: r,
        stage: 'routing',
        admission: message.admission,
        disposition: message.record.disposition,
        ...this.history(message),
      });
    if (work)
      for (const k of work.inputs) {
        const m = this.messages().get(k);
        if (m) rows.push({ ref: ref('message', k), evidenceId: k, stage: 'input', ...this.history(m) });
      }
    const ids = work ? [work.id] : message!.record.deliveries;
    for (const id of ids) {
      const w = this.work(id);
      if (!w) continue;
      rows.push({
        ref: ref('work', id),
        stage: 'work',
        goal: w.goal,
        state: w.execution.kind,
        scope: this.fullWork(w) ? 'full' : 'limited',
      });
      if (!this.fullWork(w)) continue;
      for (const run of Object.values(s.runs)) {
        if (run.workId !== id || (message && !run.request.inputs.some((i) => i.key === r.id))) continue;
        rows.push({
          ref: ref('run', run.id),
          stage: 'run',
          state: run.state.kind,
          sessionId: 'receipt' in run.state ? run.state.receipt.sessionId : run.request.sessionId,
          outcome: 'report' in run.state ? run.state.report.kind : null,
        });
        const notices = [String(run.id)];
        for (const a of Object.values(s.attentions))
          if (a.runId === run.id) {
            rows.push({ ref: ref('attention', a.id), stage: 'attention', state: a.state.kind });
            notices.push(a.id);
          }
        for (const n of notices) {
          const item = own(s.outbox, n);
          if (item) rows.push({ ref: ref('notice', n), stage: 'notification', state: item.state.kind });
        }
      }
    }
    return rows;
  }
  private cite(m: Message, refs: Map<string, Evidence>) {
    refs.set(m.record.key, {
      id: m.record.key,
      chat: m.chat ?? '',
      time: m.record.receivedAt,
      url: m.record.event.uri,
    });
  }
  call(tool: string, args: unknown, refs: Map<string, Evidence>): unknown {
    const c = z.object({ cursor: z.string().optional() }).parse(args).cursor;
    if (c !== undefined) {
      z.strictObject({ cursor: z.string() }).parse(args);
      const continuation = this.cursors.get(c);
      if (continuation?.tool !== tool) throw Error('无效的本轮分页游标');
      this.cursors.delete(c);
      return continuation.next();
    }
    this.snapshot();

    if (tool === 'find_projects') {
      const a = searchProjects.parse(args);
      const found = this.request.projects.filter(
        (p) =>
          (!a.name || (p.name + ' ' + p.id).toLowerCase().includes(a.name.toLowerCase())) &&
          (!a.conversation ||
            (this.projects
              ?.get(p.id)
              ?.bindings.some((b) => b.source === a.conversation!.source && b.id === a.conversation!.id) &&
              (p.id === this.request.defaultProject ||
                (this.request.origin.kind === 'owner' &&
                  (!this.request.sources.length ||
                    this.request.sources.some((s) => s.id === a.conversation!.id)))))),
      );
      if (a.view === 'records')
        return this.records(
          tool,
          found.map((p) => ref('project', p.id)),
          'record',
          1,
          refs,
        );
      return this.page(
        tool,
        found.map((p) => ({ ref: ref('project', p.id), name: p.name })),
        a.limit ?? 20,
        'index',
      );
    }
    if (tool === 'find_messages') {
      const a = searchMessages.parse(args),
        work = a.workId ? this.work(a.workId) : undefined;
      if (a.workId && !work) throw unavailable();
      let messages = [...this.messages().values()]
        .reverse()
        .sort((x, y) => y.record.receivedAt.localeCompare(x.record.receivedAt));
      if (a.revisions === 'latest') {
        const seen = new Set<string>();
        messages = messages.filter((m) => {
          const k = JSON.stringify([m.record.event.source, m.record.event.externalId]);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
      const found = messages.filter((m) => {
        const e = m.record.event,
          t = Date.parse(e.occurredAt ?? m.record.receivedAt);
        return (
          (!a.projectId || a.projectId === m.projectId || this.routedProjects(m).includes(a.projectId)) &&
          (!work || work.inputs.includes(m.record.key)) &&
          (!a.conversation || (a.conversation.source === e.source && a.conversation.id === m.chat)) &&
          (!a.sender || a.sender === e.actor) &&
          (!a.text || m.text.toLowerCase().includes(a.text.toLowerCase())) &&
          (!a.disposition || a.disposition === m.record.disposition) &&
          (!a.since || t >= Date.parse(a.since)) &&
          (!a.until || t <= Date.parse(a.until))
        );
      });
      if (a.view === 'records')
        return this.records(
          tool,
          found.map((m) => ref('message', m.record.key)),
          'record',
          1,
          refs,
        );
      return this.page(
        tool,
        found.map((m) => ({
          ref: ref('message', m.record.key),
          evidenceId: m.record.key,
          projectId: m.projectId,
          routedProjectIds: this.routedProjects(m),
          conversationId: m.chat,
          revision: m.record.event.revision,
          sender: m.record.event.actor,
          receivedAt: m.record.receivedAt,
          snippet: m.text.slice(0, 240),
          disposition: m.record.disposition,
        })),
        a.limit ?? 20,
        'index',
        0,
        (item) => this.cite(this.messages().get((item as { ref: Ref }).ref.id)!, refs),
      );
    }
    if (tool === 'trace_routing') {
      const a = trace.parse(args);
      if (!a.ref) throw Error('缺少起始引用');
      return this.page(tool, this.trace(a.ref), a.limit ?? 20, 'trace', 0, (row) => {
        const { evidenceId: id, ref: target } = row as { evidenceId?: string; ref: Ref };
        if (target.type === 'work') this.inspectedWorks.add(target.id);
        if (id) this.cite(this.messages().get(id)!, refs);
      });
    }
    const a = read.parse(args);
    if (!a.refs) throw Error('缺少记录引用');
    return this.records(tool, a.refs, a.view ?? 'record', 1, refs);
  }
  private records(
    tool: string,
    refsToRead: Ref[],
    view: 'record' | 'raw',
    limit: number,
    refs: Map<string, Evidence>,
  ) {
    const items: unknown[] = [];
    for (const r of refsToRead) {
      const value = this.resolve(r, view);
      const chars = Array.from(JSON.stringify(value));
      const provenance = r.type === 'live_message' ? 'live_channel' : 'local_archive';
      const evidence =
        r.type === 'message'
          ? { evidenceId: r.id }
          : r.type === 'live_message'
            ? { evidenceId: this.live.get(r.id)!.message.id }
            : {};
      if (chars.length <= 6000) items.push({ ref: r, ...evidence, provenance, value });
      else
        for (let offset = 0; offset < chars.length; offset += 6000)
          items.push({
            ref: r,
            ...evidence,
            provenance,
            encoding: 'json-text',
            offset,
            total: chars.length,
            chunk: chars.slice(offset, offset + 6000).join(''),
          });
    }
    return this.page(tool, items, limit, 'records', 0, (item) => {
      const { ref: r } = item as { ref: Ref };
      if (r.type === 'work') this.inspectedWorks.add(r.id);
      if (r.type === 'message') this.cite(this.messages().get(r.id)!, refs);
    });
  }
}
