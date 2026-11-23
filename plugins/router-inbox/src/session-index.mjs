// Registered sessions can exist before the first Router event. Keep their owner-supplied titles.
export function projectSessions(projectId, project, records, lastOpened) {
  const sessions = new Map();
  function entry(id, title) {
    if (!sessions.has(id)) sessions.set(id, { id, title: title || '未命名会话', time: null, records: [] });
    return sessions.get(id);
  }
  for (const session of project.sessions ?? []) entry(session.id, session.title);
  for (const record of records) {
    for (const task of record.tasks ?? []) {
      if (task.project !== projectId || !task.session) continue;
      const item = entry(task.session, task.goal);
      if (!item.records.includes(record)) item.records.push(record);
      if (record.time && (!item.time || Date.parse(record.time) > Date.parse(item.time)))
        item.time = record.time;
    }
  }
  return [...sessions.values()].sort(
    (a, b) =>
      Number(b.id === lastOpened) - Number(a.id === lastOpened) ||
      (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0),
  );
}
