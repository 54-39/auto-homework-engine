import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { captureQuestionImage } from '../background/engines/screenshot.js';

const old = { fetch: globalThis.fetch, createImageBitmap: globalThis.createImageBitmap, OffscreenCanvas: globalThis.OffscreenCanvas };
let draw, closed = false, captures = 0;
globalThis.fetch = async () => ({ blob: async () => new Blob(['screen']) });
globalThis.createImageBitmap = async () => ({ width: 200, height: 100, close: () => { closed = true; } });
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext() { return { drawImage: (...args) => { draw = args.slice(1); } }; }
  async convertToBlob() { return new Blob([Uint8Array.from([1, 2, 3])]); }
};
try {
  const sender = { tab: { id: 3, windowId: 7 }, url: 'https://mooc1.chaoxing.com/a' };
  const payload = { rect: { x: 10, y: 5, width: 20, height: 10 }, viewport: { width: 100, height: 50 } };
  const api = { tabs: { query: async () => [{ id: 3 }], captureVisibleTab: async () => { captures++; return 'data:image/png;base64,AA=='; } } };
  assert.equal(await captureQuestionImage(sender, payload, api), 'data:image/png;base64,AQID');
  assert.deepEqual(draw, [20, 10, 40, 20, 0, 0, 40, 20]);
  assert.ok(closed);
  await assert.rejects(captureQuestionImage(sender, { ...payload, rect: { ...payload.rect, x: -1 } }, api), /可见区域/);
  await assert.rejects(captureQuestionImage({ ...sender, url: 'https://evil.test/' }, payload, api), /无效/);
  await assert.rejects(captureQuestionImage(sender, payload, { tabs: { query: async () => [{ id: 4 }] } }), /不可见/);
  assert.equal(captures, 1);
} finally { Object.assign(globalThis, old); }

const ctx = vm.createContext({ window: {}, setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync(new URL('../content/homework/question-images.js', import.meta.url), 'utf8'), ctx);
let visibility = 'visible', scrolled = false;
const host = { style: { getPropertyValue: () => visibility, getPropertyPriority: () => '', setProperty: (_k, v) => { visibility = v; }, removeProperty: () => { visibility = ''; } } };
const doc = { visibilityState: 'visible', getElementById: () => host };
const win = { document: doc, scrollX: 0, scrollY: 0, innerWidth: 100, innerHeight: 50, scrollTo() {}, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }), requestAnimationFrame: cb => cb() };
win.window = win; win.top = win; doc.defaultView = win;
const img = { isConnected: true, ownerDocument: doc, parentElement: null, scrollIntoView: () => { scrolled = true; }, getBoundingClientRect: () => ({ left: 10, top: 5, width: 20, height: 10 }) };
const value = await ctx.window.HW.QuestionImages.screenshot(img, async ({ rect }) => { assert.equal(visibility, 'hidden'); assert.equal(rect.x, 10); return 'data:image/png;base64,AA=='; });
assert.equal(value, 'data:image/png;base64,AA=='); assert.ok(scrolled); assert.equal(visibility, 'visible');
img.src = 'https://example.invalid/question.png';
/* 共享材料图在题块外时走逐张；题块内图片才用整题截图。 */
const root = { matches: () => true, querySelectorAll: () => [] };
const shared = { matches: () => false, querySelector: () => img, querySelectorAll: () => [img] };
const fallback = await ctx.window.HW.QuestionImages.collect({ el: { root, contexts: [shared] } }, async () => { throw Error('无法读取原图'); }, async () => 'data:image/png;base64,AA==');
assert.equal(fallback[0], 'data:image/png;base64,AA==');
doc.visibilityState = 'hidden';
await assert.rejects(ctx.window.HW.QuestionImages.screenshot(img, async () => ''), /不可见/);
console.log('question screenshot checks passed');
