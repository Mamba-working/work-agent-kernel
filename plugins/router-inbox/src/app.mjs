import {applyAccents} from './theme.mjs';
import {dispatchView,unmountDispatch,refreshDispatch} from './dispatch-view.mjs';
import {projectPicker} from './project-picker.mjs';
import {App,applyDocumentTheme,applyHostStyleVariables,applyHostFonts} from '@modelcontextprotocol/ext-apps';
import {createElement, PanelsTopLeft, MessagesSquare, UsersRound, FileText, ArrowUpRight, ArrowRight, ArrowLeft, Search, RotateCw, Folder} from 'lucide';

const app = new App({name:'飞书消息路由',version:'0.6.1'});
const byId = id => document.getElementById(id);
const main = byId('main');
const stateNames = {waiting_hook:'等待业务决定',hook_failed:'规则异常',awaiting_owner:'待你决定',stopped:'已中断',pending:'待处理', routed:'已分派', ignored:'已忽略', running:'处理中', ready:'已完成', queued:'排队中', waiting_input:'待补充', failed:'失败'};
let projects={}, records=[], view='dispatch', projectId=null, filterProject=null, activeMessage=null;
let status='', search='', pending=false, keyboard=false, reading=false, picked=false, listScroll=0;
const narrow=matchMedia('(max-width:650px)');
const reduceMotion=matchMedia('(prefers-reduced-motion: reduce)');
const rowKey=r=>JSON.stringify([r.source,r.id,r.revision??'1']);
const ease='cubic-bezier(.22,.8,.25,1)';
function moveIndicator(mark, destination, motion){
  const before=mark.isConnected?mark.getBoundingClientRect():null;
  for(const run of mark.getAnimations())run.cancel();
  if(!destination){mark.remove();return;}
  destination.append(mark);
  const after=mark.getBoundingClientRect();
  if(!motion||keyboard||reduceMotion.matches||!before?.width||!after.width)return;
  mark.animate([
    {transform:'translate('+ (before.x-after.x)+'px,'+(before.y-after.y)+'px) scaleX('+(before.width/after.width)+')'},
    {transform:'none'}
  ],{duration:210,easing:ease});
}
function add(parent,tag,cls,text){
  const el=document.createElement(tag);el.className=cls;
  if(text!=null)el.textContent=text;
  parent.append(el);return el;
}
function icon(parent,shape){parent.append(createElement(shape,{width:18,height:18,'stroke-width':1.6,'aria-hidden':'true'}));}
function button(parent,cls,text,action){
  const el=add(parent,'button',cls,text);el.type='button';el.onclick=action;return el;
}
function outbound(parent,title,action,glyph){
  const b=button(parent,'outbound',null,async()=>{
    if(b.disabled)return;b.disabled=true;
    try{await action();}catch(e){byId('notice').textContent=e.message;}finally{b.disabled=false;}
  });
  if(glyph)icon(b,glyph);add(b,'span','link-title',title);icon(b,ArrowUpRight);return b;
}
function time(r){return r.time?new Date(r.time).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'';}
function day(r){return r.time?new Date(r.time).toLocaleDateString('zh-CN',{month:'long',day:'numeric'}):'时间未记录';}
function author(r){return (r.actor||'来源消息').replace(/\s*\(\d{8,}\)\s*$/u,'');}
function messageTitle(r){
  const text=(r.text??'').trim();
  const withoutMention=text.replace(/^@[^\n]{1,80}?\([^)]+\)\s*/u,'').trim()||text;
  return withoutMention.split('\n')[0].slice(0,85)||'消息';
}
function groups(p){return [...(p.groups??[]),...(p.feishuChatId?[{id:p.feishuChatId,name:p.feishuChatId}]:[])];}
function sessions(id){
  const entries=new Map((projects[id]?.sessions??[]).map(s=>[s.id,s.title]));
  for(const r of records)for(const t of r.tasks)if(t.project===id&&t.session&&!entries.has(t.session))entries.set(t.session,t.goal);
  return entries;
}
function bodyText(parent,body){
  const rows=body.trim().split(/\n+/u).filter(Boolean);
  for(const row of rows){
    const sentences=row.match(/[^。！？]+[。！？]?/gu)??[row];
    let paragraph='';
    for(const s of sentences){
      paragraph+=s;
      if(paragraph.length>=75){add(parent,'p','body-text',paragraph);paragraph='';}
    }
    if(paragraph)add(parent,'p','body-text',paragraph);
  }
}
async function openSession(id){
  const result=await app.callServerTool({name:'open_session',arguments:{session:id}});
  if(result.isError)throw Error(result.content?.[0]?.text||'会话打开失败');
}
async function openLink(url){const r=await app.openLink({url});if(r?.isError)throw Error('未能打开链接');}
function animate(el,direction=1){
  for(const run of el.getAnimations())run.cancel();
  if(keyboard||reduceMotion.matches)return;
  el.animate([{opacity:.7,transform:'translateY('+direction*5+'px)'},{opacity:1,transform:'none'}],{duration:185,easing:'cubic-bezier(.2,.75,.25,1)'});
}
function navigate(next,id=null){
  const previous=projectId;view=next;projectId=id;draw();window.scrollTo(0,0);animate(main.firstElementChild,next==='projects'?-1:1);
  const focus=next==='projects'&&previous?[...main.querySelectorAll('[data-project]')].find(b=>b.dataset.project===previous):null;
  (focus||main).focus({preventScroll:true});
}
function back(){
  if(view==='feed'&&reading&&matchMedia('(max-width:650px)').matches){
    reading=false;main.querySelector('.desk')?.classList.remove('reading');
    window.scrollTo(0,listScroll);main.querySelector('.dispatch[aria-pressed="true"]')?.focus({preventScroll:true});
    const queue=main.querySelector('.queue');if(queue)animate(queue,-1);return;
  }
  if(view==='project')navigate('projects');
  else if(view==='feed'&&filterProject){const id=filterProject;filterProject=null;navigate('project',id);}
}
function viewMessages(id){
  reading=false;picked=false;filterProject=id;search='';status='';activeMessage=null;navigate('feed');
}
document.addEventListener('pointerdown',()=>keyboard=false);
document.addEventListener('keydown',e=>{keyboard=true;if(e.key==='Escape')back();});
function catalog(){
  const content=add(main,'section','page index');add(content,'h1','index-title','项目');
  if(!Object.keys(projects).length){add(content,'p','empty','还没有登记项目');return;}
  for(const [id,p] of Object.entries(projects)){
    const row=button(content,'project-entry',null,()=>navigate('project',id));
    row.dataset.project=id;icon(row,Folder);
    const copy=add(row,'span','project-copy');add(copy,'strong','project-title',p.name||id);
    add(copy,'span','project-repo',p.cwd.split('/').filter(Boolean).pop());
    add(row,'span','counts',sessions(id).size+' 个会话 · '+groups(p).length+' 个群');icon(row,ArrowRight);
  }
}
function detail(){
  const p=projects[projectId];if(!p){view='projects';catalog();return;}
  const sheet=add(main,'article','page dossier');
  const crumbs=add(sheet,'div','crumbs');const goBack=button(crumbs,'return',null,back);icon(goBack,ArrowLeft);add(goBack,'span','','所有项目');
  const lead=add(sheet,'header','lead');
  const title=add(lead,'div','lead-copy');add(title,'h1','',p.name);const path=add(title,'details','location');
  add(path,'summary','',p.cwd.split('/').filter(Boolean).pop());add(path,'code','',p.cwd);

  const grid=add(sheet,'div','reading-grid');
  const sessionBox=add(grid,'section','session-section');add(sessionBox,'h2','','工作会话');
  for(const [sid,name] of sessions(projectId))outbound(sessionBox,name,()=>openSession(sid),MessagesSquare);
  if(!sessions(projectId).size)add(sessionBox,'p','muted','暂无工作会话');
  const story=add(grid,'section','story'),index=add(grid,'section','reference');
  add(story,'h2','', '项目背景');
  const text=p.context||'';const matches=[...text.matchAll(/https?:\/\/[^\s，。；、）】]+/gu)];
  let prose=text;for(const m of matches)prose=prose.replace(m[0],'');
  bodyText(story,prose.replace(/(?:原\s*)?PRD\s*参考[：:]?\s*$/iu,'').trim()||'尚未登记项目背景。');
  for(const url of new Set(matches.map(m=>m[0]))){
    let parsed;try{parsed=new URL(url);}catch{continue;}
    outbound(story,matches.length===1&&/PRD/i.test(text)?'原始 PRD':parsed.hostname+parsed.pathname,()=>openLink(url),FileText);
  }
  const groupBox=add(index,'section','reference-section');add(groupBox,'h2','','飞书群');
  for(const g of groups(p)){
    if(/^oc_[\w-]+$/.test(g.id))outbound(groupBox,g.name||g.id,()=>openLink('https://applink.feishu.cn/client/chat/open?openChatId='+encodeURIComponent(g.id)),UsersRound);
    else add(groupBox,'p','',g.name||g.id);
  }
  if(!groups(p).length)add(groupBox,'p','muted','尚未绑定群');
  const b=button(index,'archive-action',null,()=>viewMessages(projectId));
  add(b,'strong','','项目消息');add(b,'span','muted',records.filter(r=>r.projectId===projectId).length+' 条');icon(b,ArrowRight);
}
function feed(){
  const shell=add(main,'div','page desk'+(reading?' reading':''));
  const inbox=add(shell,'section','queue'),detail=add(shell,'article','reader');
  if(filterProject){const b=button(inbox,'return',null,back);icon(b,ArrowLeft);add(b,'span','',projects[filterProject]?.name||'返回项目');}
  const toolbar=add(inbox,'div','queue-toolbar');
  add(toolbar,'h1','queue-title',filterProject?'项目消息':'消息流');
  if(Object.keys(projects).length){
    projectPicker(toolbar,projects,filterProject,id=>{
      filterProject=id;picked=false;reading=false;activeMessage=null;
      draw();
    });
  }
  const form=add(inbox,'label','search');icon(form,Search);const field=add(form,'input','');field.value=search;field.type='search';field.placeholder='搜索消息、发送人或事项';field.setAttribute('aria-label','搜索消息');
  const tabs=add(inbox,'div','filters'),list=add(inbox,'div','messages');
  const rowMark=document.createElement('i');rowMark.className='row-mark';rowMark.setAttribute('aria-hidden','true');
  const tabMark=document.createElement('i');tabMark.className='tab-mark';tabMark.setAttribute('aria-hidden','true');
  function select(r,withMotion=false){
    const next=r?rowKey(r):null;
    const changed=next!==activeMessage;
    if(withMotion)picked=true;
    activeMessage=next;
    let current;
    for(const b of list.querySelectorAll('button')){
      const selected=b.dataset.id===next && (!narrow.matches||picked);
      b.setAttribute('aria-pressed',String(selected));
      if(selected)current=b;
    }
    moveIndicator(rowMark,current,withMotion&&changed&&!narrow.matches);
    detail.replaceChildren();
    if(!r){add(detail,'p','empty','当前没有可显示的消息');return;}
    const goBack=button(detail,'mobile-back return',null,back);icon(goBack,ArrowLeft);add(goBack,'span','','返回消息列表');
    add(detail,'h2','reader-title',messageTitle(r));add(detail,'p','byline',[author(r),day(r)+' '+time(r),stateNames[r.status]??r.status].join('　/　'));
    if(r.text!==messageTitle(r))add(detail,'p','original',r.text);
    if(r.reason){add(detail,'h3','rule-heading','路由依据');bodyText(detail,r.reason);}
    for(const t of r.tasks){
      add(detail,'h3','rule-heading','处理结果');add(detail,'p','outcome',t.result||t.goal);add(detail,'p','byline',[projects[t.project]?.name,stateNames[t.status]??t.status].filter(Boolean).join('　/　'));
      if(t.session)outbound(detail,'打开工作会话',()=>openSession(t.session));
    }
    if(withMotion){
      if(narrow.matches){listScroll=window.scrollY;reading=true;shell.classList.add('reading');goBack.focus({preventScroll:true});window.scrollTo(0,0);}
      if(changed||narrow.matches)animate(detail);
    }
  }
  function rows(){
    list.replaceChildren();const q=search.trim().toLowerCase();
    const subset=records.filter(r=>(!filterProject||r.projectId===filterProject)&&(!status||r.status===status)&&[r.text,r.actor,r.id,...r.tasks.map(t=>t.goal)].join(' ').toLowerCase().includes(q));
    let lastDay='';
    if(!subset.some(r=>rowKey(r)===activeMessage))picked=false;
    for(const r of subset){
      if(lastDay!==day(r)){lastDay=day(r);add(list,'h3','day',lastDay);}
      const b=button(list,'dispatch',null,()=>select(r,true));b.dataset.id=rowKey(r);
      add(b,'strong','',messageTitle(r));add(b,'time','',time(r));add(b,'span','meta',[author(r),stateNames[r.status]??r.status].join(' · '));
    }
    if(!subset.length)add(list,'p','empty',q?'没有匹配的消息':'暂无消息');
    select(subset.find(r=>rowKey(r)===activeMessage)||subset[0]);
  }
  for(const key of ['','awaiting_owner','pending','routed','ignored','stopped']){
    const b=button(tabs,'',null,()=>{
      if(status===key)return;
      status=key;
      for(const child of tabs.children)child.setAttribute('aria-pressed',String(child.dataset.key===status));
      moveIndicator(tabMark,b,true);rows();animate(list);
    });
    add(b,'span','filter-title',stateNames[key]??'全部');b.dataset.key=key;
    b.setAttribute('aria-pressed',String(key===status));
    if(key===status)moveIndicator(tabMark,b,false);
  }
  field.oninput=()=>{search=field.value;rows();};rows();
}
narrow.addEventListener('change',()=>{reading=false;if(view==='feed')draw();});
async function callTool(name,args){
  const result=await app.callServerTool({name,arguments:args});
  if(result.isError)throw Error(result.content?.[0]?.text||'操作失败');
  return result;
}
function draw(){
  unmountDispatch();
  byId('nav-dispatch').setAttribute('aria-pressed',String(view==='dispatch'));
  byId('nav-feed').setAttribute('aria-pressed',String(view==='feed'));byId('nav-projects').setAttribute('aria-pressed',String(view==='project'||view==='projects'));
  main.querySelector('.scope-menu:popover-open')?.hidePopover();
  main.replaceChildren();if(view==='dispatch')dispatchView(main,{call:callTool,openSession,openLink});else if(view==='feed')feed();else if(view==='projects')catalog();else detail();
}
function apply(result){
  const d=result._meta?.data;if(!d)return;applyAccents(d.accents);
  records=d.records??[];projects=d.projects??{};byId('notice').textContent=(d.warnings??[]).join(' · ');if(view!=='dispatch'||!main.querySelector('.dispatch-page'))draw();
}
async function refresh(){
  if(pending)return;pending=true;const b=byId('refresh');b.disabled=true;
  try{const r=await app.callServerTool({name:'show_inbox',arguments:{}});if(r.isError)throw Error(r.content?.[0]?.text||'读取失败');apply(r);}catch(e){byId('notice').textContent=e.message;}finally{pending=false;b.disabled=false;}
}
icon(byId('mark'),PanelsTopLeft);icon(byId('refresh'),RotateCw);
byId('nav-dispatch').onclick=()=>navigate('dispatch');byId('nav-feed').onclick=()=>viewMessages(null);byId('nav-projects').onclick=()=>navigate('projects');byId('refresh').onclick=()=>view==='dispatch'?refreshDispatch():refresh();
function syncAppearance(ctx){
  if(!ctx)return;
  if(ctx.theme)applyDocumentTheme(ctx.theme);
  if(ctx.styles?.variables)applyHostStyleVariables(ctx.styles.variables);
  if(ctx.styles?.css?.fonts)applyHostFonts(ctx.styles.css.fonts);
}
async function updateAccent(){
  try{const result=await callTool('desktop_appearance',{});applyAccents(result._meta?.accents);}catch{/* SDK colors remain available. */}
}
app.onhostcontextchanged=ctx=>{syncAppearance(ctx);void updateAccent();};
window.addEventListener('focus',updateAccent);
app.ontoolresult=apply;app.connect().then(()=>{syncAppearance(app.getHostContext());return refresh();}).catch(e=>byId('notice').textContent=e.message);
