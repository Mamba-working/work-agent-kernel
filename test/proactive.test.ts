import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Kernel} from '../src/core/kernel.ts';
import {DispatchStore} from '../src/core/dispatch/store.ts';
import {RecordingHarness} from '../examples/support/adapters.ts';
import {processDispatch} from '../src/core/dispatch/process.ts';
import {toolbox,maxDays} from '../src/core/planning/tools.ts';
import {RouterBot} from '../src/core/planning/router.ts';
import type {PlanningRuntime,ContextReader,Reference} from '../src/core/planning/contracts.ts';
import type {TestContext} from 'node:test';
const group={id:'oc_demo1',name:'测试群',kind:'group' as const};
const dm={id:'oc_demo2',name:'模拟私聊',kind:'p2p' as const};
function fixture(t:TestContext){
 const dir=mkdtempSync(join(tmpdir(),'dispatch-test-'));const store=new DispatchStore(dir);
 const harness=new RecordingHarness('fixture');const kernel=new Kernel({path:join(dir,'k.sqlite'),harnesses:{codex:harness}});
 t.after(()=>{kernel.close();store.close();rmSync(dir,{recursive:true,force:true});});return {store,kernel,harness};
}
const signal=new AbortController().signal;
function process(store: DispatchStore, kernel: Kernel, runtime: PlanningRuntime, reader?: ContextReader) {
  return processDispatch(store,kernel,{defaultHarness:'codex',projects:[]},new RouterBot(runtime,reader),signal,()=>null);
}
const fakeRead=async(source:Reference,_s:string,_e:string,cursor:string)=>({messages:[{id:source.id+(cursor?'2':'1'),sender:'测试',text:'测试资料',url:'',time:'now'}],next:cursor?'':'p2'});
test('limits conversation reads to chosen chats and the requested one-day range',async t=>{
 const {store}=fixture(t),job=store.submit({id:randomUUID(),description:'仅分析最近一天',sources:[group]});
 const tool=toolbox(job,()=>[],()=>{},async(s,start,end,c)=>{assert.equal(Date.parse(end)-Date.parse(start),86400000);return fakeRead(s,start,end,c);});
 const args={sourceId:group.id,days:7,nextPage:false};
 await assert.rejects(tool.call({tool:'read_selected_chat',arguments:{...args,sourceId:dm.id}}));
 await tool.call({tool:'read_selected_chat',arguments:args});await tool.call({tool:'read_selected_chat',arguments:{...args,nextPage:true}});
 await assert.rejects(tool.call({tool:'read_selected_chat',arguments:{...args,nextPage:true}}));
 assert.equal(tool.refs.size,2);assert.equal(maxDays('最近七天'),7);
});
test('agent can read group, then DM, and finish analysis without creating work',async t=>{
 const {store,kernel}=fixture(t),job=store.submit({id:randomUUID(),description:'分析两个来源',sources:[group,dm]});
 await process(store,kernel,async(_request,tools)=>{
   for(const s of [group,dm])await tools.call({tool:'read_selected_chat',arguments:{sourceId:s.id,days:2,nextPage:false}});
   return {answer:'结论来自两处',evidence:[group.id+'1',dm.id+'1'],actions:[]};
 },fakeRead);
 const done=store.get(job.id);assert.equal(done.status,'done');assert.equal(done.refs.length,2);assert.equal(kernel.works().length,0);
});
test('create and attach use ordinary kernel dispatch, stable events and sessions after recovery',async t=>{
 const {store,kernel}=fixture(t);const existing=kernel.registerSession('codex','original-session','原验收清单');
 const job=store.submit({id:randomUUID(),description:'一项续接、一项新建',sources:[]});
 await process(store,kernel,async(_request,tools)=>{
   await tools.call({tool:'list_work_items',arguments:{}});
   return {answer:'安排两个事项',evidence:[],actions:[
     {goal:'给原清单补回滚检查',workId:existing,project:null,evidence:[]},
     {goal:'起草独立说明',workId:null,project:null,evidence:[]}]};
 });
 const done=store.get(job.id);assert.equal(done.workIds.length,2);assert.equal(done.workIds[0],existing);assert.equal(kernel.events().length,2);
 store.save({...done,status:'planned',workIds:[]});
 await process(store,kernel,async()=>{throw Error('must not ask model again')});
 assert.deepEqual(store.get(job.id).workIds,done.workIds);assert.equal(kernel.works().length,2);
 const run=await kernel.dispatch(existing);assert.equal(run?.request.sessionId,'original-session');
});
test('refuses unsupported evidence or a skipped chat before any dispatch',async t=>{
 const {store,kernel}=fixture(t);for(const sources of [[],[dm]]){
   const job=store.submit({id:randomUUID(),description:'用证据派单',sources});
   await process(store,kernel,async()=>({answer:'x',evidence:['unread'],actions:[]}));
   assert.equal(store.get(job.id).status,'failed');assert.equal(kernel.events().length,0);
 }
});
test('duplicate submit is idempotent; changed request cannot reuse the id',t=>{
 const {store}=fixture(t);const input={id:randomUUID(),description:'任务',sources:[dm]};store.submit(input);store.submit(input);
 assert.equal(store.list().length,1);assert.throws(()=>store.submit({...input,description:'其他'}));
});
