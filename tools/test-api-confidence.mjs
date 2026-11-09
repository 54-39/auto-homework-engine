import assert from 'node:assert/strict';
import { answerWithAPI } from '../background/engines/api-engine.js';

const originalFetch = globalThis.fetch, originalChrome = globalThis.chrome;
const cfg = { iface: 'openai', baseURL: 'https://example.invalid/v1', model: 'fixture', apiKey: 'fixture-key' };
const options = [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }];
globalThis.chrome = { permissions: { contains: async () => true }, storage: { local: { get: async () => ({}), set: async () => {} } } };
let calls;
function replies(values) {
  calls = 0;
  globalThis.fetch = async () => {
    const value = values[calls++];
    if (value instanceof Error) throw value;
    if (typeof value === 'number') return { ok: false, status: value, text: async () => 'fixture error' };
    return { ok: true, json: async () => ({ choices: [{ message: { content: value } }] }) };
  };
}
try {
  /* 单次作答：空答案明确不可确认，只问一次。 */
  replies(['{"answers":[]}']);
  await assert.rejects(answerWithAPI({ type: 'choice', stem: '空答案', options }, cfg),
    e => e.code === 'HW_ANSWER_UNAVAILABLE' && !!e.answerPreview);
  assert.equal(calls, 1, '空答案不应重复请求模型');
  console.log('PASS 空答案明确不可确认，只问一次');
  /* 鉴权/限流/网络错误保留整轮暂停语义。 */
  for (const failure of [401, 429, Error('network offline')]) {
    replies([failure]);
    await assert.rejects(answerWithAPI({ type: 'multi', stem: '网络或权限异常', options }, cfg),
      e => e.code !== 'HW_ANSWER_UNAVAILABLE');
    assert.equal(calls, 1);
    console.log('PASS 鉴权、限流或网络错误保留整轮暂停语义：' + failure);
  }
  for (const thinking of [false, true]) {
    const bodies = [];
    globalThis.fetch = async (_, request) => {
      bodies.push(JSON.parse(request.body));
      return bodies.length === 1
        ? { ok: false, status: 400, text: async () => (thinking ? 'unsupported key: thinking' : 'invalid model') }
        : { ok: true, json: async () => ({ choices: [{ message: { content: '{"answers":["甲"]}' } }] }) };
    };
    const task = answerWithAPI({ type: 'choice', stem: '火山参数拒绝', options }, { ...cfg, baseURL: 'https://ark.cn-beijing.volces.com/api/v3' });
    if (thinking) { assert.equal((await task).answer, 'A'); assert.equal(bodies.length, 2); assert.ok(!bodies[1].thinking); }
    else { await assert.rejects(task, /invalid model/); assert.equal(bodies.length, 1); }
    console.log('PASS 火山仅对明确不支持thinking的400移除参数一次：' + thinking);
  }
  /* 单次作答直接采用，标记为可缓存。 */
  replies(['{"answers":["甲","乙"]}']);
  const single = await answerWithAPI({ type: 'multi', stem: '单次作答', options }, cfg);
  assert.equal(single.answer, 'AB');
  assert.equal(single.verified, true);
  assert.match(single.note, /单次作答/);
  assert.equal(calls, 1, '同一道题只问一次');
  console.log('PASS 单次作答直接采用并标记可缓存');
} finally { globalThis.fetch = originalFetch; globalThis.chrome = originalChrome; }
