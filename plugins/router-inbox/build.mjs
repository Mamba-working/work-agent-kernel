import {build} from 'esbuild';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('./',import.meta.url));
const dir=join(root,'dist'), plugin=join(dir,'router-inbox');
const json=(path,data)=>writeFile(path,JSON.stringify(data,null,2)+'\n');
await mkdir(join(plugin,'.codex-plugin'),{recursive:true});
await mkdir(join(plugin,'assets'),{recursive:true});
for(const name of ['project-chat.png','project-chat-dark.png'])
  await copyFile(join(root,'assets',name),join(plugin,'assets',name));
await mkdir(join(dir,'.agents/plugins'),{recursive:true});
await build({entryPoints:[join(root,'src/server.mjs')],outfile:join(plugin,'server.cjs'),bundle:true,platform:'node',target:'node24',minify:true});
const ui=await build({entryPoints:[join(root,'src/app.mjs')],bundle:true,write:false,minify:true,format:'iife'});
const template=await readFile(join(root,'src/template.html'),'utf8');
const style=await readFile(join(root,'src/styles.css'),'utf8');
await writeFile(join(plugin,'view.html'),template.replace('/*STYLE*/',()=>style).replace('/*APP*/',()=>ui.outputFiles[0].text.replace(/<\/script/gi,'<\\/script')));
await copyFile(join(root,'manifests/plugin.json'),join(plugin,'plugin.json'));
await copyFile(join(root,'manifests/codex-plugin.json'),join(plugin,'.codex-plugin/plugin.json'));
const serverConfig=arg=>({mcpServers:{'router-inbox':{type:'stdio',command:process.execPath,args:[arg]}}});
await json(join(plugin,'mcp.json'),serverConfig('${PLUGIN_ROOT}/server.cjs'));
await json(join(plugin,'.mcp.json'),serverConfig(join(plugin,'server.cjs')));
await json(join(dir,'.agents/plugins/marketplace.json'),{
  name:'work-agent-kernel',
  interface:{displayName:'Work Agent Kernel'},
  plugins:[{name:'router-inbox',source:{source:'local',path:'./router-inbox'},category:'Productivity',policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'}}],
});
