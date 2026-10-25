import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(process.env.WATCH_SOURCE || new URL('../content/course/watch.js', import.meta.url), 'utf8');
const start = source.indexOf('  const cardReloaded = new Set();');
const end = source.indexOf('  /* 讨论任务点：', start);
assert.ok(start >= 0 && end > start);

const card = (text = '', readyState = 'complete') => ({
  readyState, URL: 'https://example.test/knowledge/cards',
  body: { innerText: text }, querySelector: () => null, querySelectorAll: () => [],
});
function fixture(update = () => {}) {
  let time = 0, reloads = 0, chapter = '100';
  const notes = [], writes = [];
  let doc = card();
  const frame = {
    get contentDocument() { return doc; },
    get src() { return 'https://example.test/knowledge/cards'; },
    set src(value) { writes.push(value); reloads++; },
  };
  const stop = new Error('stopped');
  const context = vm.createContext({
    document: { querySelector: () => frame }, on: true,
    activeChapterId: () => chapter, currentCourse: () => ({ key: 'course|class' }),
    note: (message) => notes.push(message), live() {},
    Date: { now: () => time },
    step: async (ms) => { time += ms; update({ time, reloads, setDoc: d => { doc = d; }, setChapter: c => { chapter = c; } }); if (!context.on) throw stop; },
  });
  vm.runInContext(source.slice(start, end), context);
  return { context, frame, notes, writes, stop,
    setDoc: d => { doc = d; },
    run: () => vm.runInContext('ensureCardRendered(0)', context),
    get time() { return time; },
  };
}

const checks = [
  ['已渲染卡片不重载', async () => {
    const f = fixture(); f.setDoc(card('正文'));
    assert.equal(await f.run(), true); assert.equal(f.writes.length, 0);
  }],
  ['文档未创建时等待正文，不误报已就绪', async () => {
    const f = fixture(({ time, setDoc }) => { if (time >= 2000) setDoc(card('正文')); });
    f.setDoc(null);
    assert.equal(await f.run(), true); assert.ok(f.time >= 2000); assert.equal(f.writes.length, 0);
  }],
  ['延迟渲染不被提前重载', async () => {
    const f = fixture(({ time, setDoc }) => { if (time >= 3000) setDoc(card('正文')); });
    assert.equal(await f.run(), true); assert.equal(f.writes.length, 0);
  }],
  ['加载中的非空文档仍需等待', async () => {
    const f = fixture(({ time, setDoc }) => { if (time >= 2000) setDoc(card('正文')); });
    f.setDoc(card('加载中', 'loading'));
    assert.equal(await f.run(), true); assert.ok(f.time >= 2000);
  }],
  ['about:blank 不当作有效卡片', async () => {
    const f = fixture(({ time, setDoc }) => { if (time >= 2000) setDoc(card('正文')); });
    f.setDoc({ ...card('占位'), URL: 'about:blank' });
    assert.equal(await f.run(), true); assert.ok(f.time >= 2000);
  }],
  ['确实为空才重载原地址一次', async () => {
    const f = fixture(({ reloads, setDoc }) => { if (reloads) setDoc(card('正文')); });
    assert.equal(await f.run(), true); assert.ok(f.time >= 12000);
    assert.deepEqual(f.writes, [f.frame.src]);
  }],
  ['持续空白不无限重载，并报告诊断', async () => {
    const f = fixture();
    assert.equal(await f.run(), false);
    const elapsed = f.time;
    assert.equal(await f.run(), false);
    assert.equal(f.time, elapsed, '已经恢复失败的空壳又重新等待一轮');
    assert.deepEqual(f.writes, [f.frame.src]);
    assert.ok(f.notes.some(n => /complete/.test(n)));
  }],
  ['曾失败的卡片后来已就绪时仍正常处理', async () => {
    const f = fixture();
    assert.equal(await f.run(), false);
    f.setDoc(card('迟到的正文'));
    assert.equal(await f.run(), true);
    assert.equal(f.writes.length, 1);
  }],
  ['重新加载的新文档仍等待正文，不沿用旧文档失败状态', async () => {
    let readyAt = Infinity;
    const f = fixture(({ time, setDoc }) => { if (time >= readyAt) setDoc(card('新文档正文')); });
    assert.equal(await f.run(), false);
    f.setDoc(card('加载中', 'loading'));
    readyAt = f.time + 2000;
    assert.equal(await f.run(), true);
    assert.ok(f.time >= readyAt);
    assert.equal(f.writes.length, 1);
  }],
  ['重载后停止不留下 about:blank，停止信号传出', async () => {
    const f = fixture(({ reloads }) => { if (reloads) f.context.on = false; });
    await assert.rejects(f.run(), e => e === f.stop);
    assert.deepEqual(f.writes, [f.frame.src]);
  }],
  ['换章后不重载新章节的卡片', async () => {
    const f = fixture(({ setChapter }) => setChapter('200'));
    assert.equal(await f.run(), false); assert.equal(f.writes.length, 0);
  }],
];
let failures = 0;
for (const [name, check] of checks) {
  try { await check(); console.log('PASS', name); }
  catch (e) { failures++; console.error('FAIL', name, e.message); }
}
if (failures) process.exitCode = 1;
