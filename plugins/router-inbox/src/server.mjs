import {ProjectRegistry,CreateProjectInput} from '../../../src/router/project-registry.ts';
import {homedir} from 'node:os';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {registerAppTool,registerAppResource,RESOURCE_MIME_TYPE} from '@modelcontextprotocol/ext-apps/server';
import {z} from 'zod';
import {readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {listChats,ChatSubmission} from '../../../src/adapters/feishu/chats.ts';
import {submitDispatch,dispatchHistory} from './dispatch-service.mjs';
import {desktopAccents} from './appearance.mjs';
import {snapshot,rememberOpened} from './records.mjs';
const uri='ui://router-inbox/project-sessions-v9.html';
const icons=['light','dark'].map(theme=>{
  const file=theme==='dark'?'project-chat-dark.png':'project-chat.png';
  const data=readFileSync(join(dirname(process.argv[1]),'assets',file)).toString('base64');
  return {src:'data:image/png;base64,'+data,mimeType:'image/png',sizes:['144x144'],theme};
});
const server=new McpServer({name:'router-inbox',version:'0.8.1',icons});
const view={resourceUri:uri};
registerAppTool(server,'show_inbox',{title:'项目会话',description:'查看本机 Router 接入记录及关联事项。',inputSchema:{},annotations:{readOnlyHint:true},_meta:{ui:view,'openai/ui':{entrypoints:[{type:'global'},{type:'thread'}]}}},async()=>{
  const data=await snapshot();data.accents=desktopAccents();
  return {content:[{type:'text',text:'共 '+data.records.length+' 条接入记录'}],_meta:{data}};
});
const appOnly={ui:{visibility:['app']}};
registerAppTool(server,'create_project',{title:'新建项目',inputSchema:CreateProjectInput.shape,_meta:appOnly},async input=>{
  const registry=new ProjectRegistry(process.env.ROUTER_INBOX_DIR??join(homedir(),'.local/state/router-inbox'));
  try{return {content:[],_meta:await registry.create(input)};}
  catch(error){return {isError:true,content:[{type:'text',text:error instanceof Error?error.message:'创建项目失败'}]};}
  finally{registry.close();}
});
registerAppTool(server,'desktop_appearance',{title:'读取 Desktop 强调色',inputSchema:{},annotations:{readOnlyHint:true},_meta:appOnly},async()=>({content:[],_meta:{accents:desktopAccents()}}));
registerAppTool(server,'select_chats',{title:'选择飞书聊天',inputSchema:{kind:z.enum(['p2p','group']),query:z.string().max(100),cursor:z.string().max(4096)},annotations:{readOnlyHint:true},_meta:appOnly},async({kind,query,cursor})=>({content:[],_meta:{data:await listChats(kind,query.trim(),cursor)}}));
registerAppTool(server,'submit_dispatch',{title:'交给 Router',inputSchema:ChatSubmission.shape,_meta:appOnly},async input=>({content:[],_meta:{id:submitDispatch(input)}}));
registerAppTool(server,'list_dispatches',{title:'查看主动派发进度',inputSchema:{},annotations:{readOnlyHint:true},_meta:appOnly},async()=>({content:[],_meta:{jobs:dispatchHistory(),accents:desktopAccents()}}));
registerAppTool(server,'open_session',{title:'打开关联的 Codex 会话',inputSchema:{session:z.string().uuid()},_meta:{ui:{visibility:['app']}}},async({session})=>{
  const data=await snapshot();
  if(!Object.values(data.projects).some(p=>p.sessions?.some(s=>s.id===session)) && !data.records.some(r=>r.tasks.some(t=>t.session===session)) && !dispatchHistory().some(j=>j.works.some(w=>w.session===session)))throw new Error('没有找到与此会话关联的接入记录');
  if(process.platform!=='darwin')throw new Error('打开工作会话当前支持 macOS 上的 Codex Desktop');
  execFileSync('/usr/bin/open',['-b','com.openai.codex','codex://threads/'+session]);
  try{rememberOpened(session);}catch{/* Opening the native chat succeeded even if preference storage is unavailable. */}
  return {content:[{type:'text',text:'已请求 Desktop 打开会话'}]};
});
registerAppResource(server,'项目会话',uri,{},async()=>({contents:[{uri,mimeType:RESOURCE_MIME_TYPE,text:readFileSync(join(dirname(process.argv[1]),'view.html'),'utf8')}]}));
server.connect(new StdioServerTransport()).catch(e=>{console.error(e);process.exitCode=1});
