import {App} from '@modelcontextprotocol/ext-apps';

const app=new App({name:'Router 接入记录',version:'0.2.0'});
const get=id=>document.getElementById(id);
const labels={pending:'待处理',routed:'已分派',ignored:'已忽略',queued:'排队中',running:'处理中',ready:'已完成',waiting_input:'待补充',failed:'失败'};
let records=[],projects={},selection,filter='',projectFilter=null;
function actorName(record){return (record.actor??'').replace(/\s*\(\d{8,}\)\s*$/u,'')||'来源消息';}
function node(parent,tag,style,text){
  const el=document.createElement(tag);
  el.className=style;
  el.textContent=text??'';
  parent.append(el);
  return el;
}
function card(parent,title,body){
  const el=node(parent,'section','card');
  node(el,'h3','',title);
  node(el,'p','',body);
  return el;
}
async function call(name,args){
  const result=await app.callServerTool({name,arguments:args});
  if(result.isError)throw Error(result.content?.[0]?.text??'操作失败');
  return result;
}
function detail(r){
  const el=get('detail');
  el.replaceChildren();
  if(!r){node(el,'p','empty','没有匹配的消息');return;}
  const head=node(el,'div','d-head');
  node(head,'h2','',actorName(r));
  if(r.time)node(head,'span','muted',new Date(r.time).toLocaleString('zh-CN'));
  card(el,'消息正文',r.text);
  if(r.reason)card(el,'路由依据',r.reason);
  for(const t of r.tasks){
    const panel=card(el,[projects[t.project]?.name??t.project,labels[t.status]??t.status].filter(Boolean).join(' · '),t.goal);
    if(t.result)node(panel,'p','message-text',t.result);
    if(t.session){
      node(panel,'button','action','打开工作会话').onclick=async()=>{
        try{await call('open_session',{session:t.session});}catch(e){get('notice').textContent=e.message;}
      };
    }
  }
}
function render(){
  get('count').textContent=records.length;
  const segments=get('segments');
  segments.replaceChildren();
  for(const key of ['','pending','routed','ignored']){
    const button=node(segments,'button','segment'+(key===filter?' active':''),labels[key]??'全部');
    node(button,'span','n',records.filter(r=>!key||r.status===key).length);
    button.onclick=()=>{filter=key;render();};
  }
  const query=get('search').value.trim().toLowerCase();
  const rows=records.filter(r=>(!projectFilter||r.projectId===projectFilter)&&(!filter||r.status===filter)&&[r.text,r.actor,r.id,...r.tasks.map(t=>t.goal)].join(' ').toLowerCase().includes(query));
  if(projectFilter){
    node(segments,'button','segment active',(projects[projectFilter]?.name??projectFilter)+' ×').onclick=()=>{projectFilter=null;render();};
  }
  const selected=rows.find(r=>r.id===selection)??rows[0];
  selection=selected?.id;
  const list=get('list');list.replaceChildren();
  for(const r of rows){
    const row=node(list,'button','row'+(r===selected?' selected':''));
    row.setAttribute('aria-pressed',String(r===selected));
    const head=node(row,'span','row-head');
    node(head,'span','who',actorName(r));if(r.time)node(head,'time','time',new Date(r.time).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}));
    node(row,'span','row-text',r.text);
    const foot=node(row,'span','row-foot');
    node(foot,'span','chip '+({routed:'s-dispatched',pending:'s-open',ignored:'s-ignored'}[r.status]??''),labels[r.status]??r.status);
    row.onclick=()=>{selection=r.id;render();};
  }
  detail(selected);
  const catalog=get('projects');catalog.replaceChildren();
  if(!Object.keys(projects).length){card(catalog,'还没有登记项目','当前任务使用通用工作目录。');}
  for(const [id,project] of Object.entries(projects)){
    const panel=card(catalog,project.name??id,project.cwd);
    const count=records.filter(r=>r.projectId===id).length;
    node(panel,'button','segment','项目上下文 · '+count+' 条消息').onclick=()=>{
      projectFilter=id;filter='';get('search').value='';setView(false);render();
    };
    if(project.feishuChatId)node(panel,'p','', '绑定飞书群 · '+project.feishuChatId);
  }
}
function setView(projectsView){
  get('feed').classList.toggle('active',!projectsView);get('project-view').classList.toggle('active',projectsView);
  get('filters').hidden=projectsView;
  get('feed-tab').classList.toggle('active',!projectsView);get('project-tab').classList.toggle('active',projectsView);
}
function apply(result){
  const data=result._meta?.data;if(!data)return;
  records=data.records;projects=data.projects??{};get('notice').textContent=data.warnings.join(' · ');render();
}
async function refresh(){try{apply(await call('show_inbox',{}));}catch(e){get('notice').textContent=e.message;}}
get('feed-tab').onclick=()=>setView(false);get('project-tab').onclick=()=>setView(true);
get('search').oninput=render;get('reload').onclick=refresh;
app.ontoolresult=apply;app.connect().then(refresh).catch(e=>get('notice').textContent=e.message);
