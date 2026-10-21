/* JSON 契约（借鉴 ocs-deepseek-adapter）离线测试：不调任何 API，纯函数校验。
   覆盖：正常 JSON / 带 ```json 围栏 / answers 缺失或非数组 / 非文字元素 /
   choice 多值拒绝 / judge 非法措辞拒绝 / 选项文字反查字母 / 判断归一化 / 填空多空拼接。 */
import assert from 'node:assert';
import { buildMessages, parseAnswer } from '../background/engines/engine.js';

const qChoice = { type: 'choice', stem: '1+1=?', options: [{ key: 'A', text: 'A. 2' }, { key: 'B', text: 'B. 3' }, { key: 'C', text: 'C. 11' }] };
const qMulti = { type: 'multi', stem: '偶数有哪些？', options: [{ key: 'A', text: 'A. 2' }, { key: 'B', text: 'B. 3' }, { key: 'C', text: 'C. 4' }, { key: 'D', text: 'D. 5' }] };
const qJudge = { type: 'judge', stem: '1+1=2', options: [] };
const qBlank = { type: 'blank', stem: '____和____是偶数', blanks: 2, options: [] };
const selectPrompt = buildMessages({ type: 'blank', stem: '选择朝代并填作者', blanks: 2, slotOptions: [['宋代', '唐代'], []] });
assert.match(selectPrompt[1].content, /第 1 空是下拉选择/);
assert.match(selectPrompt[1].content, /宋代/);
assert.ok(!selectPrompt[1].content.includes('第 2 空是下拉选择'));

/* buildMessages 走 JSON 契约 */
for (const q of [qChoice, qMulti, qJudge, qBlank]) {
  const msgs = buildMessages(q);
  assert.ok(msgs[0].content.includes('{"answers"'), 'system 要说明 JSON 契约');
  assert.ok(msgs[1].content.includes('{"answers":[…]"}') || msgs[1].content.includes('{"answers":[…]}'), 'user 要下发格式');
}

/* choice */
assert.deepEqual(parseAnswer(qChoice, '{"answers":["2"]}'), 'A');
assert.deepEqual(parseAnswer(qChoice, '```json\n{"answers":["3"]}\n```'), 'B');
assert.throws(() => parseAnswer(qChoice, '{"answers":["2","3"]}'), /AI 答案/);
assert.equal(parseAnswer(qChoice, '瞎写的'), '', '不明确的答案不能猜选项');
/* 完整选项优先：同步通信不能同时命中半同步通信。 */
const qSync = { type: 'choice', stem: '发送方和接收方严格按照时钟节拍传输的是哪种通信方式？', options: [
  { key: 'A', text: 'A 异步通信' }, { key: 'B', text: 'B 同步通信' },
  { key: 'C', text: 'C 突发传送' }, { key: 'D', text: 'D 半同步通信' },
] };
assert.equal(parseAnswer(qSync, '{"answers":["同步通信"]}'), 'B');
assert.equal(parseAnswer(qSync, '{"answers":["半同步通信"]}'), 'D');
assert.equal(parseAnswer({ ...qSync, type: 'multi' }, '{"answers":["同步通信","半同步通信"]}'), 'BD');
assert.throws(() => parseAnswer(qSync, '{"answers":["步通信"]}'), /AI 答案/, '只有片段且命中多个选项仍应停止');
assert.throws(() => parseAnswer({ ...qSync, options: [qSync.options[1], { key: 'D', text: 'D 同步通信' }] }, '{"answers":["同步通信"]}'), /AI 答案/, '完全相同的多个选项不能猜');
/* multi：完整文字反查，顺序无关 */
assert.deepEqual(parseAnswer(qMulti, '{"answers":["4","2"]}'), 'AC');
assert.deepEqual(parseAnswer(qMulti, '{"answers":["2","4"]}'), 'AC', '保序但内部排序输出');
/* judge */
assert.deepEqual(parseAnswer(qJudge, '{"answers":["正确"]}'), '对');
assert.deepEqual(parseAnswer(qJudge, '{"answers":["错误"]}'), '错');
assert.throws(() => parseAnswer(qJudge, '{"answers":["maybe"]}'), /AI 答案/);
/* blank */
assert.deepEqual(parseAnswer(qBlank, '{"answers":["2","4"]}'), '2;4');
assert.equal(parseAnswer(qBlank, '{"answers":["C. rural scenery; rural landscape","B. local flavor"]}'), '["C. rural scenery; rural landscape","B. local flavor"]');
/* 模型无法确定、无效结构和文字不匹配必须停止，不能从 answers 中提取 A。 */
assert.throws(() => parseAnswer(qMulti, '{"answers":[]}'), /AI 答案/);
/* 非文字元素拒绝 */
assert.throws(() => parseAnswer(qChoice, '{"answers":[2]}'), /AI 答案/);
assert.throws(() => parseAnswer(qChoice, '{"answers":{}}'), /AI 答案/);
assert.throws(() => parseAnswer(qChoice, '{"answers":["王阳明"]}'), /AI 答案/);
assert.throws(() => parseAnswer(qMulti, '{"answers":["2","不存在"]}'), /AI 答案/);
assert.throws(() => parseAnswer(qBlank, '{"answers":["2"]}'), /AI 答案/);

console.log('JSON contract checks passed, including empty and unmappable answer rejection.');
