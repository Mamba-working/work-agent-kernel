let active;
let invoker;
let dismissOnClick;
document.addEventListener('pointerdown', event => {
  dismissOnClick = active?.matches(':popover-open') && invoker?.contains(event.target) ? invoker : null;
},true);
export function closeMenu() {
  if (active?.matches(':popover-open')) active.hidePopover();
}
export function showMenu(trigger, items, context) {
  if(dismissOnClick===trigger){dismissOnClick=null;closeMenu();return;}
  closeMenu();
  invoker=trigger;
  const menu = document.createElement('div');
  menu.className = 'session-menu';
  menu.popover = 'auto';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', context);
  document.body.append(menu);
  active = menu;
  for (const { label, action } of items) {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.textContent = label;
    item.onclick = () => {
      menu.hidePopover();
      trigger.focus({ preventScroll: true });
      action();
    };
    menu.append(item);
  }
  menu.addEventListener('keydown', (e) => {
    const buttons = [...menu.children],
      i = buttons.indexOf(document.activeElement);
    if (e.key === 'Tab') {
      menu.hidePopover();
      trigger.focus({preventScroll:true});
      return;
    }
    const next = {
      ArrowDown: (i + 1) % buttons.length,
      ArrowUp: (i - 1 + buttons.length) % buttons.length,
      Home: 0,
      End: buttons.length - 1,
    }[e.key];
    if (next !== undefined) {
      e.preventDefault();
      buttons[next].focus();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      menu.hidePopover();
      trigger.focus({ preventScroll: true });
    }
  });
  const reposition = () => {
    const r = trigger.getBoundingClientRect(),
      gap = 5;
    menu.style.left =
      Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth)) + 'px';
    const above = r.bottom + gap + menu.offsetHeight > innerHeight - 8;
    menu.style.top = Math.max(8, above ? r.top - gap - menu.offsetHeight : r.bottom + gap) + 'px';
    menu.style.transformOrigin = above ? 'right bottom' : 'right top';
  };
  menu.addEventListener('toggle', (e) => {
    if (e.newState !== 'closed') return;
    if (active === menu) active = null;
    trigger.setAttribute('aria-expanded', 'false');
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
    const cleanup = () => menu.remove();
    Promise.allSettled(menu.getAnimations().map((a) => a.finished)).then(cleanup);
  });
  trigger.setAttribute('aria-expanded', 'true');
  menu.showPopover();
  reposition();
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);
  menu.firstElementChild?.focus({ preventScroll: true });
}
