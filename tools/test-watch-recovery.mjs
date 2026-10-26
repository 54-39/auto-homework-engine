import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(process.env.WATCH_SOURCE || new URL('../content/course/watch.js', import.meta.url), 'utf8');
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
    pendingVideos: () => [], pageKind: () => 'study', unfinishedJobSummary: () => ['测验任务未完成'],
    tabList: () => [{ id: 'dct1', textContent: '测验一' }, { id: 'dct2', textContent: '测验二' }],
    tabActive: item => item.id === 'dct' + (tab + 1),
    dismissUnfinishedDialog: async () => false, jitter: n => n,
    dismissQuizRetryNotice: () => false, quizGrades: new Map(), quizRetrySignals: new Set(),
    step: async () => {}, until: async predicate => predicate(),
    clickNode: id => { if (failure === 'entry' && id === '1') throw Error('目录点击异常'); active = id; return true; },
    goto: async index => { tab = index; calls.push(active + ':' + tab); return true; },
    ensureCardRendered: async () => true, cardHasNoTasks: () => false, expandTaskCards: async () => {}, classify: () => failure === 'mixed' ? 'video' : 'quiz', bbsCard: () => false, surveyCard: () => false,
    videoJobsDone: () => true,
    textJobsDone: () => counts[active] === 0,
    readThrough: async () => { calls.push(active + ':read'); counts[active] = 0; return true; },
    quizDocument: () => null,
    docs: () => [],
    runQuizzes: async () => {
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
assert.ok(!success.calls.includes('1:1')&&!success.calls.includes('2:1'),'任务已归零仍进入后续空页');
{
  const f=fixture('success'),asked=[],original=f.context.runQuizzes;
  f.context.cardHasNoTasks=()=>f.calls.at(-1)==='1:0';
  f.context.runQuizzes=async()=>{asked.push(f.calls.at(-1));return original();};
  await f.run();
  assert.ok(!asked.includes('1:0')&&asked.includes('1:1')&&asked.includes('2:0'));
  console.log('PASS 平台暂无内容页不空等，继续下一页签和后续章节');
}
const mixed = fixture('mixed');
await mixed.run();
assert.ok(mixed.calls.includes('1:read') && mixed.calls.includes('2:read'), '视频已完成的混合页跳过了文档，后续章节也无法完成');
assert.equal(mixed.messages.length, 0, '正常阅读完成不应记录任务缺口');
console.log('PASS 视频已完成的混合页继续处理阅读，完成后推进下一章');
{
  const f = fixture('mixed'), bbs = new Set(), surveys = new Set();
  const key = () => f.context.activeChapterId();
  f.context.bbsCard = () => bbs.has(key()) ? null : {};
  f.context.openBbsCard = async () => { f.calls.push(key() + ':bbs'); bbs.add(key()); return true; };
  f.context.surveyCard = () => surveys.has(key()) ? null : {};
  f.context.openSurveyCard = async () => { f.calls.push(key() + ':survey'); surveys.add(key()); return true; };
  f.context.quizDocument = () => ({});
  f.context.runQuizzes = async () => { f.calls.push(key() + ':quiz'); };
  await f.run();
  for (const chapter of ['1', '2']) {
    const indices = ['bbs', 'survey', 'quiz', 'read'].map(type => f.calls.indexOf(chapter + ':' + type));
    assert.ok(indices.every(index => index >= 0) && indices.every((index, i) => i === 0 || index > indices[i - 1]), '视频优先分类仍漏掉同页其他任务：' + chapter);
  }
  console.log('PASS 视频、讨论、问卷、测验与文档同页时分别处理，不互斥漏项');
}
assert.match(success.notes[0], /测试课程.*已走完一遍/);
console.log('PASS 正常课程只记录一次课程完成，并带课程名');
for (const type of ['task', 'entry', 'incomplete', 'progress']) {
  const f = fixture(type);
  await f.run();
  assert.ok(f.calls.includes('2:0'), '出错后必须继续后续章节');
  if (type === 'task') assert.ok(f.calls.includes('1:1'), '单个任务异常不能吞掉同章后续任务');
  const item = f.messages.find(message => message.type === 'HW_ISSUE_ADD')?.payload;
  if (type === 'task' || type === 'progress') {
    assert.equal(item, undefined, '同章后续任务已完成时，过程性失败只留日志');
    assert.ok(f.notes.some(text => text.includes(type === 'task' ? '模型失败' : '统计失败')));
    console.log('PASS 节点已完成时过程失败不单独上报，后续章节仍继续：' + type);
    continue;
  }
  assert.ok(item?.course && item.chapter && item.stack && item.details && item.action.includes('未计为完成'));
  if (type === 'incomplete') assert.equal(f.reports[0].details.status, 'incomplete', '推进队列不能假报完成');
  console.log('PASS 跳过并记录完整诊断，后续任务继续：' + type);
}
{
  const f = fixture('success');
  f.context.quizGrades.set('quiz-one', { chapter: '1', score: 66.7, total: 100 });
  await f.run();
  assert.equal(f.messages.filter(message => message.type === 'HW_ISSUE_ADD').length, 0);
  console.log('PASS 节点已完成时低分不生成独立异常');
}
{
  const f = fixture('incomplete');
  f.context.quizGrades.set('quiz-one', { chapter: '1', score: 66.7, total: 100 });
  await f.run();
  const item = f.messages.find(message => message.type === 'HW_ISSUE_ADD')?.payload;
  assert.match(item?.message, /仍有 1 个任务点未完成.*66\.7\/100/);
  assert.ok(JSON.parse(item.details).process.some(text => text.includes('模型失败')));
  console.log('PASS 低分节点仍未完成时，收尾报告保留分数和失败原因');
}
{
  const f = fixture('task'), original = f.context.unfinishedOf;
  f.context.unfinishedOf = id => id === '1' ? null : original(id);
  await f.run();
  const items = f.messages.filter(message => message.type === 'HW_ISSUE_ADD');
  assert.equal(items.length, 1);
  assert.match(items[0].payload.message, /任务计数未知/);
  assert.ok(JSON.parse(items[0].payload.details).process.some(text => text.includes('模型失败')));
  assert.ok(f.calls.includes('2:0'));
  console.log('PASS 计数未知且处理失败时保留收尾诊断，继续后续章节');
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
  chrome: { storage: { local: { get: async () => ({config:{diagnosticsEnabled:true,api:{apiKey:'SECRET_KEY'}}}) } }, runtime: {getManifest:()=>({version:'0.9.13'})} },
  appendIssue: async item => { recorded = item; },
});
vm.runInContext(background.slice(background.indexOf('function recordIssue('), background.indexOf('async function saveQueue(')), recorder);
await recorder.recordIssue({stage:'刷课跳过',message:'错误 SECRET_KEY',course:'课程',chapter:'章节',task:'视频',action:'跳过',stack:'Error: SECRET_KEY',details:'Bearer private-token',url:'https://example.test/page?token=secret'});
assert.equal(recorded.url,'https://example.test/page');
assert.ok(recorded.course && recorded.task && recorded.stack && recorded.details && recorded.action);
assert.ok(!JSON.stringify(recorded).includes('SECRET_KEY') && !recorded.details.includes('private-token'));
console.log('PASS 后台持久化完整诊断并隐藏Key、Bearer与网址鉴权参数');
