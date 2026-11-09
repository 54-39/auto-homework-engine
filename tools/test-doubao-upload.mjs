import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../content/doubao/doubao-bridge.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('  async function attachImages('), source.indexOf('  async function askOne('));
const png = 'data:image/png;base64,iVBORw0KGgo=';
function fixture({ existing = false, preview = true, multiple = true, hasInput = true } = {}) {
  const previews = existing ? [{ complete: true, naturalWidth: 10, src: 'blob:old' }] : [];
  const input = { multiple, files: [], dispatchEvent() { if (preview) previews.push({ complete: true, naturalWidth: 10, src: 'blob:new' }); } };
  const zone = { querySelectorAll: () => (existing ? [{ src: 'blob:old' }] : []) };
  const editor = { closest: () => zone, parentElement: zone, focus() {}, dispatchEvent() {} };
  const document = {
    querySelectorAll: sel => (String(sel).includes('input[type="file"]') ? (hasInput ? [input] : []) : previews),
  };
  class DataTransfer { constructor() { this.files = []; this.items = { add: value => this.files.push(value) }; } }
  const ctx = vm.createContext({
    DataTransfer, File: class File { constructor(parts, name, options) { Object.assign(this, { parts, name, type: options.type }); } },
    Event: class Event {}, ClipboardEvent: class ClipboardEvent { constructor(type, init) { Object.assign(this, { type }, init); } },
    Uint8Array, atob, document, vis: () => true, waitUntil: async predicate => predicate(),
  });
  vm.runInContext(code, ctx);
  return { ctx, editor, input };
}
{
  const f = fixture();
  assert.equal(await f.ctx.attachImages(f.editor, [png]), true);
  assert.equal(f.input.files.length, 1);
  assert.equal(f.input.files[0].type, 'image/png');
}
{
  const f = fixture({ preview: false });
  assert.equal(await f.ctx.attachImages(f.editor, [png]), false, '控件和粘贴都没确认时不阻断整轮');
}
{
  const f = fixture({ existing: true });
  await assert.rejects(f.ctx.attachImages(f.editor, [png]), /已有附件/);
}
{
  const f = fixture({ multiple: false });
  assert.equal(await f.ctx.attachImages(f.editor, [png, png]), false, '多图但控件不支持时退回粘贴');
}
{
  const f = fixture({ hasInput: false });
  assert.equal(await f.ctx.attachImages(f.editor, [png]), false, '找不到 file input 时必须走粘贴兜底');
}
console.log('doubao image upload checks passed');
