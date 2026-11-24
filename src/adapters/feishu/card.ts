import type { Admission, Choice } from './admission-store.ts';
const plain = (content: string) => ({ tag: 'plain_text', content });
const option = (content: string, value: string) => ({ text: plain(content), value });
export interface ContextPicker {
  chats: { id: string; name: string }[];
}
export function renderAdmission(
  r: Admission,
  projects: Record<string, { name: string }>,
  picker?: ContextPicker,
) {
  const bindable = r.chatType === 'group' && Boolean(r.chatId);
  const waiting = r.status === 'waiting';
  const form = {
    tag: 'form',
    name: 'router_admission',
    elements: [
      ...(bindable
        ? [
            { tag: 'div', text: plain('此群以后绑定到哪个项目？') },
            {
              tag: 'select_static',
              name: 'binding',
              width: 'fill',
              required: true,
              initial_option: 'none',
              options: [
                option('不新增绑定', 'none'),
                ...Object.entries(projects).map(([id, p]) => option(p.name, 'project:' + id)),
              ],
            },
          ]
        : []),
      ...(picker
        ? [
            { tag: 'div', text: plain('首次识别来信来源，请选择对应的飞书聊天。后续消息会记住这次选择。') },
            ...(picker.chats.length
              ? [
                  {
                    tag: 'select_static',
                    name: 'source_chat',
                    placeholder: plain('选择来源聊天'),
                    options: picker.chats.map((c) => option(c.name, c.id)),
                  },
                ]
              : []),
            { tag: 'input', name: 'source_link', placeholder: plain(r.chatType==='p2p'?'其他私聊可填会话链接、oc_ 或对方的 ou_ 标识':'其他聊天可粘贴会话链接或 oc_ 标识') },
          ]
        : []),
      { tag: 'div', text: plain('是否读取本会话上文并交给 Router 处理？') },
      {
        tag: 'select_static',
        name: 'execution',
        width: 'fill',
        required: true,
        placeholder: plain('请选择'),
        options: [option('读取本会话上文并执行 Router', 'run_context'), option('中断本次处理', 'stop')],
      },
      {
        tag: 'button',
        name: 'router_admit_' + r.eventId,
        type: 'primary',
        text: plain('提交决定'),
        form_action_type: 'submit',
      },
    ],
  };
  return {
    schema: '2.0',
    config: { update_multi: true, enable_forward: false },
    header: {
      template: waiting ? 'blue' : 'grey',
      title: plain(
        waiting
          ? (r.chatType === 'p2p' ? '私聊消息' : r.chatType === 'group' ? '未绑定群聊' : '消息') +
              ' · 待你决定'
          : '已提交 · ' + (r.status === 'allowed' ? '已放行' : '已中断'),
      ),
    },
    body: {
      elements: [
        {
          tag: 'div',
          text: plain(
            r.chatType === 'p2p'
              ? '发送者：' + r.sender
              : '会话：' + (r.chatName || r.chatId || '未提供') + '\n发送者：' + r.sender,
          ),
        },
        { tag: 'div', text: plain(r.excerpt) },
        { tag: 'hr' },
        waiting
          ? form
          : {
              tag: 'div',
              text: plain(
                (bindable
                  ? (r.chosenProject
                      ? '已绑定项目：' + (projects[r.chosenProject]?.name ?? r.chosenProject)
                      : '未新增绑定') + '\n'
                  : '') +
                  '本次处理：' +
                  (r.status === 'allowed' ? '已放行给 Router' : '已中断'),
              ),
            },
      ],
    },
  };
}
export function parseSubmission(
  raw: unknown,
): { id: string; actor: string; receipt: string; choice: Choice } | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (
    e.type !== 'card.action.trigger' ||
    e.action_tag !== 'button' ||
    typeof e.action_name !== 'string' ||
    !/^router_admit_[a-f0-9]{64}$/.test(e.action_name)
  )
    return null;
  const f = typeof e.form_value === 'string' ? JSON.parse(e.form_value) : e.form_value;
  if (
    !f ||
    !(
      f.binding === undefined ||
      f.binding === 'none' ||
      (typeof f.binding === 'string' && f.binding.startsWith('project:') && f.binding.length > 8)
    ) ||
    !['run', 'run_context', 'stop'].includes(f.execution) ||
    typeof e.operator_id !== 'string' ||
    typeof e.message_id !== 'string'
  )
    throw Error('Invalid admission form');
  let openChat: string | undefined;
  if (f.execution === 'run_context') {
    const typed = String(f.source_link ?? '').trim();
    if (typed) {
      openChat = /^o[cu]_[a-zA-Z0-9]+$/.test(typed)
        ? typed
        : (new URL(typed).searchParams.get('openChatId') ?? '');
      if (!/^o[cu]_[a-zA-Z0-9]+$/.test(openChat)) throw Error('Invalid Feishu chat link');
    } else if (f.source_chat) openChat = f.source_chat;
  }
  return {
    id: e.action_name.slice('router_admit_'.length),
    actor: e.operator_id,
    receipt: e.message_id,
    choice: {
      ...(f.binding === undefined ? {} : { project: f.binding === 'none' ? null : f.binding.slice(8) }),
      execute: f.execution !== 'stop',
      ...(f.execution === 'run_context' ? { readContext: true } : {}),
      ...(openChat ? { openChat } : {}),
    },
  };
}
