import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {RouterInbox} from '../../../src/router/inbox.ts';

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
  assert.match(view.contents[0].text,/消息流/);
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
