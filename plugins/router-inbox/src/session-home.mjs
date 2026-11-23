import {
  ChevronDown,
  Folder,
  MessageCircle,
  ArrowUpRight,
  Scan,
  Ellipsis,
  Search,
  ChevronLeft,
} from 'lucide';
import { showMenu } from './action-menu.mjs';
import { projectSessions } from './session-index.mjs';

const expanded = new Map();
const searches = new Map();
function when(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const today = new Date(),
    yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toDateString() === yesterday.toDateString()
      ? '昨天'
      : date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}
export function sessionHome(
  main,
  { projects, records, focusId, lastOpened, add, button, icon, navigate, back, open, refresh },
) {
  const page = add(main, 'section', 'page session-home' + (focusId ? ' is-focused' : ''));
  function more(parent, label, options) {
    const b = button(parent, 'session-more', null, () => showMenu(b, options, label));
    icon(b, Ellipsis);
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', 'false');
    return b;
  }
  if (focusId) {
    const b = button(page, 'session-back', null, back);
    icon(b, ChevronLeft);
    add(b, 'span', '', '全部项目');
  }
  const head = add(page, 'header', 'session-head'),
    heading = add(head, 'div', 'session-heading');
  const title = add(heading, 'h1', '', focusId ? projects[focusId]?.name || focusId : '项目会话');
  if (focusId) {
    title.dataset.shared = focusId;
    more(heading, '项目操作', [{ label: '项目管理', action: () => navigate('project', focusId) }]);
  }
  const searchBox = add(head, 'label', 'session-search');
  icon(searchBox, Search);
  const input = add(searchBox, 'input', '');
  input.type = 'search';
  input.placeholder = focusId ? '搜索此项目会话' : '搜索项目或会话';
  input.setAttribute('aria-label', input.placeholder);
  input.value = searches.get(focusId) || '';
  if (!focusId)
    more(head, '更多操作', [
      { label: '主动派单', action: () => navigate('dispatch') },
      { label: '消息记录', action: () => navigate('feed') },
      { label: '项目管理', action: () => navigate('projects') },
      { label: '刷新', action: refresh },
    ]);
  const groups = Object.entries(projects).map(([id, p]) => ({
    id,
    name: p.name || id,
    items: projectSessions(id, p, records, lastOpened),
  }));
  groups.sort(
    (a, b) =>
      Number(b.items.some((s) => s.id === lastOpened)) - Number(a.items.some((s) => s.id === lastOpened)),
  );
  const list = add(page, 'div', 'session-groups');
  const sections = [];
  for (const [index, g] of groups.entries()) {
    if (focusId && g.id !== focusId) continue;
    const section = add(list, 'section', 'session-group');
    section.dataset.group = g.id;
    let toggle;
    if (focusId) add(section, 'h2', 'session-subtitle', '工作会话');
    else {
      const bar = add(section, 'div', 'group-bar');
      toggle = button(bar, 'group-toggle', null, () => {
        expanded.set(g.id, toggle.getAttribute('aria-expanded') !== 'true');
        updateOpen(expanded.get(g.id));
      });
      icon(toggle, Folder);
      const name = add(toggle, 'span', 'group-name', g.name);
      name.dataset.shared = g.id;
      icon(toggle, ChevronDown);
      toggle.setAttribute('aria-label', g.name);
      const focus = button(bar, 'project-focus', null, () => navigate('focus', g.id));
      icon(focus, Scan);
      add(focus, 'span', '', '只看此项目');
      focus.setAttribute('aria-label', '只看此项目：' + g.name);
      focus.dataset.navKey = 'focus-' + g.id;
      more(bar, g.name + '的项目操作', [
        { label: '项目管理', action: () => navigate('project', g.id) },
      ]).dataset.navKey = 'manage-' + g.id;
    }
    const fold = add(section, 'div', 'session-fold'),
      clip = add(fold, 'div', 'session-clip'),
      body = add(clip, 'div', 'session-list');
    fold.id = 'session-fold-' + index;
    toggle?.setAttribute('aria-controls', fold.id);
    const rows = [];
    for (const s of g.items) {
      const row = add(body, 'div', 'session-row');
      const launch = button(row, 'session-launch', null, async () => {
        if (launch.disabled) return;
        launch.disabled = true;
        try {
          await open(s.id);
        } finally {
          launch.disabled = false;
        }
      });
      icon(launch, MessageCircle);
      add(launch, 'span', 'session-name', s.title);
      const out = add(launch, 'span', 'session-open-icon');
      icon(out, ArrowUpRight);
      if (lastOpened === s.id) add(launch, 'span', 'last-session', '上次打开');
      if (s.time) {
        const ts = add(launch, 'time', '', when(s.time));
        ts.dateTime = s.time;
        ts.title = '最近关联记录 · ' + new Date(s.time).toLocaleString();
      }
      launch.setAttribute('aria-label', '在 Codex 中打开：' + s.title);
      launch.dataset.session = s.id;
      const options = [{ label: '在 Codex 中打开', action: () => launch.click() }];
      if (s.records.length) options.push({ label: '查看流程', action: () => navigate('trace', g.id, s.id) });
      more(row, s.title + '的会话操作', options).dataset.navKey = 'trace-' + s.id;
      rows.push({ el: row, title: s.title.toLocaleLowerCase() });
    }
    if (!g.items.length) add(body, 'p', 'session-empty', '暂无工作会话');
    const updateOpen = (on) => {
      section.dataset.open = String(on);
      toggle?.setAttribute('aria-expanded', String(on));
      fold.inert = !on;
    };
    const filterGroup = (q) => {
      const matchProject = !focusId && g.name.toLocaleLowerCase().includes(q);
      let matches = 0;
      for (const r of rows) {
        r.el.hidden = Boolean(q) && !matchProject && !r.title.includes(q);
        if (!r.el.hidden) matches++;
      }
      section.hidden = Boolean(q) && !matchProject && matches === 0;
      updateOpen(Boolean(focusId || q) || (expanded.get(g.id) ?? index < 2));
      return !section.hidden;
    };
    sections.push(filterGroup);
  }
  const empty = add(list, 'p', 'session-empty', '');
  function filter() {
    const q = input.value.trim().toLocaleLowerCase();
    searches.set(focusId, input.value);
    const visible = sections.map((fn) => fn(q)).some(Boolean);
    empty.hidden = visible;
    empty.textContent = q ? '没有匹配的项目或会话' : '还没有登记项目';
  }
  input.addEventListener('input', () => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      filter();
      return;
    }
    const elements = [...list.querySelectorAll('.group-bar,.session-row')];
    const before = new Map(
      elements.filter((el) => el.checkVisibility()).map((el) => [el, el.getBoundingClientRect().top]),
    );
    filter();
    for (const el of elements) {
      if (!el.checkVisibility()) continue;
      const old = before.get(el);
      const distance = old === undefined ? 4 : old - el.getBoundingClientRect().top;
      if (!distance) continue;
      for (const animation of el.getAnimations()) if (animation.id === 'filter-move') animation.cancel();
      const motion = el.animate(
        [
          {
            transform: 'translateY(' + Math.max(-24, Math.min(24, distance)) + 'px)',
            opacity: old === undefined ? 0.4 : 1,
          },
          { transform: 'none', opacity: 1 },
        ],
        { duration: 145, easing: 'ease-out' },
      );
      motion.id = 'filter-move';
    }
  });
  filter();
}
