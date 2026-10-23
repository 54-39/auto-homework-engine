/* 课程列表页识别 + 排队接力的真实 Chromium 检查。
   用户 2026-10-19 要的效果：站在课程列表页 → 勾几门 → 全自动刷完那几门。
   这里不联网，用仿超星结构的 fixture：卡片是 JS 画的（真实站点也是），目录用 .catalog_title。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.tmp-watch-tests');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'edge-queue-'));
const edge = process.env.EDGE_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function queueChecks() {
  const out = [];
  const check = async (name, fn) => {
    try { await fn(); out.push({ name, ok: true }); } catch (e) { out.push({ name, ok: false, error: e.stack || e.message }); }
  };
  const ok = (v, msg = 'assertion failed') => { if (!v) throw new Error(msg); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await check('列表页认出所有课程，取到课名与进度', () => {
    const list = HW.Watch.courseLinks();
    ok(list.length === 3, '认出 ' + list.length + ' 门课：' + JSON.stringify(list.map((c) => c.name)));
    const names = list.map((c) => c.name);
    // 每门课有两个同名链接（封面 + 课程名），不能重复计数
    ok(new Set(list.map((c) => c.key)).size === list.length, '有重复课程');
    const gauss = list.find((c) => /openGauss/.test(c.name));
    ok(gauss, '没认出 openGauss：' + JSON.stringify(names));
    ok(gauss.done === 61 && gauss.total === 62, '进度读错：' + gauss.done + '/' + gauss.total);
    // cpi 每门课可能不同，必须逐卡片取
    ok(gauss.cpi === '492223855', 'cpi 取错：' + gauss.cpi);
    ok(list.find((c) => /大学英语/.test(c.name)).cpi === '494419162', '不同 cpi 的课没逐卡片取');
    ok(gauss.scUrl.includes('courseid=265776447') && gauss.scUrl.includes('clazzid=151542705'), 'scUrl 拼错：' + gauss.scUrl);
  });

  await check('已结束 / 已退课的课程不出现在清单里', () => {
    const names = HW.Watch.courseLinks().map((c) => c.name);
    ok(!names.some((n) => /已结束的课/.test(n)), '混进了已结束课程');
    ok(!names.some((n) => /已退课的课/.test(n)), '混进了已退课课程');
  });
  await check('真实课程卡片大量缩进空白不能截掉任务进度', () => {
    const card = document.querySelector('.courseCard');
    const padding = document.createTextNode(' \n '.repeat(500));
    card.prepend(padding);
    try {
      const course = HW.Watch.courseLinks().find(c => c.courseid === '265776447');
      ok(course.done === 61 && course.total === 62, '进度被卡片空白截掉');
    } finally { padding.remove(); }
  });
  await check('每门课程按剩余任务和倍速估算，实际耗时修正；完成课程为零，未知进度不猜', () => {
    const c = HW.Watch.courseLinks()[0];
    ok(HW.Watch.estimateCourseSeconds(c, 2) === 240);
    ok(HW.Watch.estimateCourseSeconds(c, 1) === 480);
    ok(HW.Watch.estimateCourseSeconds(c, 2, { jobs: 2, seconds: 240 }) === 60);
    ok(HW.Watch.estimateCourseSeconds({ ...c, done: c.total }, 2) === 0);
    ok(HW.Watch.estimateCourseSeconds({ ...c, done: null }, 2) === null);
    ok(HW.Watch.estimateCourseSeconds({ ...c, done: -1 }, 2) === null);
    ok(HW.Watch.estimateCourseSeconds({ ...c, done: 1000 }, 2) === null);
    ok(HW.Watch.courseTimeKey({ ...c, cpi: 'other' }) !== HW.Watch.courseTimeKey(c), '不同学习账号共享了课程耗时');
  });

  await check('页面类型能分清：列表 / 目录 / 学习页', () => {
    // 当前 fixture 是列表页
    document.querySelectorAll('.catalog_title').forEach((x) => x.remove());
    ok(HW.Watch.pageKind() === 'courses', '列表页判成 ' + HW.Watch.pageKind());
    // 换成目录页结构
    const t = document.createElement('div');
    t.className = 'catalog_title';
    t.setAttribute('aria-labelledby', 'tab_cur900');
    t.innerHTML = '<div class="catalog_name newCatalog_name"><a class="clicktitle"><span class="catalog_sbar">1.1</span> 第一节</a></div>';
    document.body.append(t);
    document.querySelectorAll('a[href*="stucoursemiddle"]').forEach((a) => a.remove());
    ok(HW.Watch.pageKind() === 'catalog', '目录页判成 ' + HW.Watch.pageKind());
    t.remove();
    const box = document.createElement('div');
    box.className = 'posCatalog_select';
    box.id = 'cur900';
    box.innerHTML = '<span class="posCatalog_name">第一节</span>';
    document.body.append(box);
    ok(HW.Watch.pageKind() === 'study', '学习页判成 ' + HW.Watch.pageKind());
    box.remove();
  });

  await check('目录页读出节点 id 与已完成状态，进课只点没做完的那个', () => {
    document.body.innerHTML = `<div id="catalog">
      <div class="catalog_title" aria-labelledby="tab_cur900" data-n="已完成节点">
        <div class="inputCheck"><input type="checkbox" name="checkbox" value="900"></div>
        <div class="catalog_name newCatalog_name"><a class="clicktitle">1.1 已完成节点</a></div>
        <div class="catalog_task"><div class="catalog_state icon_yiwanc"><span class="bntHoverTips">已完成<i></i></span></div></div>
      </div>
      <div class="catalog_title" aria-labelledby="tab_cur901" data-n="待做节点">
        <div class="inputCheck"><input type="checkbox" name="checkbox" value="901"></div>
        <div class="catalog_name newCatalog_name"><a class="clicktitle">1.2 待做节点</a></div>
        <div class="catalog_task"><div class="catalog_state"></div></div>
      </div>
    </div>`;
    const entries = HW.Watch.catalogEntries();
    ok(entries.length === 2, '读出 ' + entries.length + ' 个节点');
    ok(entries[0].id === '900' && entries[0].done === true, '已完成节点读错：' + JSON.stringify(entries[0].id + '/' + entries[0].done));
    ok(entries[1].id === '901' && entries[1].done === false, '待做节点读错');
    const entered = HW.Watch.enterCourse();
    ok(entered && entered.id === '901', '进课点错了节点：' + (entered && entered.id));
  });

  await check('只认课程开头四节，前面有问卷等普通缺口不能被后四节掩盖', () => {
    const entries = [
      { id: '1', name: '第一节', done: true }, { id: '2', name: '第二节', done: true },
      { id: '3', name: '学情调查', done: false }, { id: '4', name: '第四节', done: true },
      { id: '5', name: '第五节', done: true }, { id: '6', name: '第六节', done: true },
      { id: '7', name: '第七节', done: true }, { id: '8', name: '第八节', done: true },
    ];
    const next = HW.Watch.fourWindow(entries);
    ok(next.start === 0 && next.chapterIds.join(',') === '1,2,3,4', '跳过了前面的普通任务');
    ok(HW.Watch.fourWindow(entries, [0]).incomplete, '问卷未完成却报达标');
    entries[2].done = true;
    const done = HW.Watch.fourWindow(entries);
    ok(done.complete && done.chapterIds.join(',') === '1,2,3,4', '漏认开头四节完成');
    entries[2].done = false; entries[2].name = '口语练习';
    const oral = HW.Watch.fourWindow(entries, [0]);
    ok(oral.complete && oral.exceptions.length === 1 && oral.exceptions[0].id === '3', '明确口语例外未单列');
  });

  await check('连续四节队列先锁定范围，平台目录核验后才报达标', async () => {
    history.replaceState({}, '', '/mooc2-ans/mycourse/studentcourse?courseid=1&clazzid=2');
    document.body.innerHTML = `<div id="catalog">${[901, 902, 903, 904].map(id =>
      `<div class="catalog_title" aria-labelledby="tab_cur${id}"><a class="clicktitle">第${id}节</a><div class="catalog_task"><div class="catalog_state"></div></div></div>`).join('')}</div>`;
    const course = { key: '1|2', name: '示范课' };
    let scope = null, done = null, clicks = 0;
    document.querySelector('.clicktitle').addEventListener('click', () => { clicks++; });
    chrome.runtime.sendMessage = async msg => {
      if (msg.type === 'HW_WATCH_QUEUE_GET') return { ok: true, queue: { courses: [course], index: 0, targetRun: 4 } };
      if (msg.type === 'HW_WATCH_SCOPE_SET') { scope = msg.payload; return { ok: true }; }
      if (msg.type === 'HW_WATCH_COURSE_DONE') { done = msg.payload; return { ok: true }; }
      return { ok: true };
    };
    try {
      ok(await HW.Watch.resumeQueued({}));
      ok(scope?.chapterIds.join(',') === '901,902,903,904' && scope.start === 0, '未锁定相邻四节');
      ok(clicks === 1 && done === null, '未完成就报达标或未点击平台目录');
      document.querySelectorAll('.catalog_state').forEach(el => el.classList.add('icon_yiwanc'));
      ok(await HW.Watch.resumeQueued({}));
      ok(done?.status === 'complete' && done.chapterIds.join(',') === '901,902,903,904', '目录完成标记未决定达标');
    } finally { history.replaceState({}, '', '/'); }
  });

  await check('有排队时，页面一加载就接着干（不需要用户再点）', async () => {
    document.body.innerHTML = `<div id="catalog">
      <div class="catalog_title" aria-labelledby="tab_cur901">
        <div class="inputCheck"><input type="checkbox" name="checkbox" value="901"></div>
        <div class="catalog_name newCatalog_name"><a class="clicktitle" id="go">1.2 待做节点</a></div>
      </div>
    </div>`;
    window.__entered = 0;
    document.querySelector('#go').addEventListener('click', () => { window.__entered++; });
    window.__notes = [];
    // 后台说：当前这门课排在第 0 位
    window.chrome.runtime.sendMessage = async (msg) => {
      if (msg.type === 'HW_WATCH_QUEUE_GET') {
        return { ok: true, queue: { courses: [{ key: '1|2', scUrl: 'about:blank', name: '示范课' }], index: 0, rate: 2, autoRate: true } };
      }
      if (msg.type === 'HW_WATCH_COURSE_DONE') { window.__doneKey = msg.payload.key; return { ok: true }; }
      return { ok: true };
    };
    const took = await HW.Watch.resumeQueued({ onNote: (t) => window.__notes.push(t) });
    ok(took === true, '看到排队却没接着干');
    ok(window.__entered === 1, '没点进课程（点了 ' + window.__entered + ' 次）');
  });

  await check('目录延迟渲染时仍接续队列，不把尚未加载当成课程完成', async () => {
    document.body.innerHTML = '';
    history.replaceState({}, '', '/');
    window.__entered = 0;
    window.__doneKey = null;
    setTimeout(() => {
      document.body.innerHTML = '<div class="catalog_title" aria-labelledby="tab_cur901"><a class="clicktitle" id="late">待完成章节</a></div>';
      document.querySelector('#late').addEventListener('click', () => { window.__entered++; });
    }, 500);
    await HW.Watch.resumeQueued({});
    ok(window.__entered === 1, '延迟目录出现后没有接续');
    ok(window.__doneKey === null, '未加载的课程被提前报完成');
  });

  await check('课程首页默认打开任务时点章节，沿原生iframe地址继续，保留鉴权参数', async () => {
    history.replaceState({}, '', '/mooc2-ans/mycourse/stu?courseid=1&clazzid=2');
    document.body.innerHTML = '<span id="chapterNav">章节</span>';
    let opened;
    document.getElementById('chapterNav').addEventListener('click', () => {
      const iframe = document.createElement('iframe');
      iframe.src = '/mooc2-ans/mycourse/studentcourse?courseid=1&clazzid=2&stuenc=fixture-session';
      document.body.append(iframe);
    });
    chrome.runtime.sendMessage = async msg => {
      if (msg.type === 'HW_WATCH_QUEUE_GET') return { ok: true, queue: { courses: [{ key: '1|2' }], index: 0 } };
      if (msg.type === 'HW_WATCH_OPEN_CATALOG') opened = msg.payload.url;
      return { ok: true };
    };
    try { ok(await HW.Watch.resumeQueued({})); ok(opened?.includes('stuenc=fixture-session')); }
    finally { history.replaceState({}, '', '/'); }
  });
  await check('没有排队时什么也不做，普通用户手动用面板照旧', async () => {
    window.chrome.runtime.sendMessage = async () => ({ ok: true, queue: null });
    const took = await HW.Watch.resumeQueued({});
    ok(took === false, '没有排队却动了手');
  });

  await check('目录页没有可点节点时，报这门课做完、让后台翻下一门', async () => {
    document.body.innerHTML = '<div id="catalog"></div>';
    // 真实站点上这种空壳课就是 studentcourse 页（只有「已完成任务点: 0/0」，一个节点都没有）
    history.replaceState({}, '', '/mooc2-ans/mycourse/studentcourse?courseid=9&clazzid=8&ut=s');
    window.__doneKey = null;
    window.chrome.runtime.sendMessage = async (msg) => {
      if (msg.type === 'HW_WATCH_QUEUE_GET') {
        return { ok: true, queue: { courses: [{ key: '9|8', scUrl: 'about:blank', name: '空壳课' }], index: 0 } };
      }
      if (msg.type === 'HW_WATCH_COURSE_DONE') { window.__doneKey = msg.payload.key; return { ok: true }; }
      return { ok: true };
    };
    const took = await HW.Watch.resumeQueued({ onNote: (t) => window.__notes.push(t) });
    ok(took === true, '空壳课没被认成目录页处理');
    ok(window.__doneKey === '9|8', '没报完成，队列会卡死：' + window.__doneKey);
    history.replaceState({}, '', '/');
  });

  /* 真实页面 2026-10-20「中国共产党简史」实测：这一页既没有 jobUnfinishCount 也没有 orangeNew，
     唯一写着做完的是目录项里那句「已完成」。不认它，整门已刷完的课会被当成「不知道」而重刷一遍。 */
  await check('既没有未完成数也没有角标时，认目录项里的「已完成」标记', () => {
    document.body.innerHTML = `<div id="coursetree">
      <div class="posCatalog_select" id="cur900">
        <span class="posCatalog_name" onclick="getTeacherAjax('1','2','900');">1.1 做完的节</span>
        <span class="icon_Completed prevTips"><span class="prevHoverTips">已完成<i></i></span></span>
      </div>
      <div class="posCatalog_select" id="cur901">
        <span class="posCatalog_name" onclick="getTeacherAjax('1','2','901');">1.2 没做的节</span>
      </div>
      <div class="posCatalog_select" id="cur902">
        <span class="posCatalog_name" onclick="getTeacherAjax('1','2','902');">1.3 纯阅读节</span>
      </div>
    </div>`;
    ok(HW.Watch.unfinishedOf('900') === 0, '已完成标记没认出来：' + HW.Watch.unfinishedOf('900'));
    ok(HW.Watch.unfinishedOf('901') === null, '没有信号的节应返回 null：' + HW.Watch.unfinishedOf('901'));
    ok(HW.Watch.unfinishedOf('902') === null, '纯阅读节被误判成已知：' + HW.Watch.unfinishedOf('902'));
    const names = HW.Watch.nodes().map((n) => n.name);
    ok(names[0] === '1.1 做完的节' || !/已完成/.test(names[0] || ''), '课名没切掉「已完成」：' + names[0]);
  });

  await check('学习页地址能认回课程，单门课也能走后台排队（点目录会整页跳走，状态要留在后台）', () => {
    history.replaceState({}, '', '/mycourse/studentstudy?chapterId=1232018916&courseId=266493607&clazzid=153987074&cpi=492223855');
    const cur = HW.Watch.currentCourse();
    ok(!!cur, '没认出当前课程');
    ok(cur.key === '266493607|153987074', '课程 key 错：' + (cur && cur.key));
    ok(/courseid=266493607/.test(cur.scUrl) && /clazzid=153987074/.test(cur.scUrl) && /cpi=492223855/.test(cur.scUrl), '目录页地址拼错：' + (cur && cur.scUrl));
    ok(/studentcourse/.test(cur.scUrl), '拼出来的不是能读目录的那一页：' + (cur && cur.scUrl));
    history.replaceState({}, '', '/');
  });

  await check('空计数、异常角标和正文里的已完成不作为完成依据', () => {
    document.body.innerHTML = '<div id="cur910"><input class="jobUnfinishCount" value=""></div>'
      + '<div id="cur911"><span class="orangeNew">加载中</span></div>'
      + '<div id="cur912"><span>已完成的章节不要重复观看</span></div>'
      + '<div id="cur913"><span class="orangeNew">0</span></div>';
    for (const id of ['910', '911', '912', '913']) ok(HW.Watch.unfinishedOf(id) === null, id + ' 被误判成已完成');
  });
  await check('进入课程后记录真实剩余任务，未知计数不覆盖，返回外层可估算及折叠完成课程', async () => {
    const previous = chrome.storage;
    const store = {};
    chrome.storage = { local: { get: async key => ({ [key]: store[key] }), set: async value => Object.assign(store, value) } };
    history.replaceState({}, '', '/mycourse/studentstudy?courseId=555&clazzid=666&cpi=777');
    document.body.innerHTML = '<div class="posCatalog_select" id="cur970"><span class="posCatalog_name">第一节</span><input class="jobUnfinishCount" value="2"></div><div class="posCatalog_select" id="cur971"><span class="posCatalog_name">第二节</span><input class="jobUnfinishCount" value="1"></div>';
    document.querySelectorAll('.posCatalog_name').forEach((span, i) => span.setAttribute('onclick', "getTeacherAjax('1','2','" + (970 + i) + "');"));
    try {
      await HW.Watch.rememberCourseProgress();
      const key = HW.Watch.courseTimeKey(HW.Watch.currentCourse());
      ok(store[key].remainingJobs === 3);
      ok(HW.Watch.remainingSeconds() === 720);
      const course = { done: null, total: null };
      ok(HW.Watch.estimateCourseSeconds(course, 2, store[key]) === 720);
      document.querySelector('#cur971 input').value = '';
      await HW.Watch.rememberCourseProgress();
      ok(store[key].remainingJobs === 3 && HW.Watch.remainingSeconds() === null, '未知目录覆盖了已有进度');
      document.querySelectorAll('input').forEach(el => { el.value = '0'; });
      await HW.Watch.rememberCourseProgress();
      ok(HW.Watch.estimateCourseSeconds(course, 2, store[key]) === 0);
      ok(HW.Watch.estimateCourseSeconds({ done: 0, total: 1 }, 2, store[key]) === 240, '新页面的未完成进度被旧缓存覆盖');
    } finally { chrome.storage = previous; history.replaceState({}, '', '/'); }
  });

  window.queueResults = out;
  return out;
}
/* 列表页 fixture：卡片由 JS 画（真实站点就是这样，抓源码抓不到），
   每门课两个同名链接；末尾两门是已结束 / 已退课。 */
const fixture = `<!doctype html><meta charset="utf-8"><title>课程列表 fixture</title>
<script>
  window.__errs = [];
  window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
  // 内容脚本用 chrome.runtime 问后台，这里先给个空实现，测试里再改
  window.chrome = { runtime: { sendMessage: async () => ({ ok: true }) } };
</script>
<div id="list"></div>
<script>
  const cards = [
    { id: '265776447', cl: '151542705', cpi: '492223855', name: 'openGauss数据库原理与应用（第4期）', prog: '任务点进度: 61/62 98%' },
    { id: '265880211', cl: '152496100', cpi: '494419162', name: '大学英语3--新标准大学英语（本科）', prog: '' },
    { id: '266493607', cl: '153987074', cpi: '492223855', name: '中国共产党简史', prog: '任务点进度: 132/135 97%' },
    { id: '111111111', cl: '222222222', cpi: '492223855', name: '已结束的课', prog: '课程已结束' },
    { id: '333333333', cl: '444444444', cpi: '492223855', name: '已退课的课', prog: '已退课' },
  ];
  const link = (c, cls) => '<a class="' + cls + '" href="https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=' + c.id
    + '&clazzid=' + c.cl + '&cpi=' + c.cpi + '&ismooc2=1&v=2" title="' + c.name + '">' + (cls === 'name' ? c.name : '') + '</a>';
  const host = document.querySelector('#list');
  for (const c of cards) {
    const li = document.createElement('li');
    li.className = 'courseCard';
    li.innerHTML = link(c, 'cover') + '<div class="info">' + link(c, 'name')
      + '<p class="teacher">某老师</p><p class="progress">' + c.prog + '</p></div>';
    host.append(li);
  }
</script>`;

const sources = fs.readFileSync(path.join(root, 'content/course/watch.js'), 'utf8');
const html = fixture + `<script>${sources}</script><script>window.runQueueChecks=${queueChecks.toString()};</script>`;
fs.writeFileSync(path.join(output, 'queue-page.html'), html);
const server = http.createServer((_, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-crash-reporter', '--disable-breakpad', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
let socket;
try {
  let port;
  for (let i = 0; i < 150; i++) {
    const file = path.join(profile, 'DevToolsActivePort');
    if (fs.existsSync(file)) { port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]); break; }
    if (child.exitCode !== null) throw new Error('Headless Edge exited before opening DevTools');
    await pause(100);
  }
  assert.ok(port, 'Headless Edge unavailable');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://127.0.0.1:${server.address().port}/`)}`, { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, reject) => { socket.onopen = r; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (!pending.has(msg.id)) return;
    const { resolve, reject, timer } = pending.get(msg.id);
    clearTimeout(timer);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  };
  const call = (method, params = {}, ms = 120000) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('CDP timeout: ' + method)); }, ms);
    pending.set(key, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: key, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  for (let i = 0; i < 100 && !(await evaluate('document.readyState === "complete" && !!window.runQueueChecks && !!window.HW')); i++) await pause(50);
  const results = await evaluate('runQueueChecks()');
  console.log('debug:', JSON.stringify(await evaluate(`({errs: window.__errs, list: HW.Watch.courseLinks().map(c => c.name + ' ' + c.done + '/' + c.total)})`)));
  for (const r of results) console.log(r.ok ? 'PASS' : 'FAIL', r.name, r.error || '');
  fs.writeFileSync(path.join(output, 'queue-results.json'), JSON.stringify(results, null, 2));
  assert.ok(results.every((r) => r.ok), 'Course queue checks failed; see .tmp-watch-tests/queue-results.json');
  console.log(`\n${results.length} course queue groups passed.`);
} finally {
  socket?.close();
  child.kill();
  server.closeAllConnections();
  server.close();
  await pause(300);
  const relative = path.relative(output, profile);
  if (!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('edge-queue-')) {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
    catch { console.warn('Temporary browser profile is still locked:', profile); }
  }
}
