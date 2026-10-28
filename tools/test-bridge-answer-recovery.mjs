import assert from 'node:assert/strict';
import { answerWithBridge } from '../background/engines/bridge-engine.js';

const q = { type: 'choice', stem: '7. (单选题) 设随机变量 $X$ 服从泊松分布 $P(\\lambda)$，且 $P(X = 1) = 0.2$，则 $\\lambda$ 的值为：',
  options: ['1.5', '2', '2.5', '3'].map((text, i) => ({ key: 'ABCD'[i], text })) };
function fixture(responses) {
  const prompts = [];
  globalThis.chrome = { tabs: {
    query: async () => [{ id: 20 }],
    sendMessage: async (id, msg) => {
      assert.equal(id, 20);
      if (msg.type === 'BRIDGE_PING') return { ok: true, ready: true };
      assert.equal(msg.type, 'BRIDGE_ASK');
      prompts.push(msg.payload.prompt);
      assert.ok(responses.length, '发生了额外重试');
      return responses.shift();
    },
  } };
  return prompts;
}
const response = answers => ({ ok: true, text: JSON.stringify({ answers }) });
{
  const prompts = fixture([response([]), response(['2.5'])]);
  assert.equal((await answerWithBridge(q)).answer, 'C');
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].includes(q.stem) && prompts[1].includes('D. 3'));
  assert.match(prompts[1], /近似/);
  assert.ok(!prompts[1].includes('无法确定答案时输出'), '复核提示仍强制要求空数组');
  assert.match(prompts[1], /逐项代入/);
  assert.match(prompts[1], /不能输出空数组|不要再次输出空数组/);
  console.log('PASS 首轮空数组自动复核完整题目，返回有效选项 C');
}
{
  const prompts = fixture([response(['2.5'])]);
  assert.equal((await answerWithBridge(q)).answer, 'C');
  assert.equal(prompts.length, 1);
  console.log('PASS 首轮有效答案直接采用，不增加等待或重复请求');
}
{
  const prompts = fixture([response([]), response([])]);
  await assert.rejects(answerWithBridge(q), error => {
    assert.equal(error.code, 'HW_ANSWER_UNAVAILABLE');
    assert.equal(error.answerPreview, '{"answers":[]}');
    return /AI 答案为空/.test(error.message);
  });
  assert.equal(prompts.length, 2);
  console.log('PASS 复核仍无答案时向队列返回明确的内容错误及原始回复，不无限重试');
}
{
  const prompts = fixture([{ ok: false, error: '豆包需要安全验证' }]);
  await assert.rejects(answerWithBridge(q), /安全验证/);
  assert.equal(prompts.length, 1);
  console.log('PASS 真实安全验证立即暂停，不当成答案为空重复发题');
}
{
  const prompts = fixture([response([]), { ok: false, error: '豆包对话已切换' }]);
  await assert.rejects(answerWithBridge(q), /对话已切换/);
  assert.equal(prompts.length, 2);
  console.log('PASS 复核中切换对话仍暂停，不继续第三次请求');
}
{
  const prompts = fixture([{ ok: true, text: '按要求完成的正文。' }]);
  assert.equal((await answerWithBridge({ type: 'subjective', stem: '解释交换机地址学习' })).answer, '按要求完成的正文。');
  assert.equal(prompts.length, 1);
  console.log('PASS 简答正文保留原流程');
}
