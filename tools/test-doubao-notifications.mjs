import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../background/service-worker.js', import.meta.url), 'utf8');
const start = source.indexOf('const RISKY_RE');
const block = source.slice(start, source.indexOf('\n/*', start));
const notifications = [], opened = [], focused = [];
let click, tabs = [];
const context = vm.createContext({ Date,
  chrome: { runtime: {}, notifications: {
    create: (id, options, callback) => { notifications.push({ id, ...options }); callback(); },
    onClicked: { addListener: fn => { click = fn; } },
  }, tabs: {
    query: async () => tabs,
    create: async spec => { opened.push(spec); tabs = [{ id: 7, windowId: 2 }]; return tabs[0]; },
    update: async id => { focused.push(id); return tabs[0]; },
  }, windows: { update: async () => {} } },
});
vm.runInContext(block, context);
assert.equal(vm.runInContext('RISKY_RE.test("豆包发送按钮不可用，请检查页面或稍后重试")',context),false);
assert.equal(vm.runInContext('RISKY_RE.test("豆包新对话未就绪，请检查豆包页面后重试")',context),false);
assert.equal(vm.runInContext('RISKY_RE.test("豆包需要安全验证")',context),true);
assert.equal(vm.runInContext('RISKY_RE.test("豆包需要登录")',context),true);
console.log('PASS 普通页面故障不再误归类风控，真实登录和安全验证仍识别');
context.notify('普通状态');
context.notify('豆包需要登录，请点击处理', true);
assert.equal(notifications.length, 2, '登录通知被普通状态通知的间隔限制挡住');
assert.equal(notifications[1].id, 'hw-doubao-attention');
assert.equal(opened.length, 0, '仅提示异常就自动打开了网页');
console.log('PASS 需处理登录或验证时可靠通知，正常状态不触发开页');
await click('hw-status');
assert.equal(opened.length, 0);
await click('hw-doubao-attention');
assert.equal(opened.length, 1);
assert.equal(opened[0].url, 'https://www.doubao.com/chat/');
console.log('PASS 只有用户点击豆包处理通知才打开登录页');
await click('hw-doubao-attention');
assert.equal(opened.length, 1);
assert.deepEqual(focused, [7]);
console.log('PASS 重复点击复用已打开登录页，不重复开页');
