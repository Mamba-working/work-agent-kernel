import {createElement, Check, ChevronDown, Folder, Folders} from 'lucide';

function icon(shape){
  return createElement(shape,{width:16,height:16,'stroke-width':1.65,'aria-hidden':'true'});
}

// Focus stays on the combobox. Arrow keys preview an option; only activation commits it.
export function projectPicker(parent, projects, selectedId, onChange){
  const options=[{id:null,name:'全部项目'},...Object.entries(projects).map(([id,p])=>({id,name:p.name||id}))];
  const chosen=Math.max(0,options.findIndex(option=>option.id===selectedId));
  let active=chosen, typed='', lastTyped=0;
  const trigger=document.createElement('button');
  trigger.type='button';trigger.className='scope-trigger';trigger.id='scope-trigger';
  trigger.setAttribute('role','combobox');trigger.setAttribute('aria-controls','scope-options');
  trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-expanded','false');
  trigger.setAttribute('aria-label','按项目筛选消息：'+options[chosen].name);
  const caption=document.createElement('span');caption.textContent=options[chosen].name;
  trigger.append(icon(chosen?Folder:Folders),caption,icon(ChevronDown));
  parent.append(trigger);

  const menu=document.createElement('div');
  menu.className='scope-menu';menu.id='scope-options';menu.popover='auto';
  menu.setAttribute('role','listbox');menu.setAttribute('aria-label','项目范围');
  parent.append(menu);
  trigger.popoverTargetElement=menu;
  const items=options.map((option,index)=>{
    const item=document.createElement('div');
    item.className='scope-option';item.id='scope-option-'+index;item.setAttribute('role','option');
    item.setAttribute('aria-selected',String(index===chosen));
    const text=document.createElement('span');text.textContent=option.name;
    item.append(icon(index?Folder:Folders),text);
    if(index===chosen)item.append(icon(Check));
    item.onpointermove=e=>{if(e.pointerType!=='touch'&&active!==index)setActive(index,false);};
    item.onmousedown=e=>e.preventDefault();
    item.onclick=()=>commit(index);menu.append(item);return item;
  });
  const isOpen=()=>menu.matches(':popover-open');
  function setActive(index,scroll=true){
    active=index;items.forEach((item,i)=>item.classList.toggle('active',i===active));
    trigger.setAttribute('aria-activedescendant',items[active].id);
    if(scroll)items[active].scrollIntoView({block:'nearest'});
  }
  function position(){
    const r=trigger.getBoundingClientRect(),edge=8,gap=5;
    const w=Math.min(window.innerWidth-2*edge,Math.max(240,r.width));
    const below=window.innerHeight-r.bottom-gap-edge,above=r.top-gap-edge;
    const up=below<Math.min(menu.scrollHeight,230)&&above>below;
    menu.style.width=w+'px';menu.style.maxHeight=Math.min(318,Math.max(40,up?above:below))+'px';
    menu.style.left=Math.max(edge,Math.min(r.right-w,window.innerWidth-w-edge))+'px';
    menu.style.top=(up?Math.max(edge,r.top-menu.offsetHeight-gap):r.bottom+gap)+'px';
    menu.style.transformOrigin=up?'right bottom':'right top';
  }
  function open(){
    if(isOpen())return;
    menu.showPopover();position();setActive(chosen);
  }
  function commit(index){
    menu.hidePopover();
    if(index!==chosen)onChange(options[index].id);
    document.getElementById('scope-trigger')?.focus({preventScroll:true});
  }
  function adjustOnScroll(e){if(!menu.contains(e.target))position();}
  menu.addEventListener('toggle',()=>{
    const expanded=isOpen();
    trigger.setAttribute('aria-expanded',String(expanded));
    if(expanded){
      position();setActive(active,false);
      window.addEventListener('resize',position);document.addEventListener('scroll',adjustOnScroll,true);
    }else{
      trigger.removeAttribute('aria-activedescendant');
      window.removeEventListener('resize',position);document.removeEventListener('scroll',adjustOnScroll,true);
    }
  });
  trigger.onclick=()=>{active=chosen;};
  trigger.onblur=()=>{if(isOpen())menu.hidePopover();};
  trigger.onkeydown=e=>{
    if(e.key==='Escape'&&isOpen()){e.preventDefault();e.stopPropagation();menu.hidePopover();return;}
    if(e.key==='Tab'){if(isOpen())menu.hidePopover();return;}
    if(e.key==='Enter'||e.key===' '){e.preventDefault();isOpen()?commit(active):open();return;}
    const offset={ArrowDown:1,ArrowUp:-1,Home:-Infinity,End:Infinity}[e.key];
    if(offset!==undefined){
      e.preventDefault();if(!isOpen()){open();if(Number.isFinite(offset))return;}
      setActive(Math.min(items.length-1,Math.max(0,active+offset)));return;
    }
    if(isOpen()&&e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){
      const now=Date.now();typed=(now-lastTyped<650?typed:'')+e.key.toLowerCase();lastTyped=now;
      const at=options.findIndex(o=>o.name.toLowerCase().startsWith(typed));if(at>=0)setActive(at);
    }
  };
}
