import {homedir} from 'node:os';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {DispatchStore} from '../../../src/core/dispatch/store.ts';

const directory=process.env.ROUTER_INBOX_DIR??join(homedir(),'.local/state/router-inbox');
export function submitDispatch(input){
  const db=new DispatchStore(directory);
  try{return db.submit(input).id;}finally{db.close();}
}
export function dispatchHistory(){
  if(!existsSync(join(directory,'dispatch.sqlite')))return [];
  const db=new DispatchStore(directory);let jobs;
  try{jobs=db.list();}finally{db.close();}
  let state={works:{},runs:{}};
  if(existsSync(join(directory,'kernel.sqlite'))){
    const k=new DatabaseSync(join(directory,'kernel.sqlite'),{readOnly:true,timeout:2000});
    try{const row=k.prepare('SELECT body FROM state WHERE id=1').get();if(row)state=JSON.parse(row.body);}finally{k.close();}
  }
  return jobs.map(job=>({...job,works:job.workIds.map((id,i)=>{
    const w=state.works[id],key=JSON.stringify(['owner',job.id+'/'+i,'1']);
    const run=Object.values(state.runs).find(r=>r.workId===id&&r.request.inputs.some(m=>m.key===key));
    const report=run?.state.report;
    return {id,goal:job.result.actions[i]?.goal??w?.goal,status:report?.kind??run?.state.kind??'queued',
      session:run?.state.receipt?.sessionId??w?.sessionId??null,summary:report?.summary??''};
  })}));
}
