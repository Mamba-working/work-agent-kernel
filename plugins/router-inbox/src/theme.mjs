// Choose the foreground against the user's actual fill, including pale custom accents.
function onAccent(hex){
  const [r,g,b]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);
  const luminance=.2126*r+.7152*g+.0722*b;
  return (luminance+.05)/.05>=1.05/(luminance+.05)?'#000000':'#ffffff';
}
export function applyAccents(accents){
  if(!accents)return;
  const style=document.documentElement.style;
  for(const mode of ['light','dark']){
    const value=accents[mode],fill='--router-accent-'+mode,ink='--router-on-'+mode;
    if(typeof value==='string'&&/^#[a-f\d]{6}$/i.test(value)){style.setProperty(fill,value);style.setProperty(ink,onAccent(value));}
    else{style.removeProperty(fill);style.removeProperty(ink);}
  }
}
