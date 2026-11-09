import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { startBatchQueue } from '../background/engines/batch-queue.js';

const source = fs.readFileSync(new URL('../background/service-worker.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('async function fillAnswer('), source.indexOf('async function rerunOne('));
const sent = [], requests = [], writes = [];
let active = 0, max = 0;
const ctx = vm.createContext({
  run: null, Date, crypto: { randomUUID }, startBatchQueue,
  setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
  getConfig: async () => ({ engine: 'api', api: {} }),
  cacheKeyOf: async q => q.stem, cached: async () => null,
  cacheSet: async (key, value) => writes.push({ key, value }),
  answerBatchWithAPI: async items => {
    active++; max = Math.max(max, active); requests.push(items.map(item => item.id));
    await new Promise(resolve => setTimeout(resolve, items[0].id === '0' ? 12 : 2));
    active--;
    return { answers: new Map(items.map(item => [item.id, Number(item.id) % 2 ? 'B' : 'A'])), raw: 'ok' };
  },
  askEngine: async () => { throw Error('unexpected individual request'); },
  AUTH_RE: /HTTP 40[13]/, RISKY_RE: /captcha/, notify() {},
  pauseRun: (_tab, reason) => { ctx.run.cancelled = true; throw Error(reason); },
  sendTab: (_tab, message, frameId) => {
    sent.push({ ...message, frameId });
    if (message.type === 'HW_ANSWER') ctx.run.items[message.payload.index].status = 'filled';
    return Promise.resolve();
  },
});
vm.runInContext(code, ctx);
const questions = Array.from({ length: 7 }, (_, i) => ({ type: 'choice', stem: `question-${i}`, options: [{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }] }));
assert.equal((await ctx.startRun(questions, 7, 'https://mooc1.chaoxing.com/test', false, 'test-run', 9)).ok, true);
for (let i = 0; i < 300 && !sent.some(m => m.type === 'HW_DONE'); i++) await new Promise(resolve => setTimeout(resolve, 5));
assert.ok(sent.some(m => m.type === 'HW_DONE'), '批量队列未完成');
assert.equal(max, 2);
assert.equal(requests.length, 2, '7 题 2 批，每批只问一次');
const filled = sent.filter(m => m.type === 'HW_ANSWER');
assert.equal(filled.length, 7);
for (const message of filled) { assert.equal(message.payload.answer, message.payload.index % 2 ? 'B' : 'A'); assert.equal(message.frameId, 9); }
assert.equal(writes.length, 7);
sent.length = 0; requests.length = 0;
ctx.cached = async () => ({ answer: 'B', verified: true });
await ctx.startRun([{ ...questions[0], _images: ['data:image/png;base64,AA=='] }], 7, 'https://mooc1.chaoxing.com/test', false, 'cached-run');
for (let i = 0; i < 100 && !sent.some(m => m.type === 'HW_DONE'); i++) await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(requests.length, 0, '已验证缓存不应启动批量请求');
assert.equal(sent.find(m => m.type === 'HW_ANSWER')?.payload.answer, 'B');
sent.length = 0; requests.length = 0;
ctx.cached = async () => ({ answer: 'B' });
await ctx.startRun([questions[0]], 7, 'https://mooc1.chaoxing.com/test', false, 'legacy-cache');
for (let i = 0; i < 100 && !sent.some(m => m.type === 'HW_DONE'); i++) await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(requests.length, 1, '旧缓存不能跳过单次作答');
assert.equal(sent.find(m => m.type === 'HW_ANSWER')?.payload.answer, 'A');
const ackStart = source.indexOf("} else if (type === 'HW_FILLED') {") + "} else if (type === 'HW_FILLED') {".length;
const ack = source.slice(ackStart, source.indexOf('} else if (type ===', ackStart));
vm.runInContext('async function acknowledge(payload, tabId, frameId) { const sender = { frameId }; const sendResponse = value => value; ' + ack + '\n}', ctx);
ctx.run = { tabId: 7, frameId: 9, cancelled: false, items: [{ status: 'answered', fillToken: 'x' }] };
await ctx.acknowledge({ index: 0, fillToken: 'x', ok: true }, 7, 10);
assert.equal(ctx.run.items[0].status, 'answered', '其他框架的回执不能完成本题');
await ctx.acknowledge({ index: 0, fillToken: 'x', ok: true }, 7, 9);
assert.equal(ctx.run.items[0].status, 'filled');
console.log('batch queue integration checks passed');
