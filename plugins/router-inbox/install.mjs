import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const dist=fileURLToPath(new URL('./dist/',import.meta.url));
const codex=process.env.CODEX_BIN||'codex';
function run(args){execFileSync(codex,args,{stdio:'inherit'});}
run(['plugin','marketplace','add',dist]);
run(['plugin','add','router-inbox@work-agent-kernel']);
run(['mcp','add','router-inbox','--',process.execPath,join(dist,'router-inbox/server.cjs')]);
