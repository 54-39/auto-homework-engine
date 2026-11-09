import assert from 'node:assert/strict';
import { buildBatchMessages, parseBatchAnswers } from '../background/engines/batch.js';
import { readableMath } from '../background/engines/engine.js';
import { answerBatchWithAPI, answerWithAPI } from '../background/engines/api-engine.js';

const items = [
  { id: 'run:1', question: { type: 'choice', stem: '第一题', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }] } },
  { id: 'run:2', question: { type: 'judge', stem: '第二题', options: [] }, images: ['data:image/png;base64,AA=='] },
];
const messages = buildBatchMessages(items);
assert.match(messages[1].content[2].text, /run:2/);
assert.equal(messages[1].content[3].type, 'image_url');
const result = parseBatchAnswers(items, JSON.stringify({ results: [{ id: 'run:2', answers: ['错误'] }, { id: 'run:1', answers: ['甲'] }] }));
assert.equal(result.get('run:1'), 'A');
assert.equal(result.get('run:2'), '错');
/* 模型漏题：results 少一题不再整批作废，缺的题记 null 由队列补问。 */
const short = parseBatchAnswers(items, JSON.stringify({ results: [{ id: 'run:1', answers: ['甲'] }] }));
assert.equal(short.get('run:1'), 'A');
assert.equal(short.get('run:2'), null);
assert.throws(() => parseBatchAnswers(items, JSON.stringify({ results: [{ id: 'run:1', answers: ['A'] }, { id: 'run:1', answers: ['B'] }] })), /题号/);
assert.throws(() => parseBatchAnswers(items, JSON.stringify({ results: [{ id: 'run:1', answers: ['H'] }, { id: 'run:2', answers: ['对'] }] })), /选项/);
/* 豆包实测：回复带搜索摘要前缀，答案带选项字母前缀，判断题写作 "T. 对" */
const noisy = '搜索 5 个关键词，参考 27 篇资料\n' + JSON.stringify({ results: [
  { id: 'run:1', answers: ['A. A 甲'] }, { id: 'run:2', answers: ['T. 对'] },
] });
const parsedNoisy = parseBatchAnswers(items, noisy);
assert.equal(parsedNoisy.get('run:1'), 'A');
assert.equal(parsedNoisy.get('run:2'), '对');
/* 单题答案文字对不上当前选项时只空这一题，不拖垮同批其他题。 */
const partial = parseBatchAnswers(items, JSON.stringify({ results: [
  { id: 'run:1', answers: ['题外文字'] }, { id: 'run:2', answers: ['对'] },
] }));
assert.equal(partial.get('run:1'), null);
assert.match(partial.calculationErrors.get('run:1'), /不匹配/);
assert.equal(partial.get('run:2'), '对');
/* 批量回复里含 LaTeX（\leq 非法转义）也能解析并匹配选项。 */
const eqItems = [{ id: 'q', question: { type: 'choice', stem: '分布函数', options: [{ key: 'A', text: '$P(X = 3)$' }, { key: 'B', text: '$P(X \\leq 3)$' }] } }];
assert.equal(parseBatchAnswers(eqItems, '{"results":[{"id":"q","answers":["B P(X \\leq 3)"]}]}').get('q'), 'B');
/* 提示词里不能出现重复字母前缀和 LaTeX 源码（用户反馈的「乱码」）。 */
const latexItems = [{ id: 'q', question: { type: 'choice', stem: '分布函数 $F(x)$ 在 $x=3$ 处的值', options: [
  { key: 'A', text: 'A $P(X=3)$' }, { key: 'B', text: 'B $P(X \\leq 3)$' },
] } }];
const latexMsg = buildBatchMessages(latexItems)[1].content[1].text;
assert.ok(!latexMsg.includes('$'), '提示词里不应出现 LaTeX 美元符号');
assert.ok(latexMsg.includes('A. P(X=3)'), '选项不应重复字母前缀');
assert.ok(latexMsg.includes('P(X ≤ 3)'), '公式应转成 Unicode');
assert.equal(readableMath('$P(X = x_i, Y = y_j) = p_{11}$'), 'P(X = xᵢ, Y = yⱼ) = p₁₁', '上下标转成 Unicode');
assert.throws(() => buildBatchMessages([...items, ...items]), /题号/);
const oldFetch = globalThis.fetch;
try {
  for (const iface of ['openai', 'anthropic']) {
    let sent;
    globalThis.fetch = async (_url, request) => {
      sent = JSON.parse(request.body);
      const text = JSON.stringify({ results: [{ id: 'run:1', answers: ['甲'] }, { id: 'run:2', answers: ['对'] }] });
      return { ok: true, json: async () => iface === 'openai' ? { choices: [{ message: { content: text } }] } : { content: [{ text }] } };
    };
    const response = await answerBatchWithAPI(items, { iface, baseURL: 'https://example.invalid/v1', model: 'fixture', apiKey: 'fixture-key' });
    assert.equal(response.answers.get('run:1'), 'A');
    const parts = sent.messages.find(m => m.role === 'user').content;
    assert.equal(parts[3].type, iface === 'openai' ? 'image_url' : 'image');
    globalThis.fetch = async (_url, request) => {
      sent = JSON.parse(request.body);
      const text = '这是图片中的说明。';
      return { ok: true, json: async () => iface === 'openai' ? { choices: [{ message: { content: text } }] } : { content: [{ text }] } };
    };
    await answerWithAPI({ type: 'subjective', stem: '解释图片', _images: ['data:image/png;base64,AA=='] }, { iface, baseURL: 'https://example.invalid/v1', model: 'fixture', apiKey: 'fixture-key' });
    assert.equal(sent.messages.find(m => m.role === 'user').content[1].type, iface === 'openai' ? 'image_url' : 'image');
  }
} finally { globalThis.fetch = oldFetch; }
console.log('batch contract checks passed');
