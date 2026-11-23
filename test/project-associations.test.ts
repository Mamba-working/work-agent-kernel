import test from 'node:test';
import assert from 'node:assert/strict';
import {RouterInbox} from '../src/adapters/feishu/inbox.ts';
import {setup,running} from './support.ts';
import {ScriptedRouter} from '../examples/support/adapters.ts';
test('two groups and an alternate group ID target the same project',t=>{
  const box=new RouterInbox(':memory:',{p:{name:'P',cwd:'.',groups:[{name:'A',id:'oc_a',aliases:['123']},{name:'B',id:'oc_b'}]}});
  t.after(()=>box.close());for(const id of ['oc_a','123','oc_b']){
    const m={message_id:id,chat_id:id,content:'hello'};box.receive(m);
    assert.equal(box.context(JSON.stringify(['feishu',id,'1']),JSON.stringify(m))?.project.id,'p');
  }
});
test('two imported sessions are independent, idle, and attach resumes the selected one',async t=>{
  const f=setup(t);const kernel=f.open();const a=kernel.registerSession('recording','session-A','existing A');
  const b=kernel.registerSession('recording','session-B','existing B');assert.notEqual(a,b);
  assert.equal(kernel.registerSession('recording','session-A','existing A'),a);assert.equal(kernel.work(a).execution.kind,'idle');
  const box=new RouterInbox(':memory:');t.after(()=>box.close());box.receive({message_id:'follow',content:'follow up B'});
  await kernel.collect(box);kernel.router=new ScriptedRouter([{kind:'attach',reason:'B',workId:b}]);await kernel.routeNext();
  const run=running(await kernel.dispatch(b));assert.equal(run.receipt.sessionId,'session-B');
  assert.equal(kernel.work(a).inputs.length,0);assert.equal(f.harness.requests.length,1);
});
