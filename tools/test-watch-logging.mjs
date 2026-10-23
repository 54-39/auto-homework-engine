import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 运行面板真实的后台消息处理器，验证自动刷课与手动解题的日志区别。
const panel = fs.readFileSync(new URL('../content/homework/panel.js', import.meta.url), 'utf8');
const start = panel.indexOf('    chrome.runtime.onMessage.addListener((msg) => {');
const source = panel.slice(start, panel.indexOf('\n    readPageQuestions();', start));
let receive;
const logs = [], writes = [], issues = [];
const context = vm.createContext({
  autoRun: true, stopRequested: false, detecting: false, queueInfo: null,
  log: text => logs.push(text), reportIssue: (...args) => issues.push(args),
  setRow() {}, setBusy() {}, setSummary() {}, setWatchLine() {}, refreshQueueInfo() {},
  requireCurrentPage: () => true, answersMatch: () => false,
  rows: [{ dataset: {} }], els: { panel: { classList: { remove() {} } } },
  HW: { questions: [{ meta: { type: 'choice', stem: '测试题目' } }], Extractor: { currentAnswer: () => null },
    Filler: { fill: async () => writes.push('filled'), verify: () => true } },
  chrome: { runtime: { onMessage: { addListener: fn => { receive = fn; } }, sendMessage: () => Promise.resolve({ ok: true }) } },
});
vm.runInContext(source, context);
const flush = () => new Promise(resolve => setImmediate(resolve));
receive({ type: 'HW_STATUS', payload: { index: 0, status: 'skipped' } });
receive({ type: 'HW_ANSWER', payload: { index: 0, answer: 'A' } }); await flush();
receive({ type: 'HW_DONE', payload: { filled: 1, total: 1 } });
assert.deepEqual(writes, ['filled'], '不能为了减少日志跳过真实填写');
assert.equal(logs.length, 0, '刷课不逐题记录正常完成');
receive({ type: 'HW_STATUS', payload: { index: 0, status: 'failed', error: 'Key无效' } });
receive({ type: 'HW_DONE', payload: { paused: 'API鉴权失败' } });
receive({ type: 'HW_WATCH_FINISHED', payload: { cancelled: true, reason: '账号登录检测，队列暂停' } });
assert.match(logs.join('|'), /Key无效/); assert.match(logs.join('|'), /API鉴权失败/); assert.match(logs.join('|'), /账号登录检测/);
context.HW.Filler.verify = () => { throw Error('页面填写异常'); };
receive({ type: 'HW_ANSWER', payload: { index: 0, answer: 'A' } }); await flush();
assert.match(logs.join('|'), /页面填写异常/); assert.equal(issues.length, 1, '异常仍需保存诊断');
console.log('PASS 自动刷课逐题成功不写日志；获取失败、填写异常与暂停原因仍显示并保存诊断');

context.autoRun = false; context.HW.Filler.verify = () => true; logs.length = 0;
receive({ type: 'HW_ANSWER', payload: { index: 0, answer: 'A' } }); await flush();
receive({ type: 'HW_DONE', payload: { filled: 1, total: 1 } });
assert.match(logs.join('|'), /第 1 题已填写/); assert.match(logs.join('|'), /全部处理完毕/);
console.log('PASS 手动解题仍有逐题填写与完成消息');

const background = fs.readFileSync(new URL('../background/service-worker.js', import.meta.url), 'utf8');
let queue = { tabId: 7 }, finished;
const worker = vm.createContext({ loadQueue: async () => queue, saveQueue: async q => { queue = q; }, sendTab: (_, event) => { finished = event; } });
vm.runInContext(background.slice(background.indexOf('async function pauseWatchForInterruptedPage('), background.indexOf('chrome.tabs.onUpdated.addListener(')), worker);
for (const url of ['https://detect.chaoxing.com/api/monitor_temp', 'https://i.chaoxing.com/space']) {
  queue = { tabId: 7 };
  await worker.pauseWatchForInterruptedPage({ id: 7, url });
  assert.equal(finished.payload.reason, queue.paused);
  assert.ok(finished.payload.reason.length > 10, '不能只显示无原因的已取消');
}
console.log('PASS 账号检测与离开学习页的停止消息携带具体原因');
