import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = fs.readFileSync(process.env.PANEL_SOURCE || new URL('../content/homework/panel.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('    async function runHomework('), source.indexOf('    HW.Panel.runHomework ='));
function fixture({ count = 20, advance = true, pause = false } = {}) {
  let now = 0, ticks = 0;
  const messages = [], quiz = {}, questions = Array.from({ length: count }, (_, i) => ({ meta: { stem: '题' + i }, _status: 'queued' }));
  const els = { detect: { disabled: true }, stop: { disabled: false }, list: { querySelectorAll: () => [], querySelector: () => null } };
  const context = vm.createContext({
    HW: { questions, Watch: { quizDocument: () => quiz }, FontDecoder: { prepare: async () => {} } }, document: {}, els,
    autoRun: false, autoDocument: null, stopRequested: false, answerPauseReason: '',
    Date: { now: () => now }, readPageQuestions: () => true, startAnswering: async () => true,
    stopWatching() {}, log() {}, reportIssue() {}, send: async type => messages.push(type),
    setBusy: () => { els.detect.disabled = false; els.stop.disabled = true; },
    setTimeout: fn => {
      now += 30000;
      if (advance && ticks < count) questions[ticks]._status = 'filled';
      ticks++;
      if (advance && ticks >= count || pause) {
        els.detect.disabled = false; els.stop.disabled = true;
        if (pause) context.answerPauseReason = '需要手动验证';
      }
      fn();
    },
  });
  vm.runInContext(code, context);
  return { run: opts => context.runHomework(opts), messages, questions, time: () => now, context };
}
{
  const f = fixture();
  assert.equal(await f.run({ timeout: 240000 }), '填了 20 题');
  assert.ok(f.time() > 180000 && f.questions.every(q => q._status === 'filled'));
  assert.ok(!f.messages.includes('HW_STOP'), '有进展的长卷被提前停止');
  console.log('PASS 长测验持续有逐题进展时超过三分钟仍填完整卷');
}
{
  const f = fixture({ advance: false });
  await assert.rejects(f.run({ timeout: 120000 }), /无进展|超时/);
  assert.ok(f.time() <= 180000, '没有采用调用方指定的无进展超时');
  assert.equal(f.messages.filter(type => type === 'HW_STOP').length, 1);
  assert.equal(f.context.autoRun, false);
  console.log('PASS 无进展按指定期限停止并清理，不无限等或宣称填完');
}
{
  const f = fixture({ pause: true });
  await assert.rejects(f.run({ timeout: 240000 }), /需要手动验证/);
  assert.equal(f.context.autoRun, false);
  console.log('PASS 验证暂停不因延长等待而被忽略');
}
{
  const f = fixture({ count: 1 }), current = f.context.HW.Watch.quizDocument;
  let reads = 0;
  f.context.HW.Watch.quizDocument = () => ++reads >= 3 ? {} : current();
  await assert.rejects(f.run({ timeout: 240000 }), /测验页面已切换/);
  assert.equal(f.questions[0]._status, 'filled');
  assert.equal(f.context.autoRun, false);
  console.log('PASS 最后一题完成同时换页时，不把旧卷完成结果用于新卷提交');
}
