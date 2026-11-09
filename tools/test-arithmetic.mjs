import assert from 'node:assert/strict';
import { rational, checkCalculation } from '../background/engines/arithmetic.js';
import { parseBatchAnswers } from '../background/engines/batch.js';
assert.deepEqual(rational('2/20 + 3/20'), { n: 1n, d: 4n });
assert.deepEqual(rational('(0.3+0.4)*2'), { n: 7n, d: 5n });
assert.deepEqual(rational('$\\frac{1}{5}$'), { n: 1n, d: 5n });
assert.equal(rational('1/0'), null);
assert.equal(rational('process.exit()'), null);
assert.equal(rational('9'.repeat(200)), null);
assert.equal(checkCalculation('0.3+0.4=0.6', '0.6'), 'mismatch');
assert.equal(checkCalculation('2/20+3/20=1/4', '$\\frac{1}{5}$'), 'mismatch');
assert.equal(checkCalculation('2/20+3/20=1/4', '$\\frac{1}{4}$'), 'consistent');
assert.equal(checkCalculation('sqrt(2)=1.414', '1.414'), 'unsupported');
const items = [{ id: '19', question: { type: 'choice', stem: '概率', options: [{ key: 'C', text: '$\\frac{1}{5}$' }] } },
  { id: '10', question: { type: 'judge', stem: '判断', options: [] } }];
const result = parseBatchAnswers(items, JSON.stringify({ results: [
  { id: '19', answers: ['1/5'], calculation: '2/20+3/20=1/5' },
  { id: '10', answers: ['对'] },
] }));
assert.equal(result.get('19'), null);
assert.match(result.calculationErrors.get('19'), /不一致/);
assert.equal(result.get('10'), '对');
const multi = [{ id: '10', question: { type: 'multi', stem: '联合分布', options: [{ key: 'A', text: '真' }, { key: 'D', text: 'P(Y=1)=0.6' }] } }];
const wrongSum = parseBatchAnswers(multi, JSON.stringify({ results: [{ id: '10', answers: ['A', 'D'], calculation: '0.3+0.4=0.6' }] }));
assert.equal(wrongSum.get('10'), null);
assert.ok(wrongSum.calculationErrors.has('10'));
console.log('restricted arithmetic checks passed');
