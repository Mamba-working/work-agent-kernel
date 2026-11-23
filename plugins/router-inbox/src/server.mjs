import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {registerAppTool,registerAppResource,RESOURCE_MIME_TYPE} from '@modelcontextprotocol/ext-apps/server';
import {z} from 'zod';
import {readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {snapshot} from './records.mjs';
const uri='ui://router-inbox/records.html';
const server=new McpServer({name:'router-inbox',version:'0.2.0'});
const view={resourceUri:uri};
registerAppTool(server,'show_inbox',{title:'接入记录',description:'查看本机 Router 接入记录及关联事项。',inputSchema:{},annotations:{readOnlyHint:true},_meta:{ui:view,'openai/ui':{entrypoints:[{type:'global'},{type:'thread'}]}}},async()=>{
  const data=await snapshot();
  return {content:[{type:'text',text:'共 '+data.records.length+' 条接入记录'}],_meta:{data}};
});
registerAppTool(server,'open_session',{title:'打开关联的 Codex 会话',inputSchema:{session:z.string().uuid()},_meta:{ui:{visibility:['app']}}},async({session})=>{
  const data=await snapshot();
  if(!data.records.some(r=>r.tasks.some(t=>t.session===session)))throw new Error('没有找到与此会话关联的接入记录');
  if(process.platform!=='darwin')throw new Error('打开工作会话当前支持 macOS 上的 Codex Desktop');
  execFileSync('/usr/bin/open',['-b','com.openai.codex','codex://threads/'+session]);
  return {content:[{type:'text',text:'已请求 Desktop 打开会话'}]};
});
registerAppResource(server,'接入记录',uri,{},async()=>({contents:[{uri,mimeType:RESOURCE_MIME_TYPE,text:readFileSync(join(dirname(process.argv[1]),'view.html'),'utf8')}]}));
server.connect(new StdioServerTransport()).catch(e=>{console.error(e);process.exitCode=1});
