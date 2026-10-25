import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync(process.env.PANEL_SOURCE || new URL('../content/homework/panel.js', import.meta.url), 'utf8');
const start = source.indexOf('    if (window.top === window) setInterval(async () => {');
const end = source.indexOf('    }, 30000);', start) + '    }, 30000);'.length;
function fixture({ targetRun = 0, ids, counts = { 1: 2, 2: 1 }, paused = false, currentKey = 'course' } = {}) {
  let tick, resumed = 0, now = 1000;
  const messages = [], notes = [];
  const q = { targetRun, paused, index: 0, courses: [{ key: 'course', chapterIds: ids }] };
  const win = {}; win.top = win;
  const context = vm.createContext({
    window: win, userStopped: false, reviveCount: 0, reviveMark: '', reviveAt: 0,
    Date: { now: () => now }, setInterval: fn => { tick = fn; },
    send: async type => { messages.push(type); return { ok: true, queue: q }; },
    log: text => notes.push(text), setWatchLine() {}, watchNote() {}, watchStopped() {}, refreshQueueInfo: async () => {},
    HW: { Watch: {
      running: false, pageKind: () => 'study', currentCourse: () => ({ key: currentKey }),
      nodes: () => Object.keys(counts).map(id => ({ id })), unfinishedOf: id => counts[id], activeChapterId: () => '1',
      observeProgress: async () => {}, resumeQueued: async () => { if (!q.paused) resumed++; },
    } },
  });
  vm.runInContext(source.slice(start, end), context);
  return { context, q, messages, notes, tick: () => tick(), resumed: () => resumed, advance: ms => { now += ms; } };
}
{
  const f = fixture(); await f.tick();
  assert.equal(f.resumed(), 1, '整门课程没有 chapterIds 时无法接续');
  assert.ok(!f.messages.includes('HW_WATCH_RESUME'), '自动恢复不能调用清除暂停的消息');
  await f.tick(); assert.equal(f.resumed(), 1, '退避期间重复启动');
  f.advance(120000); await f.tick(); assert.equal(f.resumed(), 2);
  console.log('PASS 整门课循环中断可接续，并保留退避限制');
}
for (const value of [null, undefined]) {
  const f = fixture({ counts: { 1: value } }); await f.tick(); assert.equal(f.resumed(), 1);
  console.log('PASS 任务计数未知时接续核验，不误当已完成：' + value);
}
{
  const f = fixture({ counts: { 1: 0, 2: 0 } }); await f.tick(); assert.equal(f.resumed(), 0);
  assert.ok(f.messages.includes('HW_WATCH_REOPEN'),'本页已完成但队列未结束时没有返回目录核验');
  await f.tick();assert.equal(f.messages.filter(type=>type==='HW_WATCH_REOPEN').length,1);
  console.log('PASS 本页任务归零不重刷，队列仍在时有退避地重开目录核验');
}
{
  const f=fixture({counts:{1:0}});
  for(let i=0;i<10;i++){await f.tick();f.advance(1200000);}
  assert.equal(f.messages.filter(type=>type==='HW_WATCH_REOPEN').length,5);
  console.log('PASS 课程切换连续失败最多恢复五次，不无限重开');
}
{
  const f = fixture({ targetRun: 1, ids: ['1'], counts: { 1: 0, 2: 2 } }); await f.tick(); assert.equal(f.resumed(), 0);
  assert.ok(f.messages.includes('HW_WATCH_REOPEN'));
  console.log('PASS 限定小节完成后只返回目录核验，不擅自扩展章节');
}
{
  const f = fixture({ targetRun: 1 }); await f.tick(); assert.equal(f.resumed(), 0);
  console.log('PASS 限定范围未加载时不擅自刷整门课');
}
for (const stopped of [false, true]) {
  const f = fixture({ paused: !stopped }); f.context.userStopped = stopped;
  await f.tick(); assert.equal(f.resumed(), 0);
  console.log('PASS 人工停止或队列暂停保持停止：' + stopped);
}
{
  const f = fixture();
  f.context.HW.Watch.observeProgress = async () => { f.q.paused = '需要人工验证'; };
  await f.tick(); assert.equal(f.resumed(), 0); assert.equal(f.q.paused, '需要人工验证');
  assert.ok(!f.messages.includes('HW_WATCH_RESUME'));
  console.log('PASS 检查期间新出现的验证暂停不会被自动接续清除');
}
{
  const f = fixture({ currentKey: 'previous-course' }); await f.tick(); assert.equal(f.resumed(), 0);
  assert.ok(f.messages.includes('HW_WATCH_REOPEN'));
  console.log('PASS 队列已换课但旧页面未离开时重开队列课程，不恢复旧课程');
}
