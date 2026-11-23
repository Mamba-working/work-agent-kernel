#!/usr/bin/env node
// Wire simulator for the portable Desktop execution path, with no local credentials.
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
assert(
  !args.some(
    (x) => x === '-m' || x === '--model' || x.includes('model_provider') || x.includes('model_reasoning_effort'),
  ),
);
if (args[0] === 'exec') {
  const input = readFileSync(0, 'utf8');
  const context = JSON.parse(input.slice(input.lastIndexOf('\n') + 1));
  const decision = context.candidates.length
    ? { kind: 'attach', reason: 'existing fixture goal', workId: context.candidates[0].id }
    : {
        kind: 'create',
        reason: 'fixture goal',
        harness: context.harnesses[0],
        scope: 'prepare',
        workflow: 'general',
        goal: 'fixture work',
      };
  writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({ decision }));
} else {
  const file = join(process.cwd(), 'fixture-history.json');
  const history = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  for await (const line of createInterface({ input: process.stdin })) {
    const { id, method, params } = JSON.parse(line);
    if (method === 'initialized') continue;
    let result = {};
    if (method === 'thread/start' || method === 'thread/resume') {
      assert.equal(params.model, undefined);
      assert.equal(params.modelProvider, undefined);
      assert.equal(params.config?.model_reasoning_effort, undefined);
      const tid = params.threadId ?? 'fixture-session-' + Object.keys(history).length;
      if (method === 'thread/resume') assert(history[tid]);
      else history[tid] = { id: tid, turns: [] };
      result = {
        thread: history[tid],
        approvalPolicy: 'never',
        sandbox: { type: 'readOnly', networkAccess: false },
      };
    } else if (method === 'turn/start') {
      assert.equal(params.outputSchema, undefined);
      const thread = history[params.threadId];
      const turn = {
        id: 'turn-' + thread.turns.length,
        status: 'completed',
        items: [
          { type: 'userMessage', content: params.input },
          { type: 'agentMessage', phase: 'final_answer', text: '可继续追问的模拟结果' },
        ],
      };
      thread.turns.push(turn);
      result = { turn };
      writeFileSync(file, JSON.stringify(history));
    } else if (method === 'thread/read') {
      result = { thread: history[params.threadId] };
    } else assert.equal(method, 'initialize');
    process.stdout.write(JSON.stringify({ id, result }) + '\n');
  }
}
