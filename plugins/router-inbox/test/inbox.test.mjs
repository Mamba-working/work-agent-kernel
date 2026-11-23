import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {RouterInbox} from '../../../src/adapters/feishu/inbox.ts';

const bundle=fileURLToPath(new URL('../dist/router-inbox/server.cjs',import.meta.url));
async function fixture(t){
  const temp=mkdtempSync(join(tmpdir(),'router-plugin-'));
  const state=join(temp,'state');
  const client=new Client({name:'router-inbox-test',version:'1.0.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[bundle],env:{ROUTER_INBOX_DIR:state}}));
  t.after(async()=>{await client.close();rmSync(temp,{recursive:true,force:true});});
  return {state,client};
}

test('global and conversation entrypoints load the packaged UI without a running Router',async t=>{
  const {client}=await fixture(t);
  const tool=(await client.listTools()).tools.find(t=>t.name==='show_inbox');
  assert.deepEqual(tool._meta['openai/ui'].entrypoints.map(e=>e.type),['global','thread']);
  const view=await client.readResource({uri:tool._meta.ui.resourceUri});
  assert.equal(view.contents[0].mimeType,'text/html;profile=mcp-app');
  assert.match(view.contents[0].text,/<title>项目会话<\/title>/);
  const result=await client.callTool({name:'show_inbox',arguments:{}});
  assert.deepEqual(result._meta.data.records,[]);
});

test('plugin reads messages and project ownership from the public receiver',async t=>{
  const {client,state}=await fixture(t);mkdirSync(state);
  const projects={example:{name:'示例项目',cwd:state,feishuChatId:'example-group'}};
  const inbox=new RouterInbox(join(state,'feishu.sqlite'),projects);
  try{inbox.receive({message_id:'sample',chat_id:'example-group',content:'示例消息'});}finally{inbox.close();}
  writeFileSync(join(state,'health.json'),JSON.stringify({at:new Date().toISOString(),errors:[],projects}));
  const result=await client.callTool({name:'show_inbox',arguments:{}});
  assert.deepEqual(result._meta.data.warnings,[]);
  assert.equal(result._meta.data.records[0].projectId,'example');
  assert.equal(result._meta.data.records[0].text,'示例消息');
});

test('session action rejects an unrelated session before opening a desktop URL',async t=>{
  const {client}=await fixture(t);
  const result=await client.callTool({name:'open_session',arguments:{session:'12345678-1234-4123-8123-123456789abc'}});
  assert.equal(result.isError,true);
});

test('proactive submission is app-only, idempotent and visible from a fresh client query',async t=>{
  const {client}=await fixture(t);
  const tools=await client.listTools();
  for(const name of ['select_chats','submit_dispatch','list_dispatches'])assert.deepEqual(tools.tools.find(tool=>tool.name===name)._meta.ui.visibility,['app']);
  const input={id:'f039d504-4845-4e19-bac8-9c9c7d410336',description:'请整理任务',sources:[]};
  for(let i=0;i<2;i++){const r=await client.callTool({name:'submit_dispatch',arguments:input});assert.equal(r._meta.id,input.id);}
  const list=(await client.callTool({name:'list_dispatches',arguments:{}}))._meta.jobs;
  assert.equal(list.length,1);assert.equal(list[0].status,'queued');assert.equal(list[0].description,input.description);
});

test('Desktop accent is read fresh per theme and only valid colors are returned',async t=>{
  const {desktopAccents}=await import('../src/appearance.mjs');
  const home=mkdtempSync(join(tmpdir(),'router-theme-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const file=join(home,'config.toml');
  assert.deepEqual(desktopAccents(home),{});
  writeFileSync(file,'[desktop.appearanceLightChromeTheme]\naccent="#3a83f7"\nprivateSetting="not exposed"\n[desktop.appearanceDarkChromeTheme]\naccent="#ABC123"\n');
  assert.deepEqual(desktopAccents(home),{light:'#3a83f7',dark:'#ABC123'});
  writeFileSync(file,'[desktop.appearanceLightChromeTheme]\naccent="#112233"');
  assert.deepEqual(desktopAccents(home),{light:'#112233'});
});


test('waiting and stopped receipts show their decision state before kernel collection',async t=>{
  const {client,state}=await fixture(t);mkdirSync(state);
  const projects={example:{name:'Example',cwd:state}};
  const box=new RouterInbox(join(state,'feishu.sqlite'),projects);
  try{
    box.admission.enable('ou_demo');
    const id=box.receive({message_id:'greeting',chat_id:'unknown-chat',content:'sample'});
    const list=async()=>(await client.callTool({name:'show_inbox',arguments:{}}))._meta.data;
    assert.equal((await list()).records[0].status,'awaiting_owner');
    await box.admission.deliverOne({async send(){return 'om_demo';},async update(){}});
    box.admission.submit(id,'ou_demo','om_demo',{project:'example',execute:false});
    writeFileSync(join(state,'health.json'),JSON.stringify({at:new Date().toISOString(),errors:[],projects,conversationBindings:box.admission.bindings()}));
    const data=await list();
    assert.equal(data.records[0].status,'stopped');assert.equal(data.records[0].projectId,'example');
    assert.equal(data.projects.example.groups[0].id,'unknown-chat');
  }finally{box.close();}
});


test('project overview includes persisted Codex work and preserves registered titles',async t=>{
  const {client,state}=await fixture(t);mkdirSync(state);
  const seed='00000000-0000-4000-a000-000000000001';
  const other='00000000-0000-4000-a000-000000000002';
  const projects={p:{name:'Example',cwd:state,sessions:[{id:seed,title:'登记的标题'}]}};
  writeFileSync(join(state,'health.json'),JSON.stringify({at:new Date().toISOString(),errors:[],projects}));
  writeFileSync(join(state,'last-opened-session'),other);
  const db=new DatabaseSync(join(state,'kernel.sqlite'));
  try{
    db.exec('CREATE TABLE state(id INTEGER PRIMARY KEY,body TEXT NOT NULL)');
    db.prepare('INSERT INTO state VALUES (1,?)').run(JSON.stringify({events:{},works:{
      old:{id:'old',harness:'codex/p',sessionId:seed,goal:'旧标题'},
      new:{id:'new',harness:'codex/p',projectId:'p',sessionId:other,goal:'新增事项'},
      foreign:{id:'foreign',harness:'other',projectId:'p',sessionId:'not-codex',goal:'其他执行器'}
    }}));
  }finally{db.close();}
  const result=await client.callTool({name:'show_inbox',arguments:{}});
  assert.deepEqual(result._meta.data.projects.p.sessions,[{id:seed,title:'登记的标题'},{id:other,title:'新增事项'}]);
  assert.equal(result._meta.data.lastOpened,other);
});

test('a newly created project is admitted by the running Router and visible from the packaged plugin',async t=>{
  const {client,state}=await fixture(t);
  const {serve}=await import('../../../src/router/service.ts');
  const stop=new AbortController(),service=serve(state,{},process.execPath,stop.signal);
  try{
    const tools=(await client.listTools()).tools;
    assert.deepEqual(tools.find(item=>item.name==='create_project')._meta.ui.visibility,['app']);
    const input={requestId:'b0000000-0000-4000-8000-000000000001',name:'示例项目',cwd:state};
    const first=await client.callTool({name:'create_project',arguments:input});
    assert(!first.isError);const {id}=first._meta;
    const retry=await client.callTool({name:'create_project',arguments:input});
    assert.equal(retry._meta.id,id);
    const snapshot=(await client.callTool({name:'show_inbox',arguments:{}}))._meta.data;
    assert.deepEqual(snapshot.projects[id],{name:input.name,cwd:input.cwd});
  }finally{stop.abort();await service;}
});
