import assert from 'node:assert/strict';
import { answerBatchWithBridge, requestWithBridge } from '../background/engines/bridge-engine.js';
const old = globalThis.chrome;
let sent;
globalThis.chrome = { tabs: {
  query: async () => [{ id: 20 }],
  sendMessage: async (_id, msg) => {
    if (msg.type === 'BRIDGE_PING') return { ok: true, ready: true };
    sent = msg.payload;
    return { ok: true, text: '{"results":[{"id":"q1","answers":["甲"]},{"id":"q2","answers":["对"]}]}' };
  },
} };
try {
  const items = [
    { id: 'q1', question: { type: 'choice', stem: '第一题', options: [{ key: 'A', text: '甲' }] } },
    { id: 'q2', question: { type: 'judge', stem: '第二题', options: [] }, images: ['data:image/png;base64,AA=='] },
  ];
  const answer = await answerBatchWithBridge(items);
  assert.equal(answer.answers.get('q1'), 'A');
  assert.equal(answer.answers.get('q2'), '对');
  assert.deepEqual(sent.images, ['data:image/png;base64,AA==']);
  assert.ok(sent.prompt.indexOf('题号 q2') < sent.prompt.indexOf('图片 1'));
  await assert.rejects(requestWithBridge([{ role: 'user', content: [{ type: 'bad' }] }]), /不支持/);
  assert.equal((await answerBatchWithBridge(items)).answers.get('q1'), 'A', '非法消息后必须释放桥接锁');
} finally { globalThis.chrome = old; }
console.log('bridge batch checks passed');
