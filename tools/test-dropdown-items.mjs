/* dropdown 回归：空列表初始化不崩（曾让整个 wire() 中断，模式切换全失效）、
   setItems 能重建选项 DOM（只改数组会让列表显示旧项）。用最小 DOM stub 跑真实源码。 */
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';

/* —— 最小 DOM stub：只实现 dropdown.js 用到的接口 —— */
function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(), className: '', textContent: '', style: {}, dataset: {},
    children: [], _attrs: {}, _listeners: {},
    set id(v) { this._id = v; }, get id() { return this._id; },
    append(...kids) { kids.forEach((k) => { this.children.push(k); k.parentNode = this; }); },
    appendChild(k) { this.children.push(k); k.parentNode = this; return k; },
    replaceChildren(...kids) { this.children = []; kids.forEach((k) => this.appendChild(k)); },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k]; },
    removeAttribute(k) { delete this._attrs[k]; },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { const a = this._listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { const v = on === undefined ? !this._s.has(c) : !!on; v ? this._s.add(c) : this._s.delete(c); return v; },
      contains(c) { return this._s.has(c); },
    },
    getRootNode() { return this._root || doc; },
    focus() {}, getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }; },
    get offsetTop() { return 0; }, get offsetHeight() { return 24; },
  };
  el.classList._s = new Set();
  return el;
}
const doc = {
  head: makeEl('head'), body: makeEl('body'),
  createElement: (t) => makeEl(t),
  addEventListener() {}, removeEventListener() {},
  querySelector: () => null,
};
const win = { innerHeight: 800, innerWidth: 1200, addEventListener() {}, removeEventListener() {} };

const sandbox = { window: win, document: doc, console, setTimeout, clearTimeout };
sandbox.window.HW = {};
vm.createContext(sandbox);
const src = fs.readFileSync(new URL('../content/homework/dropdown.js', import.meta.url), 'utf8');
vm.runInContext(src, sandbox);
const DD = sandbox.window.HW.Dropdown;
assert.ok(DD, 'dropdown.js 应挂载 HW.Dropdown');

// 1. 空 items 初始化不抛（这就是把 wire() 打断的元凶）
const slot = makeEl('div');
slot._root = doc;
let dd;
assert.doesNotThrow(() => { dd = DD.create({ into: slot, items: [], value: '' }); }, '空列表初始化不应崩溃');
assert.equal(dd.value, '', '空列表 value 为空串');

// 2. setItems 后能取值、能选中
dd.setItems([{ id: '0', label: '1. 第一题' }, { id: '1', label: '2. 第二题' }]);
assert.equal(dd.value, '0', 'setItems 后落到第一项');
dd.value = '1';
assert.equal(dd.value, '1', '可选中第二项');
assert.equal(dd.label, '2. 第二题', 'label 跟随');

// 3. setItems 重建了选项 DOM（数量对，不是旧的空列表）
const popup = [...doc.body.children, ...slot.children].find((c) => String(c.className).includes('ddlist'));
assert.ok(popup, '弹层应挂在 root 内（slot 或 body）');
assert.equal(popup.children.length, 2, 'setItems 后选项 DOM 重建为 2 项');
assert.equal(popup.children[0].textContent, '1. 第一题', '选项文本正确');

// 4. 再次 setItems 换一批，DOM 也跟着换（不是追加）
dd.setItems([{ id: 'a', label: '新题 A' }]);
assert.equal(popup.children.length, 1, '重建而非追加');
assert.equal(popup.children[0].textContent, '新题 A', '内容更新');

// 5. setItems([]) 回到占位，不崩
assert.doesNotThrow(() => dd.setItems([]), '清空列表不应崩溃');
assert.equal(dd.value, '', '清空后 value 为空');

console.log('test-dropdown-items: 全部通过');
