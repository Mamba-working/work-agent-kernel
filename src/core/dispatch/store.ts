import {notifyApplication} from '../wakeup.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {Evidence, Report} from '../planning/contracts.ts';
import { z } from 'zod';

const selectedSource=z.object({id:z.string().min(1),name:z.string().min(1).max(240),kind:z.string().min(1).optional()});
const submissionSchema = (limit:number)=>z.object({id:z.string().uuid(),description:z.string().trim().min(1).max(8000),sources:z.array(selectedSource).max(limit)});
export const Submission=submissionSchema(12);
export type Submission=z.infer<typeof Submission>;
export type TaskSubmission=z.input<typeof Submission>;
export interface DispatchRun extends Submission {status:'queued'|'running'|'planned'|'done'|'failed'|'waiting_hook'|'hook_failed'|'stopped';created:string;steps:string[];result:Report|null;refs:Evidence[];workIds:string[];error:string|null}
// Older queues persisted the display label as "chat". Normalize every read, including recovery.
function decode(body:unknown):DispatchRun {
  const job:DispatchRun=JSON.parse(String(body));
  job.refs=job.refs.map(ref=>{
    if(!('chat' in ref))return ref;
    const {chat,...rest}=ref;
    return {...rest,sourceLabel:ref.sourceLabel??String(chat)};
  });
  return job;
}
export class DispatchStore {
  db:DatabaseSync;
  private readonly notify:()=>void;
  readonly maxSources:number;
  constructor(directory:string,notify:()=>void=()=>notifyApplication(directory),maxSources=12){
    this.maxSources=maxSources;
    this.notify=notify;
    mkdirSync(directory,{recursive:true,mode:0o700});
    this.db=new DatabaseSync(join(directory,'dispatch.sqlite'),{timeout:3000});
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS dispatch_runs(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
  }
  submit(raw:unknown){
    const input=submissionSchema(this.maxSources).parse(raw);
    if(new Set(input.sources.map(s=>s.id)).size!==input.sources.length)throw Error('重复的资料来源');
    const run:DispatchRun={...input,created:new Date().toISOString(),status:'queued',steps:[],refs:[],result:null,workIds:[],error:null};
    this.db.prepare('INSERT OR IGNORE INTO dispatch_runs VALUES (?,?)').run(input.id,JSON.stringify(run));
    const saved=this.get(input.id);
    if(saved.description!==input.description||JSON.stringify(saved.sources)!==JSON.stringify(input.sources))throw Error('提交编号已被另一项任务使用');
    this.notify();
    return saved;
  }
  get(id:string):DispatchRun{const row=this.db.prepare('SELECT body FROM dispatch_runs WHERE id=?').get(id);if(!row)throw Error('找不到派发记录');return decode(row.body);}
  list(limit=50):DispatchRun[]{return this.db.prepare('SELECT body FROM dispatch_runs ORDER BY rowid DESC LIMIT ?').all(limit).map(r=>decode(r.body));}
  next(runnable:(id:string)=>boolean=()=>false):DispatchRun|undefined{
    for(const row of this.db.prepare("SELECT body FROM dispatch_runs WHERE json_extract(body,'$.status') IN ('queued','planned','running','waiting_hook','hook_failed') ORDER BY rowid").iterate()){
      const job=decode(row.body);
      if(!['waiting_hook','hook_failed'].includes(job.status)||runnable(job.id))return job;
    }
    return undefined;
  }
  save(run:DispatchRun){this.db.prepare('UPDATE dispatch_runs SET body=? WHERE id=?').run(JSON.stringify(run),run.id);}
  close(){this.db.close();}
}
