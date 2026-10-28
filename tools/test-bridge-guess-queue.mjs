import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const sw = fs.readFileSync(new URL('../background/service-worker.js', import.meta.url), 'utf8');
const code = sw.slice(sw.indexOf('function cacheKeyOf(q)'), sw.indexOf('async function rerunOne('));
const q = { type: 'choice', stem: '泊松分布参数', options: ['1.5', '2', '2.5', '3'].map((text, i) => ({ key: 'ABCD'[i], text })) };
async function runCase({ engine = 'bridge', auto = false, error, question = q }) {
  const sent = [], cached = [], issues = [], asked = [];
  const math = Object.create(Math); math.random = () => .5;
  let ctx;
  ctx = vm.createContext({ run: null, crypto: webcrypto, Math: math, setTimeout,
    getConfig: async () => ({ engine, bridge: { delayMin: 0, delayMax: 0 } }),
    openBridgeView: async () => ({}), hashKey: async text => text,
    chrome: { storage: { local: { get: async () => ({}), set: async value => cached.push(value) } } },
    askEngine: async (config, item) => { asked.push(item); if (asked.length === 1) throw error; return { answer: 'A' }; },
    sendTab: (id, message) => { sent.push(message); if (message.type === 'HW_ANSWER') ctx.run.items[message.payload.index].status = 'filled'; },
    recordIssue: async entry => issues.push(entry), notify: () => {},
    RISKY_RE: /风控|安全验证|验证码|需要登录/, AUTH_RE: /HTTP 40[13]/,
    pauseRun: async (id, reason) => { ctx.run.cancelled = true; sent.push({ type: 'HW_DONE', payload: { paused: reason } }); },
  });
  vm.runInContext(code, ctx);
  await ctx.startRun([question, { ...q, stem: '下一题' }], 7, 'https://mooc1-api.chaoxing.com/work', auto, 'round');
  for (let i = 0; i < 100 && !sent.some(m => m.type === 'HW_DONE'); i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(sent.some(m => m.type === 'HW_DONE'), '队列未结束');
  return { sent, cached, issues, asked };
}
const unavailable = () => Object.assign(new Error('AI 答案为空（已复核一次）'), { code: 'HW_ANSWER_UNAVAILABLE', answerPreview: '{"answers":[]}' });
{
  const r = await runCase({ error: unavailable() });
  const fills = r.sent.filter(m => m.type === 'HW_ANSWER');
  assert.equal(fills.length, 2); assert.equal(r.asked.length, 2);
  assert.ok(q.options.some(option => option.key === fills[0].payload.answer));
  assert.equal(fills[0].payload.fallback, true); assert.match(fills[0].payload.note, /猜选/);
  assert.equal(r.cached.length, 1, '猜选被写入了可信缓存');
  assert.ok(Object.keys(r.cached[0])[0].includes('下一题'));
  assert.equal(r.sent.at(-1).payload.paused, undefined);
  assert.equal(r.sent.at(-1).payload.filled, 2);
  assert.deepEqual(Array.from(r.sent.at(-1).payload.guessedIndexes), [0]);
  assert.equal(r.issues[0].answer, fills[0].payload.answer);
  assert.match(r.issues[0].details, /answers/);
  console.log('PASS 豆包空答后只在有效选项中猜选，明确标记、保留原因、不缓存且继续下一题');
}
for (const message of ['豆包需要安全验证', '豆包需要登录', '豆包对话已切换']) {
  const r = await runCase({ error: Object.assign(unavailable(), { message, code: undefined }) });
  assert.equal(r.sent.filter(m => m.type === 'HW_ANSWER').length, 0);
  assert.equal(r.asked.length, 1); assert.ok(r.sent.at(-1).payload.paused);
  console.log('PASS ' + message + '不猜选、不继续发题');
}
{
  const r = await runCase({ engine: 'api', error: unavailable() });
  assert.equal(r.sent.filter(m => m.type === 'HW_ANSWER').length, 0);
  assert.ok(r.sent.at(-1).payload.paused);
  console.log('PASS 不擅自扩展 API 手动解题的猜选策略');
}
{
  const r = await runCase({ error: unavailable(), question: { type: 'blank', stem: '没有可选项的填空', blanks: 1 } });
  assert.equal(r.sent.filter(m => m.type === 'HW_ANSWER').length, 1);
  assert.equal(r.sent.at(-1).payload.failed, 1);
  console.log('PASS 没有有效选项不编造文本，保留失败并继续下一题');
}
