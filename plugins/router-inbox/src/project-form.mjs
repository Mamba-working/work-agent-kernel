function element(parent, tag, cls, text) {
  const el = document.createElement(tag);
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  parent.append(el);
  return el;
}
function button(parent, label, action, cls = 'form-action') {
  const el = element(parent, 'button', cls, label);
  el.type = 'button';
  el.onclick = action;
  return el;
}
function field(parent, label, placeholder, { required = false, multiline = false } = {}) {
  const wrap = element(parent, 'label', 'project-field');
  element(wrap, 'span', 'field-name', label);
  const el = element(wrap, multiline ? 'textarea' : 'input', '');
  el.placeholder = placeholder;
  el.required = required;
  return el;
}

export function showProjectForm(trigger, { submit, findGroups, onCreated }) {
  if (document.querySelector('.project-form-dialog')) return;
  const dialog = element(document.body, 'dialog', 'project-form-dialog');
  dialog.setAttribute('aria-labelledby', 'new-project-heading');
  const form = element(dialog, 'form', 'project-form');
  const head = element(form, 'header', 'project-form-head');
  element(head, 'h2', '', '新建项目').id = 'new-project-heading';
  const close = button(head, '×', () => dialog.close(), 'form-close');
  close.setAttribute('aria-label', '关闭');
  const fields = element(form, 'div', 'project-form-fields');
  const name = field(fields, '项目名称', '例如：酒店卡片升级', { required: true });
  const cwd = field(fields, '工作目录', '~/code/my-project', { required: true });
  element(fields, 'p', 'field-hint', 'Codex 将在这个本地目录中处理项目任务。');
  const context = field(fields, '项目背景（选填）', '需求说明或 PRD 链接', { multiline: true });
  function collection(label, addLabel, build) {
    const section = element(fields, 'section', 'project-associations');
    const bar = element(section, 'div', 'association-bar');
    element(bar, 'h3', '', label);
    const rows = new Map();
    const add = button(bar, addLabel, () => {
      const row = element(section, 'div', 'association-row');
      const values = build(row);
      rows.set(row, values);
      const remove = button(
        row,
        '移除',
        () => {
          rows.delete(row);
          row.remove();
          add.focus();
        },
        'form-action remove-association',
      );
      remove.setAttribute('aria-label', '移除' + label);
      row.querySelector('input').focus();
    });
    return () => Array.from(rows.values(), (read) => read());
  }
  const groups = collection('关联飞书群', '＋ 添加群', (row) => {
    const title = field(row, '群名称', '需求讨论群', { required: true });
    const lookup = button(row, '按群名称查找', () => search(''));
    const results = element(row, 'div', 'project-group-results');
    const id = field(row, '群 ID', '选择搜索结果或粘贴已核实的 ID', { required: true });
    const advanced = element(row, 'details', 'group-aliases');
    element(advanced, 'summary', '', '其他群标识（选填）');
    const aliases = field(advanced, '别名', '多个别名用逗号分隔');
    let revision = 0;
    title.addEventListener('input', () => {
      revision++;
      lookup.disabled = false;
      results.replaceChildren();
    });
    async function search(cursor) {
      const version = ++revision;
      lookup.disabled = true;
      results.replaceChildren();
      element(results, 'span', 'field-hint', '正在查找…');
      try {
        const page = await findGroups(title.value.trim(), cursor);
        if (version !== revision || !row.isConnected) return;
        results.replaceChildren();
        for (const chat of page.chats)
          button(results, chat.name, () => {
            title.value = chat.name;
            id.value = chat.id;
            results.replaceChildren();
            title.dispatchEvent(new Event('input', { bubbles: true }));
            id.focus();
          });
        if (!page.chats.length) element(results, 'span', 'field-hint', '没有找到匹配群，可手动填写群 ID。');
        if (page.next) button(results, '下一页', () => search(page.next));
      } catch (err) {
        if (version === revision) results.textContent = err.message || '群列表读取失败，可手动填写群 ID。';
      } finally {
        if (version === revision) lookup.disabled = false;
      }
    }
    return () => ({
      name: title.value.trim(),
      id: id.value.trim(),
      aliases: aliases.value
        .split(/[,，\n]/)
        .map((v) => v.trim())
        .filter(Boolean),
    });
  });
  const sessions = collection('已有 Codex 会话', '＋ 添加会话', (row) => {
    const title = field(row, '会话标题', '工作会话名称', { required: true });
    const id = field(row, '会话链接或 ID', 'codex://threads/…', { required: true });
    return () => ({ title: title.value.trim(), id: id.value.trim() });
  });
  const error = element(form, 'p', 'project-form-error');
  error.setAttribute('role', 'alert');
  const footer = element(form, 'footer', 'project-form-footer');
  const cancel = button(footer, '取消', () => dialog.close());
  const save = element(footer, 'button', 'project-save', '创建项目');
  save.type = 'submit';
  let saving = false,
    requestId = null,
    previousBody = null,
    created = null;
  form.addEventListener('input', () => {
    error.textContent = '';
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving) return;
    const input = {
      name: name.value.trim(),
      cwd: cwd.value.trim(),
      context: context.value.trim(),
      groups: groups(),
      sessions: sessions(),
    };
    if (!input.name || !input.cwd) {
      error.textContent = '请填写项目名称和工作目录。';
      (!input.name ? name : cwd).focus();
      return;
    }
    const body = JSON.stringify(input);
    if (previousBody !== body) {
      requestId = crypto.randomUUID();
      previousBody = body;
    }
    saving = true;
    fields.inert = true;
    cancel.disabled = close.disabled = save.disabled = true;
    save.textContent = '创建中…';
    error.textContent = '';
    try {
      created = await submit({ ...input, requestId });
      dialog.close();
    } catch (err) {
      error.textContent = err.message || '创建失败，请重试。';
    } finally {
      saving = false;
      fields.inert = false;
      cancel.disabled = close.disabled = save.disabled = false;
      save.textContent = '创建项目';
    }
  });
  dialog.addEventListener('cancel', (e) => {
    if (saving) e.preventDefault();
  });
  dialog.addEventListener(
    'close',
    () => {
      if (trigger.isConnected) trigger.focus({ preventScroll: true });
      if (created) onCreated(created);
      dialog.inert = true;
      Promise.allSettled(dialog.getAnimations().map((a) => a.finished)).then(() => dialog.remove());
    },
    { once: true },
  );
  dialog.showModal();
  name.focus();
}
