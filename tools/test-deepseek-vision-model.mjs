import assert from 'node:assert/strict';
import { answerBatchWithAPI } from '../background/engines/api-engine.js';
const originalFetch = globalThis.fetch, originalChrome = globalThis.chrome;
const items = [{ id: 'q1', question: { type: 'choice', stem: '选择', options: [{ key: 'A', text: '甲' }] } }];
const stored = { apiEndpoint: { keyTail: '-key', iface: 'openai', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-flash' } };
const requests = [];
globalThis.chrome = { storage: { local: { get: async () => stored, set: async value => Object.assign(stored, value) } } };
globalThis.fetch = async (_url, init) => {
  requests.push(JSON.parse(init.body));
  return { ok: true, json: async () => ({ choices: [{ message: { content: '{"results":[{"id":"q1","answers":["甲"]}]}', reasoning_content: '先求和再归一化' } }] }) };
};
try {
  const auto = await answerBatchWithAPI(items, { iface: 'auto', apiKey: 'test-key' });
  assert.equal(auto.answers.get('q1'), 'A');
  assert.equal(auto.reasoning, '先求和再归一化', '推理模型的思考过程要带回给面板');
  assert.equal(requests[0].model, 'deepseek-flash', '自动匹配默认用 flash');
  assert.equal(stored.apiEndpoint.model, 'deepseek-flash', '已记住的模型保持不变');
  await answerBatchWithAPI(items, { iface: 'openai', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'test-key' });
  assert.equal(requests[1].model, 'deepseek-chat', '手动指定的模型不能被替换');
} finally { globalThis.fetch = originalFetch; globalThis.chrome = originalChrome; }
console.log('DeepSeek automatic vision model checks passed');
