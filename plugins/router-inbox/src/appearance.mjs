import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {parse} from 'smol-toml';

// The MCP Apps theme contains semantic UI colors; Desktop's chrome accent lives in its local settings.
export function desktopAccents(home=process.env.CODEX_HOME||join(homedir(),'.codex')){
  try{
    const desktop=parse(readFileSync(join(home,'config.toml'),'utf8')).desktop;
    const result={};
    for(const [mode,key] of [['light','appearanceLightChromeTheme'],['dark','appearanceDarkChromeTheme']]){
      const value=desktop?.[key]?.accent;
      if(typeof value==='string'&&/^#[a-f\d]{6}$/i.test(value))result[mode]=value;
    }
    return result;
  }catch{return {};}
}
