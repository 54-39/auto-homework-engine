import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(new URL('../content/homework/question-images.js', import.meta.url), 'utf8'), context);
const HW = context.window.HW;
HW.AIDetection = { imageText: img => img.latex ? '$' + img.latex + '$' : '' };
const img1 = { src: 'https://example.test/1.png' }, img2 = { src: 'https://example.test/2.png' };
const area = imgs => ({ querySelectorAll: () => imgs });
const root = { matches: () => true, querySelectorAll: () => [area([img1]), area([img2, img1])] };
const q = { el: { stateInput: { closest: () => root } } };
const seen = [];
const images = await context.window.HW.QuestionImages.collect(q, async src => { seen.push(src); return 'data:image/png;base64,AA=='; });
assert.equal(images.length, 2);
assert.deepEqual(seen, [img1.src, img2.src]);
const embedded = { src: 'data:image/png;base64,AA==' };
const embeddedRoot = { matches: () => true, querySelectorAll: () => [area([embedded])] };
const embeddedResult = await context.window.HW.QuestionImages.collect({ el: { stateInput: { closest: () => embeddedRoot } } }, () => { throw Error('不应请求内嵌图片'); });
assert.equal(embeddedResult[0], embedded.src);
await assert.rejects(context.window.HW.QuestionImages.collect(q, async () => ''), /图片读取失败/);
await assert.rejects(context.window.HW.QuestionImages.collect({ el: {} }, async () => ''), /无法定位/);
const formula = { src: 'https://example.test/formula.png', latex: 'P(X=x_i)',
  matches: sel => sel.includes('ans-latex-moudle') };
const photo = { src: 'https://example.test/photo.png', matches: () => false };
/* 纯公式题：源码已还原成文字，不需要截图/上传。 */
const formulaRoot = { matches: () => true, querySelectorAll: () => [area([formula])] };
const formulaOnly = await HW.QuestionImages.collect({ el: { root: formulaRoot } },
  async () => { throw Error('公式图不应请求原图'); });
assert.equal(formulaOnly.length, 0, '公式图有可读源码时不发图片');
/* 公式 + 真实照片（材料在题块外）：只传读不出文字的那张。 */
const photoShared = { matches: () => false, querySelector: () => photo, querySelectorAll: () => [photo] };
const mixedSeen = [];
const mixedImages = await HW.QuestionImages.collect({ el: { root: formulaRoot, contexts: [photoShared] } },
  async src => { mixedSeen.push(src); return 'data:image/png;base64,AA=='; });
assert.equal(mixedImages.length, 1, '只上传读不出文字的真实图片');
assert.deepEqual(mixedSeen, [photo.src]);
/* 题块截图失败时直接报错，不再退回多张碎片图。 */
const badRoot = { matches: () => true, querySelectorAll: () => [area([img1])] };
await assert.rejects(HW.QuestionImages.collect({ el: { root: badRoot } }, async () => '',
  async () => 'data:image/png;base64,AA=='), /无法完整截图/);
console.log('question image collection checks passed');
