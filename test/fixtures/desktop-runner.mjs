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
{
  assert.equal(args[0], 'app-server');
  const file = join(process.cwd(), 'fixture-history.json');
  const history = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  let routerInput, withContext=false, evidence=[];
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    const { id, method, params } = message;
    if(id==='context' && message.result){
      const read=JSON.parse(message.result.contentItems[0].text);
      evidence=read.messages.map(m=>m.evidenceId);
      send({id:'list',method:'item/tool/call',params:{tool:'list_work_items',arguments:{}}});
      continue;
    }
    if (id === 'list' && message.result) {
      const works = JSON.parse(message.result.contentItems[0].text);
      const report = {answer:'fixture route', evidence, actions:[{goal:'fixture work',
        workId:works[0]?.id ?? null, project:routerInput.defaultProject, evidence:[]}]};
      send({method:'item/completed',params:{item:{type:'agentMessage',text:JSON.stringify(report)}}});
      send({method:'turn/completed',params:{turn:{status:'completed'}}});
      continue;
    }
    if (method === 'initialized') continue;
    let result = {};
    if (method === 'config/read') result={config:{}};
    else if (method === 'turn/start' && params.outputSchema) {
      routerInput=JSON.parse(params.input[0].text);
      send({id,result:{}});
      send({id:withContext?'context':'list',method:'item/tool/call',params:{tool:withContext?'read_incoming_context':'list_work_items',arguments:{}}});
      continue;
    } else if (method === 'thread/start' || method === 'thread/resume') {
      if (params.ephemeral) {
        withContext=params.dynamicTools.some(tool=>tool.name==='read_incoming_context');
        assert.match(params.developerInstructions, /name: merge-work/);
        assert(params.dynamicTools.some(tool => tool.name === 'get_work_item'));
      } else {
        assert.doesNotMatch(params.developerInstructions ?? '', /name: merge-work/);
        assert(!(params.dynamicTools ?? []).some(tool => tool.name === 'get_work_item'));
      }
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
