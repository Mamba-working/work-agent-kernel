#!/usr/bin/env node
// Controlled Feishu transport for the service entrypoint test. All I/O stays in its temp directory.
import {appendFileSync,existsSync,readFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
const dir=process.env.ROUTER_INBOX_DIR, args=process.argv.slice(2);
if(args[0]==='event'){
  process.stderr.write('ready event_key=card.action.trigger\n');
  setInterval(()=>{
    const path=join(dir,'callback.json');
    if(existsSync(path)){
      const callback=readFileSync(path,'utf8');unlinkSync(path);
      process.stdout.write(callback+'\n');
    }
  },40);
}else{
  const body=JSON.parse(readFileSync(0,'utf8'));
  appendFileSync(join(dir,'lark-log'),JSON.stringify({args,body})+'\n');
  process.stdout.write(JSON.stringify({ok:true,data:{message_id:'om_transport'}})+'\n');
}
