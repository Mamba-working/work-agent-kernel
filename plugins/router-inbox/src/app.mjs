import {showProjectForm} from './project-form.mjs';
import {sessionHome} from './session-home.mjs';
import {closeMenu} from './action-menu.mjs';
import {applyAccents} from './theme.mjs';
import {dispatchView,unmountDispatch,refreshDispatch} from './dispatch-view.mjs';
import {projectPicker} from './project-picker.mjs';
import {App,applyDocumentTheme,applyHostStyleVariables,applyHostFonts} from '@modelcontextprotocol/ext-apps';
import {createElement, MessagesSquare, UsersRound, FileText, ArrowUpRight, ArrowRight, ArrowLeft, Search, RotateCw, Folder} from 'lucide';

const app = new App({name:'项目会话',version:'0.8.1'});
const byId = id => document.getElementById(id);
const main = byId('main');
const stateNames = {waiting_hook:'等待业务决定',hook_failed:'规则异常',awaiting_owner:'待你决定',stopped:'已中断',pending:'待处理', routed:'已分派', ignored:'已忽略', running:'处理中', ready:'已完成', queued:'排队中', waiting_input:'待补充', failed:'失败'};
let projects={}, records=[], view='home', projectId=null, filterProject=null, activeMessage=null;
let status='', search='', pending=false, keyboard=false, reading=false, picked=false, listScroll=0;
let lastOpened=null, tracedSession=null, exitLayer=null, refreshOnFocus=false;
const history=[];
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
  lastOpened=id;refreshOnFocus=true;
}
async function openLink(url){const r=await app.openLink({url});if(r?.isError)throw Error('未能打开链接');}
function animate(el,direction=1){
  for(const run of el.getAnimations())run.cancel();
  if(keyboard||reduceMotion.matches)return;
  el.animate([{opacity:.7,transform:'translateY('+direction*5+'px)'},{opacity:1,transform:'none'}],{duration:185,easing:'cubic-bezier(.2,.75,.25,1)'});
}
function directoryView(){return view==='home'||view==='focus';}
function transition(next,id,session,returnTo){
  closeMenu();exitLayer?.remove();exitLayer=null;
  const old=main.firstElementChild;
  const bounds=old?.getBoundingClientRect();
  const sharedId=next==='focus'?id:view==='focus'&&next==='home'?projectId:null;
  const shared=sharedId&&old?.querySelector('[data-shared="'+CSS.escape(sharedId)+'"]');
  const from=shared?.getBoundingClientRect();
  old?.remove();
  view=next;projectId=id;tracedSession=session;
  draw();window.scrollTo(0,returnTo?.scroll??0);
  const fresh=main.firstElementChild;
  const restore=returnTo?.key&&main.querySelector('[data-nav-key="'+CSS.escape(returnTo.key)+'"]');
  (restore||main).focus({preventScroll:true});
  if(!old||!fresh||reduceMotion.matches||keyboard)return;
  const ghost=document.createElement('div');
  ghost.className='session-ghost';ghost.inert=true;ghost.setAttribute('aria-hidden','true');
  Object.assign(ghost.style,{left:bounds.left+'px',top:bounds.top+'px',width:bounds.width+'px'});
  ghost.append(old);document.body.append(ghost);exitLayer=ghost;
  const direction=returnTo?-1:1;
  const dest=sharedId&&fresh.querySelector('[data-shared="'+CSS.escape(sharedId)+'"]');
  if(dest&&from){
    const to=dest.getBoundingClientRect();
    shared.style.visibility='hidden';
    dest.animate([{transform:'translate('+ (from.x-to.x)+'px,'+(from.y-to.y)+'px) scale('+from.height/to.height+')'},{transform:'none'}],
      {duration:250,easing:ease});
  }
  const out=ghost.animate([{opacity:1,transform:'none'},{opacity:0,transform:'translateY('+(-direction*5)+'px)'}],{duration:125,easing:'ease-out',fill:'forwards'});
  out.finished.catch(()=>{}).finally(()=>{ghost.remove();if(exitLayer===ghost)exitLayer=null;});
  fresh.animate([{opacity:0,transform:'translateY('+direction*6+'px)'},{opacity:1,transform:'none'}],{duration:210,easing:ease});
}
function navigate(next,id=null,session=null){
  history.push({view,id:projectId,session:tracedSession,scroll:scrollY,key:document.activeElement?.dataset.navKey});
  if(next==='feed'&& !id){filterProject=null;search='';status='';reading=false;picked=false;activeMessage=null;}
  transition(next,id,session);
}
function back(){
  if(view==='feed'&&reading&&matchMedia('(max-width:650px)').matches){
    reading=false;main.querySelector('.desk')?.classList.remove('reading');
    window.scrollTo(0,listScroll);main.querySelector('.dispatch[aria-pressed="true"]')?.focus({preventScroll:true});
    const queue=main.querySelector('.queue');if(queue)animate(queue,-1);return;
  }
  const previous=history.pop();
  if(previous)transition(previous.view,previous.id,previous.session,previous);
}
function viewMessages(id){
  reading=false;picked=false;filterProject=id;search='';status='';activeMessage=null;navigate('feed',id);
}
document.addEventListener('pointerdown',()=>keyboard=false);
document.addEventListener('keydown',e=>{keyboard=true;if(e.key==='Escape'&&!e.defaultPrevented&&!document.querySelector('dialog[open],:popover-open')&&!(e.target instanceof HTMLInputElement&&e.target.value))back();});
function createProject(trigger){
  showProjectForm(trigger,{
    submit:async input=>(await callTool('create_project',input))._meta,
    findGroups:async (query,cursor)=>(await callTool('select_chats',{kind:'group',query,cursor}))._meta.data,
    onCreated:({id,project})=>{projects={...projects,[id]:project};navigate('focus',id);}
  });
}
function catalog(){
  const content=add(main,'section','page index');const bar=add(content,'div','catalog-header');add(bar,'h1','index-title','项目');const create=button(bar,'new-project-button','＋ 新建项目',()=>createProject(create));create.dataset.navKey='new-project';
  if(!Object.keys(projects).length){add(content,'p','empty','还没有登记项目');return;}
  for(const [id,p] of Object.entries(projects)){
    const row=button(content,'project-entry',null,()=>navigate('project',id));
    row.dataset.project=id;row.dataset.navKey='catalog-'+id;icon(row,Folder);
    const copy=add(row,'span','project-copy');add(copy,'strong','project-title',p.name||id);
    add(copy,'span','project-repo',p.cwd.split('/').filter(Boolean).pop());
    add(row,'span','counts',sessions(id).size+' 个会话 · '+groups(p).length+' 个群');icon(row,ArrowRight);
  }
}
function detail(){
  const p=projects[projectId];if(!p){view='projects';catalog();return;}
  const sheet=add(main,'article','page dossier');
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
    contextTrace(detail,r);
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
async function launchSession(id){
  try{await openSession(id);}catch(error){byId('notice').textContent=error.message;}
}
function contextTrace(container, r) {
  const read=r.contextRead;
  if (!read) return;
  add(container,'h3','rule-heading','飞书上文');
  const status={read:'已读取 '+read.count+' 条',empty:'没有更早的消息',unmapped:'未确认来源会话',unavailable:'飞书读取失败'};
  bodyText(container,[status[read.status],read.chat,read.until ? '截至 '+new Date(read.until).toLocaleString() : ''].filter(Boolean).join(' · '));
  for(const message of read.citations) bodyText(container,'引用 '+message.sender+'（'+message.id+'）：'+message.text);
}
function trace(){
  const sheet=add(main,'article','page dossier');
  const name=sessions(projectId).get(tracedSession);
  add(sheet,'h1','','会话流程');add(sheet,'p','byline',name||'工作会话');
  for(const r of records.filter(r=>r.tasks?.some(t=>t.session===tracedSession&&t.project===projectId))){
    const item=add(sheet,'section','session-trace');add(item,'p','byline',[author(r),day(r),time(r)].filter(Boolean).join(' · '));
    add(item,'h2','',messageTitle(r));if(r.reason)bodyText(item,r.reason);contextTrace(item,r);
    for(const t of r.tasks.filter(t=>t.session===tracedSession))add(item,'p','body-text',t.result||t.goal);
  }
}
function draw(){
  unmountDispatch();closeMenu();
  byId('secondary-bar').hidden=directoryView();
  main.querySelector('.scope-menu:popover-open')?.hidePopover();
  main.replaceChildren();
  if(directoryView())sessionHome(main,{projects,records,focusId:view==='focus'?projectId:null,lastOpened,add,button,icon,navigate,back,open:launchSession,refresh,createProject});
  else if(view==='trace')trace();
  else if(view==='dispatch')dispatchView(main,{call:callTool,openSession,openLink});
  else if(view==='feed')feed();else if(view==='projects')catalog();else detail();
}
function apply(result){
  const d=result._meta?.data;if(!d)return;applyAccents(d.accents);
  records=d.records??[];projects=d.projects??{};lastOpened=d.lastOpened??null;
  byId('notice').textContent=(d.warnings??[]).join(' · ');if(view!=='dispatch'||!main.querySelector('.dispatch-page'))draw();
}
async function refresh(){
  if(pending)return;pending=true;const b=byId('refresh');b.disabled=true;
  try{const r=await app.callServerTool({name:'show_inbox',arguments:{}});if(r.isError)throw Error(r.content?.[0]?.text||'读取失败');apply(r);}catch(e){byId('notice').textContent=e.message;}finally{pending=false;b.disabled=false;}
}
icon(byId('refresh'),RotateCw);
byId('return-page').onclick=back;
byId('refresh').onclick=()=>view==='dispatch'?refreshDispatch():refresh();
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
window.addEventListener('focus',()=>{void updateAccent();if(refreshOnFocus&&directoryView()){refreshOnFocus=false;void refresh();}});
app.ontoolresult=apply;app.connect().then(()=>{syncAppearance(app.getHostContext());return refresh();}).catch(e=>byId('notice').textContent=e.message);
