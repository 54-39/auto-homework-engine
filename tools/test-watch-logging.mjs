import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 运行面板真实的后台消息处理器，验证自动刷课与手动解题的日志区别。
const panel = fs.readFileSync(new URL('../content/homework/panel.js', import.meta.url), 'utf8');
const start = panel.indexOf('    chrome.runtime.onMessage.addListener((msg) => {');
const source = panel.slice(start, panel.indexOf('\n    readPageQuestions();', start));
let receive;
const logs = [], writes = [], issues = [], messages = [];
const context = vm.createContext({
  autoRun: true, stopRequested: false, detecting: false, queueInfo: null,
  log: text => logs.push(text), reportIssue: (...args) => issues.push(args),
  setRow() {}, setBusy() {}, setSummary() {}, setWatchLine() {}, refreshQueueInfo() {},
  requireCurrentPage: () => true, answersMatch: () => false,
  rows: [{ dataset: {} }], els: { panel: { classList: { remove() {} } } },
  HW: { questions: [{ meta: { type: 'choice', stem: '测试题目' } }], Extractor: { currentAnswer: () => null },
    Filler: { fill: async () => writes.push('filled'), verify: () => true } },
  chrome: { runtime: { onMessage: { addListener: fn => { receive = fn; } }, sendMessage: msg => { messages.push(msg); return Promise.resolve({ ok: true }); } } },
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
assert.match(logs.join('|'), /页面填写异常/); assert.equal(issues.length, 0, '面板不应与后台重复记录同一次填写失败');
assert.ok(messages.some(m => m.type === 'HW_FILLED' && m.payload.ok === false && /页面填写异常/.test(m.payload.error)), '失败回执必须交给后台统一记录诊断');
console.log('PASS 自动刷课成功不逐题刷日志；填写异常携带回执，由后台统一记录一次');

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

const homework = panel.slice(panel.indexOf('    async function runHomework()'), panel.indexOf('    HW.Panel.runHomework = runHomework;'));
const incomplete = vm.createContext({
  autoRun: false, autoDocument: null, answerPauseReason: '', document: {}, Date,
  setTimeout: fn => setTimeout(fn, 0),
  HW: { questions: [{ _status: 'filled', meta: { stem: '已填题' } }, { _status: 'queued', meta: { stem: '未处理题' } }] },
  els: { list: { querySelector: () => null }, detect: { disabled: false }, stop: { disabled: true } },
  readPageQuestions: () => true, startAnswering: async () => true, stopWatching() {},
  log: text => logs.push(text), reportIssue: (_, message) => issues.push(message),
});
vm.runInContext(homework, incomplete);
await incomplete.runHomework();
assert.match(issues.at(-1), /1 题未处理/);
assert.ok(!issues.at(-1).includes('0 题填写失败'));
console.log('PASS 未处理题数独立计数，不再误写零题填写失败');

let deadlineClock = 0;
incomplete.Date = { now: () => (deadlineClock += 200000) };
incomplete.els.detect.disabled = true;
incomplete.els.stop.disabled = false;
incomplete.stopRequested = false;
incomplete.setBusy = busy => { incomplete.els.detect.disabled = busy; incomplete.els.stop.disabled = !busy; };
incomplete.send = async type => messages.push({ type });
await assert.rejects(incomplete.runHomework(), /答题超时/);
assert.equal(incomplete.stopRequested, true);
assert.equal(messages.at(-1).type, 'HW_STOP');
assert.equal(incomplete.els.stop.disabled, true);
console.log('PASS 自动填写超时先取消后台，迟到答案不能跟到下一页');

incomplete.Date = Date;
incomplete.answerPauseReason = 'API 鉴权失败';
await assert.rejects(incomplete.runHomework(), /API 鉴权失败.*不提交测验/);
console.log('PASS 鉴权等整轮暂停后不再把空卷当作已填写并交卷');
