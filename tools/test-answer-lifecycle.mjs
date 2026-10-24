import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const source = fs.readFileSync(new URL('../background/service-worker.js', import.meta.url), 'utf8');
const start = source.indexOf('async function fillAnswer(');
const queue = source.slice(start < 0 ? source.indexOf('async function startRun(') : start, source.indexOf('async function rerunOne('));
const ack = source.slice(source.indexOf("} else if (type === 'HW_FILLED') {") + "} else if (type === 'HW_FILLED') {".length,
  source.indexOf("} else if (type === 'HW_WATCH_COURSES') {"));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture() {
  const messages = [], issues = [];
  const context = vm.createContext({
    run: null, Date, crypto: { randomUUID }, setTimeout,
    getConfig: async () => ({ engine: 'api' }), cacheKeyOf: async () => 'fixture',
    cached: async () => ({ answer: 'B' }), cacheSet: async () => {},
    askEngine: async () => { throw Error('fixture model failed'); },
    AUTH_RE: /401/, RISKY_RE: /captcha/, notify() {},
    sendTab: (tabId, message) => { messages.push({ tabId, ...message }); return Promise.resolve(); },
    pauseRun: (tabId, reason) => { context.run.cancelled = true; issues.push(reason); },
  });
  vm.runInContext(queue + '\nasync function acknowledge(payload, tabId) { const sendResponse = value => value; ' + ack + '\n}', context);
  return { context, messages, issues,
    answer: () => messages.filter(m => m.type === 'HW_ANSWER'),
    done: () => messages.filter(m => m.type === 'HW_DONE'),
    ack: (message, ok = true, tabId = 7) => context.acknowledge({ index: message.payload.index, fillToken: message.payload.fillToken, ok }, tabId),
  };
}
for (const decision of ['ask', 'rewrite']) {
  const f = fixture();
  await f.context.startRun([{ type: 'choice', stem: '第一题', _decision: decision === 'rewrite' ? 'rewrite' : 'ask', _refAnswer: 'B', options: [{ key: 'A' }, { key: 'B' }] },
    { type: 'choice', stem: '第二题', _decision: 'skip' }], 7, 'https://mooc1.chaoxing.com/test');
  await wait(450);
  assert.equal(f.answer().length, 1);
  assert.equal(f.done().length, 0, '页面尚未回执就报告完成：' + decision);
  assert.ok(!f.messages.some(m => m.type === 'HW_STATUS' && m.payload.index === 1), '填写回执前已跳到下一题');
  await f.ack(f.answer()[0]);
  await wait(450);
  assert.equal(f.done().length, 1);
  assert.equal(f.done()[0].payload.filled, 1);
  await f.ack(f.answer()[0], false);
  assert.equal(f.issues.length, 0, '重复旧回执改变了已经完成的结果');
  console.log('PASS 填写回执后才推进和完成：' + decision);
}
{
  const f = fixture();
  await f.context.startRun([{ type: 'choice', _decision: 'ask' }], 7, 'https://mooc1.chaoxing.com/test');
  await wait(30);
  const message = f.answer()[0];
  await f.ack(message, true, 8);
  await f.context.acknowledge({ index: 0, fillToken: 'old-answer', ok: true }, 7);
  await wait(350);
  assert.equal(f.done().length, 0, '其他页面或旧答案回执解锁了当前填写');
  await f.ack(message, false);
  await wait(80);
  assert.equal(f.issues.length, 1);
  assert.equal(f.done().length, 0);
  assert.equal(f.answer().length, 1, '失败后自动重试了答案');
  console.log('PASS 忽略跨页和过期回执，填写失败只暂停一次');
}
{
  const f = fixture();
  await f.context.startRun([{ type: 'choice', _decision: 'ask' }], 7, 'https://mooc1.chaoxing.com/test');
  await wait(20);
  f.context.run.cancelled = true;
  await wait(100);
  assert.equal(f.done().length, 0);
  console.log('PASS 用户停止时结束回执等待，不报告完成');
}
{
  const f = fixture();
  let clock = 0;
  f.context.Date = { now: () => (clock += 31000) };
  await f.context.startRun([{ type: 'choice', _decision: 'ask' }], 7, 'https://mooc1.chaoxing.com/test');
  await wait(30);
  assert.equal(f.issues.length, 1);
  assert.match(f.issues[0], /回执超时/);
  assert.equal(f.answer().length, 1);
  assert.equal(f.done().length, 0);
  console.log('PASS 回执超时暂停并记录，不重发答案或假报完成');
}
{
  const f = fixture();
  f.context.cached = async () => null;
  f.context.askEngine = async (_, q) => {
    if (q.stem === '无法确认') throw Object.assign(Error('无法确定答案'), { code: 'HW_ANSWER_UNAVAILABLE', answerPreview: '原始答复' });
    return { answer: 'B' };
  };
  await f.context.startRun([{ type: 'choice', stem: '无法确认' }, { type: 'choice', stem: '后续题' }], 7, 'https://mooc1.chaoxing.com/test', true);
  await wait(30);
  assert.equal(f.answer().length, 1);
  assert.equal(f.answer()[0].payload.index, 1, '单题无法确认导致后续题被漏掉');
  assert.equal(f.issues.length, 0);
  assert.equal(f.messages.find(m => m.type === 'HW_STATUS' && m.payload.status === 'failed').payload.answerPreview, '原始答复');
  await f.ack(f.answer()[0]);
  await wait(450);
  assert.equal(f.done()[0].payload.failed, 1);
  assert.equal(f.done()[0].payload.filled, 1);
  assert.equal(f.answer().length, 1, '无法确认的题被自动猜选或重试');
  console.log('PASS 缺少有效选项时不虚构选项，无法确认只跳过本题，后续题继续');
}
for (const [type, candidate] of [['choice', null], ['multi', 'BD'], ['judge', null], ['blank', null]]) {
  const f = fixture();
  let cachedWrites = 0;
  f.context.cached = async () => null;
  f.context.cacheSet = async () => { cachedWrites++; };
  f.context.askEngine = async (_, q) => {
    if (q.stem === '兜底题') throw Object.assign(Error('无法确认'), { code:'HW_ANSWER_UNAVAILABLE', candidateAnswer:candidate, answerPreview:'初答与复核原文' });
    return { answer:'B' };
  };
  await f.context.startRun([{ type, stem:'兜底题', options:[{key:'B'},{key:'D'}], blanks:2, slotOptions:[['甲;乙','丙'],['丁','戊']] }, {type:'choice', stem:'后续题'}], 7, 'https://mooc1.chaoxing.com/test', true);
  await wait(30);
  const first = f.answer()[0];
  assert.equal(first.payload.index, 0);
  assert.equal(first.payload.fallback, true);
  if (type === 'blank') {
    const values=JSON.parse(first.payload.answer);
    assert.equal(values.length,2);
    assert.ok(['甲;乙','丙'].includes(values[0]) && ['丁','戊'].includes(values[1]));
  } else assert.ok(candidate ? first.payload.answer === candidate : (type === 'judge' ? ['对','错'] : ['B','D']).includes(first.payload.answer));
  assert.equal(cachedWrites, 0, '未确认答案被写入缓存');
  await f.ack(first); await wait(100);
  const next = f.answer()[1];
  assert.equal(next.payload.index, 1, '兜底后漏掉后续题');
  await f.ack(next); await wait(400);
  assert.equal(f.done()[0].payload.filled, 2);
  assert.equal(f.done()[0].payload.failed, 0);
  assert.equal(cachedWrites, 1, '仅正常答案可以缓存');
  assert.equal(f.issues.length, 0);
  console.log('PASS 刷课兜底填写、继续后续题且不缓存未确认答案：' + type);
}
{
  const f = fixture();
  f.context.cached = async () => null;
  f.context.askEngine = async () => { throw Object.assign(Error('复核冲突'), { code:'HW_ANSWER_UNAVAILABLE', candidateAnswer:'B' }); };
  await f.context.startRun([{type:'choice',options:[{key:'A'},{key:'B'}]}],7,'https://mooc1.chaoxing.com/test',false);
  await wait(30);
  assert.equal(f.answer().length,0);
  assert.equal(f.issues.length,1);
  console.log('PASS 人工解题模式不自动采用未确认答案或猜选');
}
{
  const f = fixture();
  await f.context.startRun([{ type: 'choice' }, { type: 'choice' }], 7, 'https://mooc1.chaoxing.com/test', true);
  await wait(20);
  await f.ack(f.answer()[0], false);
  await wait(400);
  assert.equal(f.answer().length, 2, '一题填写失败导致后续题未处理');
  await f.ack(f.answer()[1]);
  await wait(450);
  assert.equal(f.done()[0].payload.failed, 1);
  assert.equal(f.issues.length, 0);
  console.log('PASS 刷课填写失败只跳过本题，保留后续题和真实失败计数');
}
for (const auto of [false, true]) {
  const f = fixture();
  f.context.cached = async () => null;
  f.context.askEngine = async () => { throw Error('HTTP 401 invalid API key'); };
  await f.context.startRun([{ type: 'choice' }, { type: 'choice' }], 7, 'https://mooc1.chaoxing.com/test', auto);
  await wait(30);
  assert.equal(f.answer().length, 0);
  assert.equal(f.issues.length, 1);
  console.log('PASS 鉴权错误立即暂停，不猜答案或继续消耗请求：auto=' + auto);
}
{
  const f = fixture();
  let calls = 0;
  f.context.cached = async () => ({ answer: 'A', note: '复核不一致，采用初答继续' });
  f.context.askEngine = async () => { calls++; return { answer: 'B' }; };
  await f.context.startRun([{ type: 'choice' }], 7, 'https://mooc1.chaoxing.com/test', true);
  await wait(30);
  assert.equal(calls, 1);
  assert.equal(f.answer()[0].payload.answer, 'B');
  await f.ack(f.answer()[0]);
  await wait(400);
  console.log('PASS 旧版复核冲突缓存不再直接填写');
}
