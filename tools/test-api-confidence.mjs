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
  for (const [type, values] of [
    ['choice', ['{"answers":[]}']],
    ['multi', ['{"answers":["甲","乙"]}', '{"answers":["甲"]}']],
    ['judge', ['{"answers":["正确"]}', '{"answers":["错误"]}']],
    ['multi', ['{"answers":["甲","乙"]}', '{"answers":[]}']],
  ]) {
    replies(values);
    await assert.rejects(answerWithAPI({ type, stem: '独立核对题目', options }, cfg), e => e.code === 'HW_ANSWER_UNAVAILABLE' && !!e.answerPreview && (type === 'choice' || !!e.candidateAnswer));
    assert.equal(calls, values.length, '无法确认时自动重试了模型');
    console.log('PASS 空答案或复核冲突明确不可确认，保留原始回执：' + type);
  }
  for (const failure of [401, 429, Error('network offline')]) {
    replies(['{"answers":["甲","乙"]}', failure]);
    await assert.rejects(answerWithAPI({ type: 'multi', stem: '网络或权限异常', options }, cfg), e => e.code !== 'HW_ANSWER_UNAVAILABLE');
    assert.equal(calls, 2);
    console.log('PASS 复核鉴权、限流或网络错误保留整轮暂停语义：' + failure);
  }
  replies(['{"answers":["甲","乙"]}', '{"answers":["甲","乙"]}']);
  const agreed = await answerWithAPI({ type: 'multi', stem: '一致的答案', options }, cfg);
  assert.equal(agreed.answer, 'AB'); assert.match(agreed.note, /已二次复核确认/); assert.equal(calls, 2);
  console.log('PASS 两次一致正常采用，保持原有二次复核');
  replies(['{"answers":["甲","乙"]}']);
  assert.equal((await answerWithAPI({ type: 'multi', stem: '用户关闭复核', options }, cfg, { verify2: false })).answer, 'AB');
  assert.equal(calls, 1);
  console.log('PASS 用户关闭复核时仍按其设置调用一次');
} finally { globalThis.fetch = originalFetch; globalThis.chrome = originalChrome; }
