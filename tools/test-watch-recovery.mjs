import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../content/course/watch.js', import.meta.url), 'utf8');
const estimate = source.slice(source.indexOf('  function estimateCourseSeconds('), source.indexOf('  function courseProgress('));
const timing = vm.createContext({});
vm.runInContext(estimate, timing);
const calc = (course, speed, data) => timing.estimateCourseSeconds(course, speed, data);
assert.equal(calc({ done: 0, total: 150 }, 2), null, '无样本不能凭空显示10小时');
assert.equal(calc({ done: 0, total: 150 }, 2, { jobs: 1, seconds: 72000 }), null, '旧版等待污染样本不能继续使用');
assert.equal(calc({ done: 0, total: 2 }, 2, { schema: 2, samples: [120, 120, 1800] }), 120, '少数慢任务不能抬高整课估算');
assert.equal(calc({ done: 0, total: 2 }, 1, { schema: 2, samples: [120, 120, 1800] }), 240);
assert.equal(calc({ done: 3, total: 3 }, 2), 0);
console.log('PASS 时间估算：无样本、旧污染数据、异常值、倍速与已完成');

const loop = source.slice(source.indexOf('  async function recordWatchSkip('), source.indexOf('  /* 停止后站点可能自己'));
function fixture(failure) {
  let active = '1', tab = 0;
  const chapters = [{ id: '1', name: '出错章' }, { id: '2', name: '后续章' }];
  const counts = { 1: 1, 2: 1 }, calls = [], messages = [], notes = [], reports = [];
  const STOP = Symbol('stop');
  const context = vm.createContext({
    on: true, gen: 1, scopeChapters: null, rate: 2, courseTiming: null, failedChapters: new Set(),
    multi: null, lastEnterAt: 0, CHAPTER_GAP: 0, NODE_WAIT: 1, STOP,
    Date, Set, Error, JSON, Number, String, Math,
    HW: { Diagnostics: { capture: () => ({ status: 'captured', documents: [{ html: '错误章节-' + active }] }) } },
    location: { href: 'https://mooc1.chaoxing.com/study?courseId=1' },
    checkVerification() {}, nodes: () => chapters, currentCourse: () => ({ key: 'course', name: '测试课程' }),
    courseTimeKey: () => 'watchTime:test', unfinishedOf: id => counts[id], activeChapterId: () => active,
    remainingJobs: () => counts[1] + counts[2], courseProgress: () => { if (failure === 'progress' && active === '1') throw Error('统计失败'); return { remainingJobs: counts[1] + counts[2] }; },
    estimateCourseSeconds: calc, fmtLeft: s => s === null ? '暂无法估算' : String(s),
    shortName: name => name, note: text => notes.push(text), live() {},
    pendingVideos: () => [], pageKind: () => 'study',
    tabList: () => [{ id: 'dct1', textContent: '测验一' }, { id: 'dct2', textContent: '测验二' }],
    tabActive: item => item.id === 'dct' + (tab + 1),
    dismissUnfinishedDialog: async () => false, jitter: n => n,
    dismissQuizRetryNotice: () => false,
    step: async () => {}, until: async predicate => predicate(),
    clickNode: id => { if (failure === 'entry' && id === '1') throw Error('目录点击异常'); active = id; return true; },
    goto: async index => { tab = index; calls.push(active + ':' + tab); return true; },
    ensureCardRendered: async () => true, classify: () => 'quiz', bbsCard: () => false, surveyCard: () => false,
    runQuiz: async () => {
      if (active === '1' && tab === 0 && failure !== 'success') {
        if (failure === 'stop') throw STOP;
        if (failure === 'captcha') throw Object.assign(Error('验证码'), { code: 'HW_VERIFICATION_REQUIRED' });
        throw Error('模型失败');
      }
      if (failure !== 'incomplete') counts[active] = 0;
    },
    stop: () => { context.on = false; }, limitedRun: () => false,
    reportCourseDone: async (key, details) => reports.push({ key, details }),
    chrome: {
      storage: { local: { get: async () => ({}), set: async () => {} } },
      runtime: { sendMessage: async message => { messages.push(message); return { ok: true }; } },
    },
  });
  if (failure === 'entry') active = '0';
  if (failure === 'incomplete') context.multi = { index: 0, courses: [{ key: 'course', name: '测试课程' }] };
  vm.runInContext(loop, context);
  return { context, STOP, calls, messages, reports, notes, run: () => context.courseLoop() };
}
const success = fixture('success');
await success.run();
assert.equal(success.notes.length, 1, '正常遍历仅记录整门课程完成，不逐章刷日志');
assert.match(success.notes[0], /测试课程.*已走完一遍/);
console.log('PASS 正常课程只记录一次课程完成，并带课程名');
for (const type of ['task', 'entry', 'incomplete', 'progress']) {
  const f = fixture(type);
  await f.run();
  assert.ok(f.calls.includes('2:0'), '出错后必须继续后续章节');
  if (type === 'task') assert.ok(f.calls.includes('1:1'), '单个任务异常不能吞掉同章后续任务');
  const item = f.messages.find(message => message.type === 'HW_ISSUE_ADD')?.payload;
  if (type === 'task') {
    assert.equal(item, undefined, '同章后续任务已完成时，过程性失败只留日志');
    assert.ok(f.notes.some(text => text.includes('模型失败')));
    console.log('PASS 过程性跳过只留日志，同章和后续章节仍继续');
    continue;
  }
  assert.ok(item?.course && item.chapter && item.stack && item.details && item.action.includes('未计为完成'));
  if (type === 'incomplete') assert.equal(f.reports[0].details.status, 'incomplete', '推进队列不能假报完成');
  console.log('PASS 跳过并记录完整诊断，后续任务继续：' + type);
}
for (const type of ['stop', 'captcha']) {
  const f = fixture(type);
  await assert.rejects(f.run(), e => type === 'stop' ? e === f.STOP : e.code === 'HW_VERIFICATION_REQUIRED');
  assert.ok(!f.calls.includes('2:0'));
  assert.equal(f.messages.length, 0, '用户停止与验证码不能当成普通bug');
  console.log('PASS 保留暂停语义：' + type);
}

const background = fs.readFileSync(new URL('../background/service-worker.js', import.meta.url), 'utf8');
let recorded;
const recorder = vm.createContext({
  issueWrites: Promise.resolve(), URL, Date,
  chrome: { storage: { local: { get: async () => ({config:{api:{apiKey:'SECRET_KEY'}}}) } }, runtime: {getManifest:()=>({version:'0.9.13'})} },
  appendIssue: async item => { recorded = item; },
});
vm.runInContext(background.slice(background.indexOf('function recordIssue('), background.indexOf('async function saveQueue(')), recorder);
await recorder.recordIssue({stage:'刷课跳过',message:'错误 SECRET_KEY',course:'课程',chapter:'章节',task:'视频',action:'跳过',stack:'Error: SECRET_KEY',details:'Bearer private-token',url:'https://example.test/page?token=secret'});
assert.equal(recorded.url,'https://example.test/page');
assert.ok(recorded.course && recorded.task && recorded.stack && recorded.details && recorded.action);
assert.ok(!JSON.stringify(recorded).includes('SECRET_KEY') && !recorded.details.includes('private-token'));
console.log('PASS 后台持久化完整诊断并隐藏Key、Bearer与网址鉴权参数');
