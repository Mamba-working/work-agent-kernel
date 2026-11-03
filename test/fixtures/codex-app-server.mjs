#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const historyPath = 'native-history.json';
const history = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, 'utf8')) : {};
const save = () => writeFileSync(historyPath, JSON.stringify(history));
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\n');
const text = (report, phase = 'final_answer') => ({
  type: 'agentMessage', text: JSON.stringify({ report }), phase,
});

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  switch (method) {
    case 'initialize':
      assert(process.env.WORK_AGENT_API_KEY);
      assert(!process.argv.some(arg => arg.includes(process.env.WORK_AGENT_API_KEY)));
      reply(id, {});
      break;
    case 'initialized':
      break;
    case 'config/read':
      reply(id, { config: { mcp_servers: { fixture: { enabled: true } } } });
      break;
    case 'thread/start':
    case 'thread/resume': {
      assert.equal(params.approvalPolicy, 'never');
      assert.equal(params.sandbox, 'read-only');
      assert.equal(params.config.mcp_servers.fixture.enabled, false);
      const threadId = params.threadId ?? `thread-${Object.keys(history).length + 1}`;
      const thread = method === 'thread/resume'
        ? history[threadId]
        : history[threadId] = { id: threadId, turns: [] };
      assert(thread);
      save();
      reply(id, { thread, approvalPolicy: 'never', sandbox: { type: 'readOnly', networkAccess: false } });
      break;
    }
    case 'turn/start': {
      assert.equal(params.approvalPolicy, 'never');
      assert.deepEqual(params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
      assert.equal(params.outputSchema.type, 'object');
      assert(params.outputSchema.properties.report.anyOf.length > 1);
      const thread = history[params.threadId];
      const [, raw] = params.input[0].text.split('\n');
      const request = JSON.parse(raw);
      appendFileSync('native-submissions.jsonl', JSON.stringify({ threadId: thread.id, goal: request.goal }) + '\n');
      if (request.goal === 'unconfirmed') process.exit(1);

      const turn = {
        id: `${thread.id}-turn-${thread.turns.length + 1}`,
        status: ['failed', 'interrupted'].includes(request.goal) ? request.goal : 'completed',
        items: [{ type: 'userMessage', content: params.input }],
      };
      if (request.goal === 'malformed') {
        turn.items.push(text({ kind: 'ready', summary: 'Commentary', artifact: '# Partial' }, 'commentary'));
        turn.items.push({ type: 'agentMessage', text: 'done', phase: 'final_answer' });
      } else if (request.goal === 'draft' && !request.decisions.length) {
        turn.items.push(text({
          kind: 'needs_input', summary: 'Scope choice needed', question: 'Include the failure state?', options: ['Yes', 'No'],
        }));
      } else {
        const ownerChoice = request.decisions[0]?.state.choice;
        const artifact = ownerChoice ? `# Draft\n\nOwner choice: ${ownerChoice}\n` : '# Draft\n\nPrepared content.\n';
        turn.items.push(text({ kind: 'ready', summary: 'Draft prepared', artifact }));
      }
      thread.turns.push(turn);
      save();
      if (request.goal === 'lost acknowledgment') process.exit(1);
      reply(id, { turn });
      break;
    }
    case 'thread/read':
      assert(params.includeTurns);
      reply(id, { thread: history[params.threadId] });
      break;
    default:
      assert.fail(`Unexpected fixture RPC: ${method}`);
  }
}
