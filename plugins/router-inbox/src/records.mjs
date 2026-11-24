import {loadProjects} from '../../../src/router/project-registry.ts';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {existsSync,readFileSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
const home=homedir();
const directory=process.env.ROUTER_INBOX_DIR??join(home,'.local/state/router-inbox');
function read(file,sql){
  const db=new DatabaseSync(file,{readOnly:true,timeout:2000});
  try{return db.prepare(sql).all();}finally{db.close();}
}
function messageText(content){
  try{
    const value=JSON.parse(content);
    if(typeof value?.text==='string')return value.text;
  }catch{}
  return content;
}
function kernelRecords(source,dir){
  const file=join(dir,'kernel.sqlite');
  const state=existsSync(file)?JSON.parse(read(file,'SELECT body FROM state WHERE id=1')[0].body):{events:{},works:{}};
  const key=e=>JSON.stringify([e.source,e.externalId,e.revision]);
  const routed=new Map(Object.values(state.events).map(record=>[key(record.event),record]));
  const inbox=join(dir,'feishu.sqlite');
  function tasksFor(record){
    return (record?.deliveries??[]).map(id=>{
      const w=state.works[id];
      return {id:w.id,project:w.projectId===undefined?(w.harness.startsWith('codex/')?w.harness.slice(6):null):w.projectId,goal:w.goal,status:w.execution.kind,result:w.results.at(-1)?.report?.summary,session:(w.harness==='codex'||w.harness.startsWith('codex/'))?w.sessionId:null};
    });
  }
  const owner=Object.values(state.events).filter(r=>r.event.source==='owner').map(r=>{
    const tasks=tasksFor(r);
    return {id:r.event.externalId,revision:r.event.revision,projectId:tasks[0]?.project??null,source:'主动派发',actor:'本人',chat:'',text:r.event.text,time:r.receivedAt,status:r.disposition,reason:r.reasons.join(' · '),tasks};
  });
  const workSessions=Object.values(state.works).filter(w=>w.sessionId&&(w.harness==='codex'||w.harness.startsWith('codex/')))
    .map(w=>({project:w.projectId===undefined?w.harness.slice(6):w.projectId,id:w.sessionId,title:w.goal}));
  if(!existsSync(inbox))return {records:owner,workSessions};
  const reviews = new Map();
  if(read(inbox,"SELECT 1 FROM sqlite_master WHERE type='table' AND name='admissions'").length){
    for(const row of read(inbox,"SELECT eventId,status FROM admissions WHERE status IN ('waiting','stopped')"))reviews.set(row.eventId,row.status);
  }
  const indexed=read(inbox,"SELECT name FROM sqlite_master WHERE type='table' AND name='project_events'").length;
  const incoming=read(inbox,indexed
    ? 'SELECT i.id,i.event,p.project_id FROM incoming i LEFT JOIN project_events p ON p.event_id=i.id ORDER BY i.rowid DESC'
    : 'SELECT id,event,NULL AS project_id FROM incoming ORDER BY rowid DESC');
  const hasContext=read(inbox,"SELECT name FROM sqlite_master WHERE type='table' AND name='context_reads'").length;
  const reads=new Map((hasContext ? read(inbox,'SELECT event_id,body FROM context_reads') : []).map(r=>[r.event_id,JSON.parse(r.body)]));
  const records=owner.concat(incoming.map(({id,event,project_id})=>{
    const e=JSON.parse(event),item=JSON.parse(e.text),record=routed.get(key(e)),tasks=tasksFor(record);
    const context=reads.get(id);
    const cited=new Set(record?.decisions?.at(-1)?.evidence??[]);
    const contextRead=context?{status:context.status,chat:context.chat,until:context.until,count:context.messages.length,
      citations:context.messages.filter(m=>cited.has(m.id)).map(m=>({id:m.id,text:m.text,sender:m.sender}))}:undefined;
    return {contextRead,id:e.externalId,revision:e.revision,projectId:project_id,source,actor:e.actor,chat:item.chat_id,text:messageText(item.content),time:record?.receivedAt,status:({waiting:'awaiting_owner',stopped:'stopped'})[reviews.get(id)]??record?.disposition??'pending',reason:record?.reasons.join(' · '),tasks};
  }));
  return {records,workSessions};
}
const recentFile=join(directory,'last-opened-session');
export function rememberOpened(id){
  mkdirSync(directory,{recursive:true,mode:0o700});
  const temp=recentFile+'.'+randomUUID();writeFileSync(temp,id,{mode:0o600});renameSync(temp,recentFile);
}
export async function snapshot(){
  const warnings=[];
  let records=[],projects={},workSessions=[];
  try{({records,workSessions}=kernelRecords('Router',directory));}catch(e){warnings.push('Router：'+e.message);}
  try{projects=loadProjects(directory,{});}catch(e){warnings.push('项目：'+e.message);}
  try{
    const health=JSON.parse(readFileSync(join(directory,'health.json'),'utf8'));
    projects={...(health.projects??{}),...projects};
    for(const {project,id,title} of workSessions){
      const p=projects[project];
      if(p&&!p.sessions?.some(s=>s.id===id))(p.sessions??=[]).push({id,title});
    }
    for(const {chat_id,project_id,name} of health.conversationBindings??[]){
      const p=projects[project_id];
      if(p && p.feishuChatId!==chat_id && !p.groups?.some(g=>g.id===chat_id||g.aliases?.includes(chat_id))){
        (p.groups??=[]).push({id:chat_id,name:name||chat_id});
      }
    }
    if(health.admission?.enabled && !health.admission.listening)warnings.push('飞书决策卡回调未就绪，待决消息仍已保存');
    if(health.admission?.error)warnings.push(health.admission.error);
    if(Date.now()-Date.parse(health.at)>120000)warnings.push('Router 最近两分钟没有更新运行状态');
    if(health.hookEffects?.length)warnings.push('后台通知正在等待重试');
    if(health.errors.length)warnings.push('Router：'+health.errors.map(e=>e.operation+' '+e.error).join('，'));
  }catch{warnings.push('尚未收到 Router 运行状态');}
  let lastOpened=null;try{lastOpened=readFileSync(recentFile,'utf8');}catch{}
  return {lastOpened,records:records.sort((a,b)=>new Date(b.time??0)-new Date(a.time??0)),projects,warnings};
}
