import assert from 'node:assert/strict';
import { startBatchQueue } from '../background/engines/batch-queue.js';

const items = Array.from({ length: 12 }, (_, i) => ({ id: String(i), question: { type: 'choice' } }));
let active = 0, max = 0;
const calls = [];
const pending = [];
const request = batch => new Promise(resolve => {
  active++; max = Math.max(max, active); calls.push(batch.map(x => x.id));
  pending.push(() => { active--; resolve({ answers: new Map(batch.map(x => [x.id, 'A'])), raw: 'ok' }); });
});
const queue = startBatchQueue(items, request);
assert.deepEqual(calls.map(x => x.length), [5, 5]);
pending.shift()();
await new Promise(r => setImmediate(r));
assert.deepEqual(calls.map(x => x.length), [5, 5, 2], '12 题 3 批，每批只问一次');
pending.shift()();
await new Promise(r => setImmediate(r));
while (pending.length) { pending.shift()(); await new Promise(r => setImmediate(r)); }
for (const item of items) assert.equal((await queue.get(item.id)).answer, 'A');
assert.equal(max, 2, '并发批次数不能超过 2');

/* 单题只问一次，拿到的答案直接采用并标「单次作答」。 */
const once = startBatchQueue(items.slice(0, 1), async batch => ({ answers: new Map([[batch[0].id, 'A']]), raw: 'test' }));
const result = await once.get('0');
assert.equal(result.answer, 'A');
assert.equal(result.verified, true);
assert.match(result.note, /单次作答/);

let current = true;
let finish;
const cancelled = startBatchQueue(items.slice(0, 1), batch => new Promise(resolve => { finish = () => resolve({ answers: new Map([[batch[0].id, 'A']]) }); }), () => current);
current = false; finish();
assert.match((await cancelled.get('0')).error.message, /取消/);

let started = 0, release;
const stoppedQueue = startBatchQueue(items, batch => new Promise(resolve => {
  started++;
  release = () => resolve({ answers: new Map(batch.map(x => [x.id, 'A'])), raw: 'ok' });
}), () => true, 1);
stoppedQueue.stop();
release();
await new Promise(r => setImmediate(r));
await new Promise(r => setImmediate(r));
assert.equal(started, 1, 'stop 后不再发起后续批次');
/* 漏题补问：首答回缺一题，队列自动只补那一题（补答而不是重复问整批）。 */
{
  const sub = items.slice(0, 2);
  const calls = [];
  const q = startBatchQueue(sub, async batch => {
    calls.push(batch.map(x => x.id));
    if (calls.length === 1) return { answers: new Map([[batch[0].id, 'A']]), raw: '漏了 run:1' };
    return { answers: new Map([[batch[0].id, 'B']]), raw: '补答' };
  });
  const got = await q.get(sub[1].id);
  assert.equal(got.answer, 'B', '补问到的答案应被采用');
  assert.equal(got.verified, true);
  assert.deepEqual(calls.map(x => x.length), [2, 1], '首答 2 题 → 只补缺的 1 题，不再整批复核');
}
console.log('batch queue checks passed');
