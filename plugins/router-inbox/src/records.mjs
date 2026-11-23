import {DatabaseSync} from 'node:sqlite';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {existsSync,readFileSync} from 'node:fs';
const home=homedir();
const directory=process.env.ROUTER_INBOX_DIR??join(home,'.local/state/router-inbox');
function read(file,sql){
  const db=new DatabaseSync(file,{readOnly:true});
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
  if(!existsSync(inbox))return [];
  const indexed=read(inbox,"SELECT name FROM sqlite_master WHERE type='table' AND name='project_events'").length;
  const incoming=read(inbox,indexed
    ? 'SELECT i.event,p.project_id FROM incoming i LEFT JOIN project_events p ON p.event_id=i.id ORDER BY i.rowid DESC'
    : 'SELECT event,NULL AS project_id FROM incoming ORDER BY rowid DESC');
  return incoming.map(({event,project_id})=>{
    const e=JSON.parse(event), item=JSON.parse(e.text), record=routed.get(key(e));
    const tasks=(record?.deliveries??[]).map(id=>{
      const w=state.works[id];
      return {id:w.id,project:w.harness.startsWith('codex/')?w.harness.slice(6):null,goal:w.goal,status:w.execution.kind,result:w.results.at(-1)?.report?.summary,session:(w.harness==='codex'||w.harness.startsWith('codex/'))?w.sessionId:null};
    });
    return {id:e.externalId,projectId:project_id,source,actor:e.actor,chat:item.chat_id,text:messageText(item.content),time:record?.receivedAt,status:record?.disposition??'pending',reason:record?.reasons.join(' · '),tasks};
  });
}
export async function snapshot(){
  const warnings=[];
  let records=[],projects={};
  try{records=kernelRecords('Router',directory);}catch(e){warnings.push('Router：'+e.message);}
  try{
    const health=JSON.parse(readFileSync(join(directory,'health.json'),'utf8'));
    projects=health.projects??{};
    if(Date.now()-Date.parse(health.at)>120000)warnings.push('Router 最近两分钟没有更新运行状态');
    if(health.errors.length)warnings.push('Router：'+health.errors.map(e=>e.operation+' '+e.error).join('，'));
  }catch{warnings.push('尚未收到 Router 运行状态');}
  return {records:records.sort((a,b)=>new Date(b.time??0)-new Date(a.time??0)),projects,warnings};
}
