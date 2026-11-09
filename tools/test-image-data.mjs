import assert from 'node:assert/strict';
import { readQuestionImage } from '../background/engines/image-data.js';
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let called = 0;
const fetcher = async (url, opts) => {
  called++;
  assert.equal(url, 'https://p.ananas.chaoxing.com/a.png');
  assert.equal(opts.credentials, 'omit');
  assert.equal(opts.redirect, 'error');
  return new Response(png, { headers: { 'content-type': 'image/png' } });
};
assert.equal(await readQuestionImage('https://p.ananas.chaoxing.com/a.png', fetcher), 'data:image/png;base64,iVBORw0KGgo=');
for (const src of ['https://chaoxing.com.evil.test/a', 'http://p.ananas.chaoxing.com/a', 'https://u:p@chaoxing.com/a', 'http://127.0.0.1/a']) {
  await assert.rejects(readQuestionImage(src, fetcher), /域名/);
}
assert.equal(called, 1);
await assert.rejects(readQuestionImage('https://chaoxing.com/a', async () => new Response('not image')), /格式/);
await assert.rejects(readQuestionImage('https://chaoxing.com/a', async () => new Response(png, { headers: { 'content-length': '5000000' } })), /过大/);
console.log('question image fetch checks passed');
