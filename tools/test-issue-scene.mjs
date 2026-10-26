import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { appendIssue, readIssuePage, exportIssueHistory, clearIssueHistory, issueKeys } from '../background/issue-history.js';

/* 诊断记录开关（config.diagnosticsEnabled，默认关）的行为回归：
   关=不采集、不写入，历史记录仍可查看/导出；开=即时反向采集+写入+脱敏。 */

const store = { config: { api: { apiKey: 'ACTIVE_SECRET' } }, savedKeys: [{ key: 'SAVED_SECRET' }],
  issueLog: [{ at: '2026-10-20T00:00:00Z', stage: '旧异常', message: '没有现场' }] };
const sent = [];
let mode = 'ok';
globalThis.crypto ||= webcrypto;
globalThis.chrome = { storage: { local: {
  get: async keys => structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in store).map(k => [k, store[k]]))),
  set: async rows => Object.assign(store, structuredClone(rows)),
  getKeys: async () => Object.keys(store),
  remove: async keys => keys.forEach(key => delete store[key]),
} }, runtime: { getManifest: () => ({ version: '0.9.14' }) }, tabs: { sendMessage: async (...args) => {
  sent.push(args);
  if (mode === 'gone') throw new Error('页面已关闭');
  if (mode === 'timeout') return new Promise(() => {});
  if (mode === 'hold') return new Promise(resolve => { releaseScene = resolve; });
  return { schema: 1, status: 'captured', capturedAt: new Date().toISOString(), documents: [
    { status: 'readable', html: '<section>ACTIVE_SECRET SAVED_SECRET</section>', url: 'https://user:pass@example.test/task?token=URL_SECRET#HASH_SECRET' },
    { status: 'unreadable', reason: '跨域限制' },
  ] };
} } };
const background = fs.readFileSync(new URL('../background/service-worker.js', import.meta.url), 'utf8');
const recorder = vm.createContext({ chrome, appendIssue, issueWrites: Promise.resolve(), URL, Date, setTimeout, clearTimeout });
vm.runInContext(background.slice(background.indexOf('function recordIssue('), background.indexOf('async function saveQueue(')), recorder);
const record = (entry = {}, sender = {}) => recorder.recordIssue({ stage: '测试异常', message: '测试错误', ...entry }, sender);
let releaseScene;

/* ---- 开关默认关：连采集请求都不发，也不写入 ---- */
const before = sent.length;
const skipped = await record({}, { tab: { id: 42 } });
assert.equal(sent.length, before, '开关关闭时不得请求页面结构采集');
assert.equal(skipped?.ok && skipped?.skipped === true, true, '返回应为 skipped');
assert.equal((await issueKeys()).length, 1, '开关关闭时不写入新记录');
let exported = JSON.parse(await (await exportIssueHistory('0.9.14')).blob.text());
assert.equal(exported.count, 1, '关闭期间旧记录仍可完整导出');
assert.ok(exported.issues[0].stage === '旧异常');
console.log('PASS 开关默认关：不采集、不写入，旧记录导出不受影响');

/* ---- 打开开关：即时请求现场、写入、导出带完整结构与脱敏 ---- */
store.config.diagnosticsEnabled = true;
let unblock;
recorder.issueWrites = new Promise(resolve => { unblock = resolve; });
const pending = record({}, { tab: { id: 42 } });
await Promise.resolve(); // 开关经 storage.get 确认（微任务级），随后立即请求现场
assert.equal(sent.length, before + 1, '开关确认后必须立即请求现场（不等前一条写完）');
assert.equal(sent[0][2].frameId, 0);
unblock(); await pending;
let page = await readIssuePage();
assert.equal(page.total, 2, '旧记录迁移后仍然保留');
assert.ok(page.issues.some(row => row.sceneSummary?.documents === 2 && row.sceneSummary.unreadable === 1));
assert.ok(page.issues.some(row => row.sceneSummary === null));
assert.ok(page.issues.every(row => !('scene' in row)), '分页不得传完整HTML');
exported = JSON.parse(await (await exportIssueHistory('0.9.14')).blob.text());
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

/* ---- 再次关闭：恢复不采集不写入，历史导出照常 ---- */
store.config.diagnosticsEnabled = false;
const total = (await readIssuePage()).total;
const sentAtClose = sent.length;
const again = await record({}, { tab: { id: 42 } });
assert.equal(again?.ok && again?.skipped === true, true, '开关再次关闭后回到 skipped');
assert.equal(sent.length, sentAtClose, '再次关闭后不再采集');
assert.equal((await readIssuePage()).total, total, '关闭后不再新增记录');
assert.equal(JSON.parse(await (await exportIssueHistory('0.9.14')).blob.text()).count, total, '关闭期间导出仍可用');
console.log('PASS 再次关闭恢复 skipped，历史记录查看与导出照常');

store.config.diagnosticsEnabled = true;
mode = 'hold';
const late = record({}, { tab: { id: 42 } });
await new Promise(resolve => setImmediate(resolve));
store.config.diagnosticsEnabled = false;
releaseScene({ status: 'captured', documents: [] });
assert.equal((await late).skipped, true);
assert.equal((await readIssuePage()).total, total, '关闭后迟到现场不能新增记录');
console.log('PASS 采集等待期间关闭开关，迟到现场不落盘');

await clearIssueHistory();
assert.equal((await readIssuePage()).total, 0);
assert.ok(store.config && store.savedKeys, '清空诊断不能清除用户配置');
assert.equal(JSON.parse(await (await exportIssueHistory('0.9.14')).blob.text()).count, 0);
console.log('PASS 清空同时删除现场与历史备份，配置保留，空记录仍可导出');
