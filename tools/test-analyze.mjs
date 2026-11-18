/* 单题解析：三种模式的提示词契约 + 后台 HW_ANALYZE 只取文本不填写。 */
import assert from 'node:assert';
import { buildAnalyzeMessages } from '../background/engines/engine.js';

const choice = { type: 'choice', stem: '下列哪个是质数？', options: [{ key: 'A', text: 'A. 4' }, { key: 'B', text: 'B. 7' }] };
const blank = { type: 'blank', stem: '水的化学式是 ____', blanks: 1 };
const multi = { type: 'multi', stem: '下列属于偶数的有', options: [{ key: 'A', text: '2' }, { key: 'B', text: '3' }, { key: 'C', text: '4' }] };

const userOf = (q, mode) => buildAnalyzeMessages(q, mode)[1].content;

// 1. 三种模式都存在且顺序不同
const ans = userOf(choice, 'answer');
const ana = userOf(choice, 'analysis');
const only = userOf(choice, 'analysisOnly');
assert.ok(ans.indexOf('【答案】') < ans.indexOf('【解析】'), 'answer 模式：答案在解析之前');
assert.ok(ana.indexOf('【解析】') < ana.indexOf('【答案】'), 'analysis 模式：解析在答案之前');
assert.ok(!only.includes('【答案】'), 'analysisOnly 模式不出现答案段');
assert.ok(only.includes('【解析】') && only.includes('不要给出最终答案'), 'analysisOnly 只讲解析');

// 2. 题干与选项进入提示词，选项字母前缀被剥掉
assert.ok(ans.includes('下列哪个是质数'), '题干进入提示词');
assert.ok(ans.includes('A. 4') && ans.includes('B. 7'), '选项进入提示词');

// 3. 各题型答案规则
assert.ok(userOf(choice, 'answer').includes('正确选项的完整文字'), '单选答案规则');
assert.ok(userOf(multi, 'answer').includes('全部正确选项'), '多选答案规则');
assert.ok(userOf(blank, 'answer').includes('写出要填的内容'), '填空答案规则');
assert.ok(userOf({ type: 'judge', stem: '地球是圆的' }, 'answer').includes('"正确"或"错误"'), '判断答案规则');

// 4. 未知模式退回默认（先答案后解析），不抛错
const fallback = userOf(choice, 'nonsense');
assert.ok(fallback.indexOf('【答案】') < fallback.indexOf('【解析】'), '未知模式退回先答案');

// 5. 提示词不含 Markdown 标记要求（避免模型输出 ** 之类）
assert.ok(ans.includes('不要 Markdown'), '明确禁止 Markdown');

// 6. 写作/简答题也能解析
const subj = userOf({ type: 'subjective', stem: '谈谈你的看法' }, 'answer');
assert.ok(subj.includes('谈谈你的看法') && subj.includes('可提交的答案正文'), '简答题解析可用');

// 7. meta 必须是结构化可克隆的（面板只传 {...q.meta}，DOM 引用跨消息会失败）
const meta = { index: 0, type: 'choice', stem: '测试', options: [{ key: 'A', text: '1' }], blanks: 0, writing: false };
assert.doesNotThrow(() => structuredClone(meta), 'meta 可结构化克隆');
assert.doesNotThrow(() => buildAnalyzeMessages(structuredClone(meta), 'answer'), '克隆后的 meta 可直接喂给提示词');

// 8. 三种模式都产出 system + user 两条消息
for (const m of ['answer', 'analysis', 'analysisOnly']) {
  const msgs = buildAnalyzeMessages(choice, m);
  assert.equal(msgs.length, 2, m + ' 应产出两条消息');
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].role, 'user');
}

console.log('test-analyze: 全部通过');
