import {applyAccents} from './theme.mjs';
const state={description:'',sources:[],requestId:null,pending:false,jobs:[],openId:null};
let mounted=0,poll;
export let refreshDispatch=async()=>{};
const labels={waiting_hook:'等待业务决定',hook_failed:'规则异常',stopped:'已中断',queued:'排队中',running:'分析中',planned:'准备派单',done:'已处理',failed:'失败',ready:'已完成',needs_input:'待补充',inProgress:'执行中',dispatching:'派单中',uncertain:'待核对'};
function el(parent,tag,cls,text){const e=document.createElement(tag);e.className=cls;if(text!=null)e.textContent=text;parent.append(e);return e;}
function action(parent,cls,title,fn){const b=el(parent,'button',cls,title);b.type='button';b.onclick=fn;return b;}
function stamp(date){return new Date(date).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});}
function headline(j){
  if(j.status==='done'&&j.works.length){
    if(j.works.every(w=>w.status==='ready'))return '已完成';
    if(j.works.some(w=>['failed','rejected','uncertain','needs_input','reroute'].includes(w.status)))return '需要关注';
    return '执行中';
  }
  return j.status==='done'?'分析完成':labels[j.status]??j.status;
}
export function unmountDispatch(){mounted++;refreshDispatch=async()=>{};clearTimeout(poll);document.getElementById('chat-choice')?.close();}
export function dispatchView(main,{call,openSession,openLink}){
  const version=++mounted;
  const page=el(main,'section','page dispatch-page');
  el(page,'h1','','交给 Router');
  const form=el(page,'form','compose');
  const field=el(form,'textarea','task-description');field.setAttribute('aria-label','任务描述');field.placeholder='交代一件事，例如「分析需求群最近三天的讨论，列出还没定下来的问题」';field.value=state.description;
  const chips=el(form,'div','sources'),bar=el(form,'div','compose-bar');
  const choose=action(bar,'choose','＋ 选择聊天',()=>pick());
  const send=el(bar,'button','send','派发');send.type='submit';
  const note=el(page,'p','dispatch-note');note.setAttribute('role','status');
  el(page,'h2','history-title','最近派发');
  const history=el(page,'div','history');
  function enable(){send.disabled=state.pending||!state.description.trim();field.disabled=state.pending;choose.disabled=state.pending;}
  function renderSources(){
    chips.replaceChildren();for(const s of state.sources){
      const b=action(chips,'source-chip',(s.kind==='p2p'?'私聊 · ':'群聊 · ')+s.name+' ×',()=>{
        state.sources=state.sources.filter(x=>x.id!==s.id);state.requestId=null;renderSources();choose.focus();
      });b.setAttribute('aria-label','移除 '+s.name);b.disabled=state.pending;
    }enable();
  }
  field.oninput=()=>{state.description=field.value;state.requestId=null;enable();};
  field.onkeydown=e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'&&!send.disabled){e.preventDefault();form.requestSubmit();}};
  form.onsubmit=async e=>{
    e.preventDefault();if(send.disabled)return;
    state.requestId??=crypto.randomUUID();state.pending=true;renderSources();send.textContent='派发中…';
    try{
      const r=await call('submit_dispatch',{id:state.requestId,description:state.description.trim(),sources:state.sources});
      state.openId=r._meta.id;state.description='';state.sources=[];state.requestId=null;field.value='';
      note.textContent='任务已入队';await reload();
    }catch(err){note.textContent=err.message;}finally{state.pending=false;send.textContent='派发';renderSources();}
  };
  function historyList(){
    history.replaceChildren();if(!state.jobs.length){el(history,'p','muted','还没有主动派发记录');return;}
    for(const j of state.jobs){
      const row=el(history,'section','run-row'),selected=state.openId===j.id;
      const b=action(row,'run-head',null,()=>{state.openId=selected?null:j.id;historyList();history.querySelector('[data-run="'+j.id+'"]')?.focus({preventScroll:true});});
      b.dataset.run=j.id;b.setAttribute('aria-expanded',String(selected));
      el(b,'span','run-title',j.description);el(b,'span','run-state',headline(j));el(b,'time','muted',stamp(j.created));
      if(!selected)continue;
      const details=el(row,'div','run-body');
      if(j.sources.length)el(details,'p','muted','来源：'+j.sources.map(s=>s.name).join('、'));
      if(j.error)el(details,'p','run-error',j.error);
      if(j.result)el(details,'p','run-answer',j.result.answer);
      for(const [index,ref] of j.refs.entries()){
        if(/^https:\/\//.test(ref.url))action(details,'reference-link','来源 '+(index+1)+' · '+ref.chat+' ↗',()=>openLink(ref.url).catch(e=>note.textContent=e.message));
      }
      for(const w of j.works){
        const section=el(details,'div','run-work');el(section,'strong','',w.goal);el(section,'span','muted',labels[w.status]??w.status);
        if(w.summary)el(section,'p','',w.summary);
        if(w.session)action(section,'reference-link','打开工作会话 ↗',()=>openSession(w.session).catch(e=>note.textContent=e.message));
      }
      if(j.steps.length)el(details,'p','tool-trace',j.steps.join(' → '));
      if(j.status==='failed')action(details,'choose','使用此描述重新填写',()=>{state.description=j.description;state.sources=[...j.sources];state.requestId=null;field.value=state.description;renderSources();field.focus();});
    }
  }
  let loading=0;
  async function reload(){
    const request=++loading;clearTimeout(poll);
    try{
      const r=await call('list_dispatches',{});if(mounted!==version||request!==loading)return;
      applyAccents(r._meta.accents);const jobs=r._meta.jobs;if(JSON.stringify(jobs)!==JSON.stringify(state.jobs)){state.jobs=jobs;historyList();}
    }catch(err){if(mounted===version)note.textContent=err.message;}
    if(mounted===version&&request===loading)poll=setTimeout(reload,state.jobs.some(j=>['queued','running','planned'].includes(j.status)||headline(j)==='执行中')?2000:12000);
  }
  function pick(){
    const dialog=el(document.body,'dialog','chat-dialog');dialog.id='chat-choice';dialog.setAttribute('aria-labelledby','chat-chooser-title');
    const top=el(dialog,'div','dialog-head');el(top,'h2','','选择聊天').id='chat-chooser-title';action(top,'close-dialog','关闭',()=>dialog.close());
    const q=el(dialog,'input','chat-search');q.type='search';q.placeholder='搜索聊天名称';q.setAttribute('aria-label','搜索聊天名称');
    const controls=el(dialog,'div','chat-tabs'),list=el(dialog,'div','chat-list'),footer=el(dialog,'div','dialog-foot');
    const selected=new Map(state.sources.map(s=>[s.id,s]));const count=el(footer,'span','muted');action(footer,'send','完成',()=>{state.sources=[...selected.values()];state.requestId=null;dialog.close();renderSources();});
    let kind='group',token='',seq=0,timer,items=[],busy=false;
    const tabs=['group','p2p'].map(k=>action(controls,'',k==='group'?'群聊':'私聊',()=>{if(kind!==k){kind=k;void load(false);}}));
    function paint(){
      list.replaceChildren();count.textContent='已选 '+selected.size+' 个聊天';
      for(const s of items){
        const b=action(list,'chat-item',null,()=>{if(selected.has(s.id))selected.delete(s.id);else if(selected.size<12)selected.set(s.id,s);else{return;}paint();[...list.querySelectorAll('[data-chat]')].find(x=>x.dataset.chat===s.id)?.focus({preventScroll:true});});
        b.dataset.chat=s.id;b.setAttribute('aria-pressed',String(selected.has(s.id)));el(b,'span','',s.name);el(b,'span','tick',selected.has(s.id)?'✓':'');
      }
      if(busy)el(list,'p','empty','正在读取聊天…');else if(!items.length)el(list,'p','empty','本页没有匹配的聊天');
      if(token&&!busy)action(list,'choose','加载更多',()=>load(true));
    }
    async function load(more){
      const req=++seq;busy=true;if(!more){items=[];token='';}
      tabs.forEach((b,i)=>b.setAttribute('aria-pressed',String(i===(kind==='group'?0:1))));paint();
      try{const r=await call('select_chats',{kind,query:q.value.trim(),cursor:more?token:''});if(req!==seq||!dialog.open)return;
        const data=r._meta.data;items=[...new Map([...items,...data.chats].map(s=>[s.id,s])).values()];token=data.next;busy=false;paint();
      }catch(e){if(req===seq&&dialog.open){busy=false;list.replaceChildren();el(list,'p','empty',e.message);action(list,'choose','重试',()=>load(more));}}
    }
    q.oninput=()=>{seq++;clearTimeout(timer);timer=setTimeout(()=>load(false),220);};
    dialog.onclose=()=>{seq++;clearTimeout(timer);dialog.remove();choose.focus();};
    dialog.onkeydown=e=>{if(e.key==='Escape')e.stopPropagation();};dialog.showModal();q.focus();void load(false);
  }
  refreshDispatch=reload;renderSources();historyList();void reload();
}
