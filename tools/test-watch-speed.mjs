import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(process.env.WATCH_SOURCE || new URL('../content/course/watch.js', import.meta.url), 'utf8');
const goto = source.slice(source.indexOf('  async function goto('), source.indexOf('  function quizDocument('));
const constants = ['TAB_WAIT', 'TAB_GAP'].map(name => source.match(new RegExp('const ' + name + ' = \\d+;'))[0]).join('\n');

function fixture({ readyAfter = 0, wrongChapter = false, stopAt = Infinity, verificationAt = Infinity } = {}) {
  let now = 1000, clickedAt = null, clicks = 0;
  const notes = [], STOP = { stop: true };
  const requested = 'https://mooc1.chaoxing.com/knowledge/cards?knowledgeid=101&num=1';
  const card = { body: {}, readyState: 'complete', URL: requested.replace('num=1', 'num=0') };
  const frame = { src: requested, contentDocument: card, hasAttribute: () => false, getAttribute: () => requested };
  const li = { textContent: '测验', click: () => { clicks++; clickedAt ??= now; card.readyState = 'loading'; } };
  const context = vm.createContext({
    URL, Math, Date: { now: () => now }, on: true, location: { href: requested },
    tabList: () => [null, li], tabActive: () => false, activeChapterId: () => '101',
    jitter: ms => ms, note: text => notes.push(text), document: { querySelector: () => frame },
    step: async ms => {
      now += ms;
      if (now - 1000 >= stopAt) throw STOP;
      if (now - 1000 >= verificationAt) throw Object.assign(Error('需要人工验证'), { code: 'HW_VERIFICATION_REQUIRED' });
      if (clickedAt !== null && now - clickedAt >= readyAfter) {
        card.readyState = 'complete';
        card.URL = wrongChapter ? requested.replace('knowledgeid=101', 'knowledgeid=999') : requested;
      }
    },
  });
  vm.runInContext(constants + '\n' + goto, context);
  return { run: () => context.goto(1), elapsed: () => now - 1000, clicks: () => clicks, notes, STOP };
}

{
  const f = fixture();
  assert.equal(await f.run(), true);
  assert.ok(f.elapsed() <= 1000, '已加载页签仍有超过一秒的额外等待：' + f.elapsed());
  assert.equal(f.clicks(), 1);
  console.log('PASS 已就绪页签一秒内继续，点击不重复');
}
{
  const f = fixture({ readyAfter: 4200 });
  assert.equal(await f.run(), true);
  assert.ok(f.elapsed() >= 4200 && f.elapsed() < 5500, '慢页签提前通过或多等：' + f.elapsed());
  assert.equal(f.clicks(), 1);
  console.log('PASS 页面加载慢时继续等待实际就绪，保留题目完整性');
}
{
  const f = fixture({ wrongChapter: true });
  assert.equal(await f.run(), false);
  assert.ok(f.elapsed() >= 45000);
  assert.ok(f.notes.some(text => text.includes('不把它算作已处理')));
  assert.ok(f.clicks() <= 3, '加载失败时重复点击过多');
  console.log('PASS 旧章节内容不冒充新页签，保留加载超时与有限恢复');
}
{
  const f = fixture({ stopAt: 1 });
  await assert.rejects(f.run(), e => e === f.STOP);
  assert.equal(f.clicks(), 0);
  console.log('PASS 用户停止后不再点击页签');
}
{
  const f = fixture({ readyAfter: 4200, verificationAt: 1200 });
  await assert.rejects(f.run(), e => e.code === 'HW_VERIFICATION_REQUIRED');
  assert.equal(f.clicks(), 1);
  console.log('PASS 等待中出现验证立即交给人工，不继续连点');
}
