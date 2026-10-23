import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { appendIssue, readIssuePage, exportIssueHistory, clearIssueHistory } from '../background/issue-history.js';

const store = { config: { api: { apiKey: 'ACTIVE_SECRET' } }, savedKeys: [{ key: 'SAVED_SECRET' }],
  issueLog: [{ at: '2026-10-20T00:00:00Z', stage: '旧异常', message: '没有现场' }] };
const sent = [];
let mode = 'ok';
globalThis.crypto ||= webcrypto;
globalThis.chrome = { storage: { local: {
  get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in store).map(k => [k, store[k]])),
  set: async rows => Object.assign(store, structuredClone(rows)),
  getKeys: async () => Object.keys(store),
  remove: async keys => keys.forEach(key => delete store[key]),
} }, runtime: { getManifest: () => ({ version: '0.9.14' }) }, tabs: { sendMessage: async (...args) => {
  sent.push(args);
  if (mode === 'gone') throw new Error('页面已关闭');
  if (mode === 'timeout') return new Promise(() => {});
  return { schema: 1, status: 'captured', capturedAt: new Date().toISOString(), documents: [
    { status: 'readable', html: '<section>ACTIVE_SECRET SAVED_SECRET</section>', url: 'https://user:pass@example.test/task?token=URL_SECRET#HASH_SECRET' },
    { status: 'unreadable', reason: '跨域限制' },
  ] };
} } };
const background = fs.readFileSync(new URL('../background/service-worker.js', import.meta.url), 'utf8');
const recorder = vm.createContext({ chrome, appendIssue, issueWrites: Promise.resolve(), URL, Date, setTimeout, clearTimeout });
vm.runInContext(background.slice(background.indexOf('function recordIssue('), background.indexOf('async function saveQueue(')), recorder);
const record = (entry = {}, sender = {}) => recorder.recordIssue({ stage: '测试异常', message: '测试错误', ...entry }, sender);

let unblock;
recorder.issueWrites = new Promise(resolve => { unblock = resolve; });
const pending = record({}, { tab: { id: 42 } });
assert.equal(sent.length, 1, '必须在等待前一条写入之前请求现场');
assert.equal(sent[0][2].frameId, 0);
unblock(); await pending;
let page = await readIssuePage();
assert.equal(page.total, 2, '旧记录迁移后仍然保留');
assert.ok(page.issues.some(row => row.sceneSummary?.documents === 2 && row.sceneSummary.unreadable === 1));
assert.ok(page.issues.some(row => row.sceneSummary === null));
assert.ok(page.issues.every(row => !('scene' in row)), '分页不得传完整HTML');
let exported = JSON.parse(await (await exportIssueHistory('0.9.14')).blob.text());
assert.equal(exported.count, 2);
assert.ok(exported.issues.some(row => row.scene?.documents[0].html.includes('<section>')));
for (const secret of ['ACTIVE_SECRET', 'SAVED_SECRET', 'URL_SECRET', 'HASH_SECRET', 'user:pass']) assert.ok(!JSON.stringify(exported.issues).includes(secret), secret);
console.log('PASS 即时请求、旧记录迁移、分页轻量摘要、单文件完整导出与后台二次脱敏');

const sentBefore = sent.length;
await record({ scene: { status: 'captured', documents: [{ html: '错误当时的结构' }] } });
assert.equal(sent.length, sentBefore, '内容脚本已采现场时不得延后重采');
mode = 'gone'; await record({}, { tab: { id: 42 }, frameId: 3 });
assert.equal(sent.at(-1)[2].frameId, 3);
mode = 'timeout'; await record({}, { tab: { id: 42 } });
await record({ scene: { html: 'x'.repeat(600001) } });
exported = JSON.parse(await (await exportIssueHistory('0.9.14')).blob.text());
const reasons = exported.issues.map(row => row.scene?.reason || '').join('|');
assert.match(reasons, /页面已关闭/); assert.match(reasons, /超时/); assert.match(reasons, /大小限制/);
assert.ok(exported.issues.some(row => row.scene?.documents?.[0].html === '错误当时的结构'));
console.log('PASS 内容脚本现场直接保留；页面关闭、无响应、超限仍保留异常及明确原因');

await clearIssueHistory();
assert.equal((await readIssuePage()).total, 0);
assert.ok(store.config && store.savedKeys, '清空诊断不能清除用户配置');
assert.equal(JSON.parse(await (await exportIssueHistory('0.9.14')).blob.text()).count, 0);
console.log('PASS 清空同时删除现场与历史备份，配置保留，空记录仍可导出');
