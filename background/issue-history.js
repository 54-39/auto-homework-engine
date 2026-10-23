/* 每次异常使用独立键；不设保留条数、不自动删除。分页只影响展示。 */
export const ISSUE_PREFIX = 'issue:';
let migration;
export function migrateIssueHistory() {
  if (!migration) migration = (async () => {
    const { issueLog } = await chrome.storage.local.get('issueLog');
    if (!Array.isArray(issueLog) || !issueLog.length) return;
    const entries = await Promise.all(issueLog.map(async row => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(row)));
      const hash = [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
      const key = ISSUE_PREFIX + String(Date.parse(row.at) || 0).padStart(13, '0') + ':legacy-' + hash;
      return [key, { ...row, firstAt: row.firstAt || row.at, lastAt: row.lastAt || row.at }];
    }));
    const existing = await chrome.storage.local.get(entries.map(([key]) => key));
    const missing = Object.fromEntries(entries.filter(([key]) => !existing[key]));
    if (Object.keys(missing).length) await chrome.storage.local.set(missing);
    // 旧数组作为迁移备份保留；只有用户手动清空异常记录时才一起删除。
  })().catch(e => { migration = null; throw e; });
  return migration;
}

export async function appendIssue(item) {
  await migrateIssueHistory();
  const key = ISSUE_PREFIX + String(Date.now()).padStart(13, '0') + ':' + crypto.randomUUID();
  await chrome.storage.local.set({ [key]: { ...item, firstAt: item.at, lastAt: item.at } });
}

export async function issueKeys() {
  await migrateIssueHistory();
  const keys = await chrome.storage.local.getKeys();
  return keys.filter(key => key.startsWith(ISSUE_PREFIX)).sort().reverse();
}

export async function readIssuePage(offset = 0, limit = 50) {
  const keys = await issueKeys();
  const start = Math.max(0, Number(offset) || 0);
  const size = Math.max(1, Math.min(100, Number(limit) || 50));
  const selected = keys.slice(start, start + size);
  const rows = selected.length ? await chrome.storage.local.get(selected) : {};
  return { issues: selected.map(key => {
    const { scene, ...item } = rows[key];
    // 列表只传采集摘要；完整结构留在本机，导出时一次带走。
    const sceneSummary = scene ? { status: scene.status, capturedAt: scene.capturedAt, truncated: scene.truncated,
      documents: scene.documents?.length || 0, unreadable: scene.documents?.filter(d => d.status === 'unreadable').length || 0, reason: scene.reason || scene.error } : null;
    return { id: key, ...item, sceneSummary };
  }), total: keys.length, offset: start, limit: size };
}

export async function clearIssueHistory() {
  const keys = await issueKeys();
  await chrome.storage.local.remove([...keys, 'issueLog']);
}

export async function exportIssueHistory(version) {
  // 分批读取，避免把所有记录通过 runtime 消息一次塞到设置页。
  const keys = await issueKeys();
  const chunks = [JSON.stringify({ version, exportedAt: new Date().toISOString(), count: keys.length }).slice(0, -1) + ',"issues":['];
  let first = true;
  for (let i = 0; i < keys.length; i += 100) {
    const selected = keys.slice(i, i + 100);
    const rows = await chrome.storage.local.get(selected);
    for (const key of selected) {
      if (!rows[key]) throw new Error('导出期间记录已被清空，请重新导出');
      chunks.push((first ? '' : ',') + JSON.stringify({ id: key, ...rows[key] }));
      first = false;
    }
  }
  chunks.push(']}');
  return { count: keys.length, blob: new Blob(chunks, { type: 'application/json;charset=utf-8' }) };
}
