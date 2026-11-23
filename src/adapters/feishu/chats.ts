import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type {Reference} from '../../core/planning/contracts.ts';
import {z} from 'zod';
import {Submission} from '../../core/dispatch/store.ts';

const Chat = z.object({id:z.string().regex(/^oc_[a-zA-Z0-9]+$/),name:z.string().min(1).max(240),kind:z.enum(['p2p','group'])});
type Chat=z.infer<typeof Chat>;
export const ChatSubmission=Submission.extend({sources:z.array(Chat).max(12)});
const run=promisify(execFile);
async function request(args:string[]){
  const local=join(homedir(),'.local/bin/lark-cli');
  const executable=process.env.LARK_CLI_BIN??(existsSync(local)?local:'lark-cli');
  try{
    const {stdout}=await run(executable,['im',...args,'--as','user','--format','json'],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
    const envelope=JSON.parse(stdout);if(!envelope.ok)throw Error('request failed');return envelope.data;
  }catch{throw Error('飞书读取失败，请检查本机 lark-cli 用户登录和会话读取权限。');}
}
export async function listChats(kind:Chat['kind'],query:string,cursor:string){
  // Use the member list for both types. Search stays within conversations this user has joined.
  const matches:Chat[]=[];let next=cursor;
  for(let page=0;page<(query?5:1);page++){
    const data=await request(['+chat-list','--types',kind,'--sort','active_time','--page-size','50',...(next?['--page-token',next]:[])]);
    for(const row of data.chats??[]){
      const name=String(row.name||row.p2p_target_id||row.chat_id);
      if(row.chat_status!=='dissolved'&&name.toLowerCase().includes(query.toLowerCase()))
        matches.push({id:row.chat_id,name,kind});
    }
    next=data.has_more?String(data.page_token??''):'';
    if(!next||matches.length)break;
  }
  return {chats:matches,next};
}
export async function readChat(source:Reference,start:string,end:string,cursor:string){
  const data=await request(['+chat-messages-list','--chat-id',source.id,'--start',start,'--end',end,'--no-reactions','--order','desc','--page-size','30',...(cursor?['--page-token',cursor]:[])]);
  return {messages:(data.messages??[]).filter((m:{deleted?:boolean})=>!m.deleted).map((m:{message_id:string;sender?:{name?:string};content:string;create_time:string;message_app_link?:string})=>({
    id:m.message_id,sender:m.sender?.name??'',time:m.create_time,text:String(m.content??'').slice(0,2400),url:m.message_app_link??'',
  })) as {id:string;sender:string;time:string;text:string;url:string}[],next:data.has_more?String(data.page_token??''):''};
}
