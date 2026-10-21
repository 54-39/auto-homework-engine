/* 整课遍历的真实 Chromium 检查：目录逐节前进 + 每节三个页签轮转 + 视频/测验/阅读分别处理。
   不联网；页面是仿超星结构的 fixture（目录树、.prev_ul 页签、#iframe 换内容）。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.tmp-watch-tests');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'edge-loop-'));
const edge = process.env.EDGE_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function loopChecks() {
  const out = [];
  const check = async (name, fn) => {
    try { await fn(); out.push({ name, ok: true }); } catch (e) { out.push({ name, ok: false, error: e.stack || e.message }); }
  };
  const ok = (v, msg = 'assertion failed') => { if (!v) throw new Error(msg); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // 面板在真实页面由 panel.js 提供；这里只用它的入口，断言调用次数
  window.homeworkCalls = 0;
  HW.Panel = { runHomework: async () => { window.homeworkCalls++; return '填了 2 题'; } };

  let stopCalls = 0;
  const notes = [];
  window.__notes = notes;
  HW.Watch.start({
    rate: 2,
    onNote: (t) => notes.push(t),
    onStop: () => { stopCalls++; },
  });

  await check('目录逐节前进（两节都进过）', async () => {
    for (let i = 0; i < 200 && HW.Watch.running; i++) await wait(500);
    ok(!HW.Watch.running, '整课没跑完就还在跑');
    const visited = window.chaptersVisited || [];
    ok(visited.join(',') === '101,102', '到过的章节：' + JSON.stringify(visited));
  });

  await check('四个页签各点过一次以上（每节都轮转，含本章讨论）', () => {
    for (const t of ['dct1', 'dct2', 'dct3', 'dct4']) {
      ok((window.tabClicks?.[t] || 0) >= 2, t + ' 只点了 ' + (window.tabClicks?.[t] || 0) + ' 次');
    }
  });

  await check('本章讨论替用户回了一条帖（不重复发）', () => {
    ok((window.__discussReplies || 0) >= 1, 'addDiscussReply 一次都没被点：' + (window.__discussReplies || 0));
    ok(window.__discussReplies <= 2, '讨论回复发了 ' + window.__discussReplies + ' 次，重复发帖');
    ok(window.__notes.some((t) => /讨论：已在/.test(t)), '没提示讨论已发：' + window.__notes.join(' / '));
  });

  await check('视频页按 2x 播完才算过', () => {
    ok((window.videoTabs || 0) >= 2, '视频页只出现了 ' + (window.videoTabs || 0) + ' 次');
    ok(window.videoEndedSeen >= 2, '视频没播到结束');
  });

  await check('测验页交给面板的 AI 答题', () => {
    ok(window.homeworkCalls >= 2, 'runHomework 只调了 ' + window.homeworkCalls + ' 次');
  });

  /* 只填不交的测验在站点侧永远是「待完成」，任务点不会 +1（用户 2026-10-19 实测确认）。
     所以填完之后必须点「提交」，再点确认框里的「确定」。 */
  await check('填完自己点「提交」并过确认框', () => {
    ok((window.__submitClicks || 0) >= 2, '「提交」只点了 ' + (window.__submitClicks || 0) + ' 次');
    ok((window.__confirmClicks || 0) >= 2, '确认框「确定」只点了 ' + (window.__confirmClicks || 0) + ' 次');
  });

  await check('走完后自动回到停止状态并回调 onStop', () => {
    ok(stopCalls >= 1, '脚本自己停了却没回调 onStop');
    ok(notes.some((t) => /走完一遍/.test(t)), '没提示已走完：' + notes.join(' / '));
  });

  await check('停止时正在播的视频被按住暂停（站点想重播也按回去）', async () => {
    // 上一轮已自然走完，这次重新起一轮，等切到视频页再按停止——这才是用户点「停止」的真实时刻
    window.videoTabs = 0;
    HW.Watch.start({ rate: 2, onNote: (t) => notes.push(t), onStop: () => { stopCalls++; } });
    for (let i = 0; i < 60 && (window.videoTabs || 0) < 1; i++) await wait(300);
    ok((window.videoTabs || 0) >= 1, '没切到视频页，无法验证停止');
    await wait(600);
    window.__vended = false;
    window.__vpaused = false; // 站点自动把播放接回去
    HW.Watch.stop();
    await wait(1500);
    ok(window.__vpaused === true, '停止后视频仍在播放');
  });

  await check('AI答题失败后停止，不点击测验提交', async () => {
    const original = HW.Panel.runHomework;
    const submitted = window.__submitClicks || 0;
    HW.Panel.runHomework = async () => { throw new Error('模拟AI失败'); };
    HW.Watch.start({ rate: 2, onNote: t => notes.push(t) });
    for (let i = 0; i < 80 && HW.Watch.running; i++) await wait(500);
    ok(!HW.Watch.running, 'AI失败后仍继续刷课');
    ok((window.__submitClicks || 0) === submitted, 'AI失败后仍提交测验');
    HW.Watch.stop(); HW.Panel.runHomework = original;
  });

  await check('遍历后续慢加载页签，第四页签不是讨论时不发帖', async () => {
    HW.Watch.stop();
    const replies = window.__discussReplies || 0;
    const homework = window.homeworkCalls || 0;
    document.querySelector('#dct4').textContent = '经世';
    const fifth = document.createElement('li');
    fifth.id = 'dct5'; fifth.textContent = '补充任务';
    document.querySelector('.prev_ul').append(fifth);
    let clicks = 0;
    fifth.addEventListener('click', () => {
      clicks++;
      document.querySelectorAll('.prev_ul li').forEach(li => li.classList.toggle('active', li === fifth));
      const frame = document.querySelector('#iframe');
      frame.removeAttribute('srcdoc');
      frame.src = '/knowledge/cards?knowledgeid=' + HW.Watch.activeChapterId() + '&num=4';
    });
    HW.Watch.start({ rate: 2, onNote: (t) => notes.push(t) });
    for (let i = 0; i < 140 && HW.Watch.running; i++) await wait(500);
    ok(clicks >= 2, '第五页签被跳过：' + clicks);
    ok((window.homeworkCalls || 0) - homework >= 4, '慢加载页签里的测验被当空白页跳过');
    ok((window.__discussReplies || 0) === replies, '把第四个普通阅读页签误当讨论');
    HW.Watch.stop(); fifth.remove();
    document.querySelector('#dct4').textContent = '本章讨论';
  });

  /* 站点在目录项里写 jobUnfinishCount=0 表示这一节已经做完。用户 2026-10-19 反馈
     「刷完的章节不要重复刷」，所以起一轮时必须跳过它们，而且不能再把内容点开一遍。 */
  await check('已刷完的章节（jobUnfinishCount=0）直接跳过不重刷', async () => {
    HW.Watch.stop();
    for (const el of document.querySelectorAll('#coursetree .posCatalog_select')) el.remove();
    const add = (id, name, count) => {
      const box = document.createElement('div');
      box.className = 'posCatalog_select';
      box.id = 'cur' + id;
      box.innerHTML = '<span class="posCatalog_name" title="' + name + '" onclick="getTeacherAjax(\'1\',\'2\',\'' + id + '\');">'
        + name + '</span>' + (count === null ? '' : '<input type="hidden" class="jobUnfinishCount" value="' + count + '">');
      document.querySelector('#coursetree').appendChild(box);
    };
    // 零角标没有明确完成标记时仍需打开检查。
    const addBadge = (id, name) => {
      const box = document.createElement('div');
      box.className = 'posCatalog_select';
      box.id = 'cur' + id;
      box.innerHTML = '<span class="posCatalog_name" title="' + name + '" onclick="getTeacherAjax(\'1\',\'2\',\'' + id + '\');">'
        + name + '</span><span class="catalog_points_yi"><span class="orangeNew">0</span></span>';
      document.querySelector('#coursetree').appendChild(box);
    };
    add('201', '2.1 已刷完', 0);
    add('202', '2.2 待刷', 2);
    addBadge('203', '2.3 只有零角标（完成状态未知）');
    add('204', '2.4 没有任何角标（当未知处理）', null);    window.chaptersVisited = [];
    window.__notes = notes;
    let reportedDone = 0;
    window.chrome = { runtime: { sendMessage: async (msg) => {
      if (msg.type === 'HW_WATCH_QUEUE_GET') return { ok: true, queue: { courses: [{ key: '1|2', name: '未完成课程' }], index: 0, rate: 2 } };
      if (msg.type === 'HW_WATCH_COURSE_DONE') reportedDone++;
      return { ok: true };
    } } };
    const before = notes.length;
    await HW.Watch.resumeQueued({ onNote: (t) => notes.push(t) });
    for (let i = 0; i < 320 && HW.Watch.running; i++) await wait(500);
    const visited = window.chaptersVisited || [];
    ok(!visited.includes('201'), '重刷了已完成的 2.1：' + JSON.stringify(visited));
    ok(visited.includes('203'), '跳过了只有零角标的 2.3：' + JSON.stringify(visited));
    ok(visited.includes('202'), '跳过了待刷的 2.2：' + JSON.stringify(visited));
    ok(visited.includes('204'), '跳过了没有角标的 2.4（未知不该当成已完成）：' + JSON.stringify(visited));
    ok(notes.some((t) => /跳过已完成 1 节/.test(t)), '没报告跳过了几节：' + notes.join(' / '));
    ok(reportedDone === 0, '还有未完成任务就通知后台换课');
    ok(!HW.Watch.running, '补刷未限制次数');
    ok(notes.slice(before).filter(t => /再从第一节补刷一遍/.test(t)).length === 1, '补刷没有恰好一次');
    ok(notes.some(t => /仍有 2 个任务点未完成/.test(t)), '未报告真实剩余任务');
  });

  window.loopResults = out;
  return out;
}

const fixture = `<!doctype html><meta charset="utf-8"><title>整课遍历 fixture</title>
<script>window.__errs=[];window.addEventListener('error',e=>window.__errs.push(String(e.message)));</script>
<style>body{font:14px system-ui;margin:16px}.posCatalog_select{padding:4px 0}.prev_ul{display:flex;gap:10px;list-style:none;padding:0}
.prev_ul li{padding:4px 10px;border:1px solid #ccc;cursor:pointer}.prev_ul li.active{background:#e8effd}</style>
<div id="coursetree">
  <div class="posCatalog_select" id="cur101"><span class="posCatalog_name" title="1.1 阅读与视频" onclick="getTeacherAjax('267020767','154541991','101');">1.1 阅读与视频</span></div>
  <div class="posCatalog_select" id="cur102"><span class="posCatalog_name" title="1.2 第二个任务点" onclick="getTeacherAjax('267020767','154541991','102');">1.2 第二个任务点</span></div>
</div>
<ul class="prev_ul">
  <li class="c1 active" id="dct1" title="元典阅读">元典阅读</li>
  <li class="c2" id="dct2" title="视频讲义">视频讲义</li>
  <li class="c3" id="dct3" title="章节测验">章节测验</li>
  <li class="c4" id="dct4" title="本章讨论">本章讨论</li>
</ul>
<div id="content2" style="display:none">
  <ul><li id="tit1">目录</li><li id="tit2" onclick="getChapterRightDiscuss();">讨论</li><li id="tit3">笔记</li></ul>
  <div id="posDiscussScroll"></div>
  <div class="newTopic1"><span class="newTopic_bnt">新建话题</span>
    <input id="toplevelTextCommentTitle">
    <textarea id="toplevelTextCommentContent"></textarea>
    <span class="jb_btn_60" onclick="addtopcomment('154541991')">发布</span>
  </div>
</div>
<iframe id="iframe" style="width:640px;height:360px" srcdoc="&lt;body&gt;阅读正文&lt;/body&gt;"></iframe>
<script>
  window.chaptersVisited = [];
  window.tabClicks = {};
  window.videoTabs = 0;
  window.videoEndedSeen = 0;
  window.__vpaused = true;
  window.__vended = false;
  let chapter = '101';

  const setActive = (id) => {
    for (const el of document.querySelectorAll('#coursetree .posCatalog_select')) el.classList.remove('posCatalog_active');
    document.getElementById('cur' + id).classList.add('posCatalog_active');
    chapter = id;
    window.chaptersVisited.push(id);
  };
  window.getTeacherAjax = (courseId, clazzid, id) => setActive(id);

  // 视频模块 iframe：videojs 结构；视频在 1.2s 后"播完"
  const videoDoc = () => \`<!doctype html><meta charset="utf-8"><body style="margin:0">
    <video id="vid" preload="none"></video>
    <button class="vjs-big-play-button">播放视频</button>
    <button class="vjs-play-control">暂停</button>
    <button class="vjs-playback-rate">播放速度</button>
    <div class="vjs-menu-content" style="display:none">
      <li class="vjs-menu-item">2x</li><li class="vjs-menu-item">1.5x</li><li class="vjs-menu-item">1x</li>
    </div>
    <script>
      const v = document.querySelector('#vid');
      Object.defineProperty(v, 'readyState', { get: () => 4, configurable: true });
      Object.defineProperty(v, 'paused', { get: () => window.parent.__vpaused === true, configurable: true });
      Object.defineProperty(v, 'ended', { get: () => window.parent.__vended === true, configurable: true });
      Object.defineProperty(v, 'duration', { get: () => 120, configurable: true });
      Object.defineProperty(v, 'currentTime', { get: () => 60, set: () => {}, configurable: true });
      document.querySelector('.vjs-play-control').addEventListener('click', () => { window.parent.__vpaused = true; });
      document.querySelector('.vjs-big-play-button').addEventListener('click', () => {
        window.parent.__vpaused = false;
        setTimeout(() => { window.parent.__vended = true; }, 1000);
      });
      for (const li of document.querySelectorAll('.vjs-menu-item')) {
        li.addEventListener('click', () => { v.playbackRate = Number(li.textContent.replace('x', '')); });
      }
    <\\/script></body>\`; // 反斜杠让服务端 HTML 里保留转义后的结束标签，避免提前截断外层脚本（注释里也不能出现字面结束标签）

  // 真实测验页底部有「提交」，点了还会弹一层「确认提交？」要再点一次，
  // 任务点才算完成。确认弹层是 #workpop，确认按钮 id 是 popok，文字写的是「提交」
  // （不是「确定」——UI 自动化把它的无障碍名读成「确定」，这正是当初一直点不中的原因）。
  const quizDoc = () => \`<!doctype html><meta charset="utf-8"><body style="margin:0">
    <div class="TiMu"><h3 class="mark_name">1. 单选题</h3><input type="radio" name="answer1"></div>
    <button id="submitBtn">提交</button>
    <div class="maskDiv" id="workpop" style="display:none;position:fixed;left:0;top:0;z-index:9">提示
      <p>确认提交？</p>
      <a id="popCloseFocus" href="javascript:;">关闭</a>
      <a id="popok" class="jb_btn jb_btn_92 fr fs14" href="javascript:;">提交</a>
      <a id="popno" class="btnBlue btn_92_cancel fr fs14" href="javascript:;">取消</a>
    </div>
    <script>
      document.querySelector('#submitBtn').addEventListener('click', () => {
        window.parent.__submitClicks = (window.parent.__submitClicks || 0) + 1;
        document.querySelector('#workpop').style.display = 'block';
      });
      document.querySelector('#popok').addEventListener('click', () => {
        window.parent.__confirmClicks = (window.parent.__confirmClicks || 0) + 1;
        document.querySelector('#workpop').style.display = 'none';
      });
    <\\/script></body>\`;

  const textDoc = () => '<!doctype html><meta charset="utf-8"><body style="margin:0">阅读正文</body>';

  /* 本章讨论：点 #tit2 后 AJAX 把回复框拉进 #posDiscussScroll（真实站点行为，2026-10-20 取证）。
     回复按钮的 onclick 里写着 addDiscussReply(discussId, ...)；发布话题走 #toplevelTextCommentTitle/Content。 */
  window.__discussReplies = 0;
  window.__newTopics = 0;
  window.getChapterRightDiscuss = () => {
    document.getElementById('posDiscussScroll').innerHTML =
      '<div class="discussItem"><div id="discuss777"><textarea id="discuss777"></textarea></div>'
      + '<span onclick="addDiscussReply(777,0)">回复</span></div>';
  };
  window.addDiscussReply = (id, n) => { window.__discussReplies++; };
  window.addtopcomment = () => { window.__newTopics++; };
  window.discussTabClicks = 0;

  const render = () => {
    const tab = document.querySelector('.prev_ul li.active').id;
    const box = document.querySelector('#iframe');
    if (tab === 'dct2') { window.videoTabs++; window.__vpaused = true; window.__vended = false; box.srcdoc = videoDoc(); }
    else if (tab === 'dct3') box.srcdoc = quizDoc();
    else box.srcdoc = textDoc();
    document.getElementById('content2').style.display = tab === 'dct4' ? 'block' : 'none';
  };
  // 视频"播完"后记一笔，供断言使用
  setInterval(() => { if (window.__vended) window.videoEndedSeen = window.videoTabs; }, 100);

  for (const li of document.querySelectorAll('.prev_ul li')) {
    window.__bound = (window.__bound || 0) + 1;
    li.addEventListener('click', () => {
      window.__clicked = (window.__clicked || 0) + 1;
      if (li.classList.contains('active')) return;
      for (const x of document.querySelectorAll('.prev_ul li')) x.classList.remove('active');
      li.classList.add('active');
      window.tabClicks[li.id] = (window.tabClicks[li.id] || 0) + 1;
      if (li.id === 'dct4') window.discussTabClicks++;
      render();
    });
  }

  setActive('101');
  render();
</script>`;

const sources = fs.readFileSync(path.join(root, 'content/course/watch.js'), 'utf8');
const html = fixture + `<script>${sources}</script><script>window.runLoopChecks=${loopChecks.toString()};</script>`;
fs.writeFileSync(path.join(output, 'loop-page.html'), html);
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url.startsWith('/knowledge/cards?')) {
    setTimeout(() => res.end(`<!doctype html><body><div class="mark_item">待完成：补充测验</div>
      <button onclick="document.getElementById('popok').hidden=false">提交</button>
      <button id="popok" hidden onclick="document.body.textContent='任务点已完成'">提交</button></body>`), 3000);
  } else res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-crash-reporter', '--disable-breakpad', '--remote-debugging-port=0', '--autoplay-policy=no-user-gesture-required',
  /* 整课遍历要跑 6 分钟以上：无头页面隐藏 5 分钟后 Chrome 把链式定时器压到 1 次/分钟
     （Intensive Wake Up Throttling），step() 的每个 await 都变成 60 秒，测试必挂。
     这三个开关把该节流关掉，页面里的 setTimeout 才按真实时长走。 */
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--disable-features=IntensiveWakeUpThrottling',
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
  const call = (method, params = {}, ms = 180000) => new Promise((resolve, reject) => {
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
  for (let i = 0; i < 100 && !(await evaluate('document.readyState === "complete" && !!window.runLoopChecks && !!window.HW')); i++) await pause(50);
  console.log('precheck:', JSON.stringify(await evaluate(`(function(){
    const li = document.querySelector('#dct2');
    li.click();
    return { stage: window.__stage, visited: window.chaptersVisited, hasTabClicks: typeof window.tabClicks,
      bound: window.__bound, clicked: window.__clicked, errs: window.__errs,
      ajax: typeof window.getTeacherAjax, cls: li.className, active: document.querySelector('.prev_ul li.active')?.id };
  })()`)));
  const resultsP = evaluate('runLoopChecks()').catch((e) => [{ name: 'runner', ok: false, error: String((e && e.message) || e) }]);
  /* 挂死取证：每 15s 打一次 notes/URL 状态，这样卡在哪一步一眼可见（不再让 CDP 超时蒙在鼓里） */
  let results = null;
  for (let i = 0; i < 40 && !results; i++) {
    await pause(15000);
    try {
      const snap = await evaluate(`({running: !!(window.HW && window.HW.Watch && window.HW.Watch.running),
        notes: (window.__notes || []).slice(-8), active: document.querySelector('.posCatalog_active')?.id,
        visited: window.chaptersVisited, vp: window.__vpaused, ve: window.__vended})`);
      console.log('t+' + ((i + 1) * 15) + 's:', JSON.stringify(snap).slice(0, 700));
      const probe = await Promise.race([evaluate('window.loopResults || null'), pause(3000).then(() => 'EVAL_SLOW')]);
      if (probe !== 'EVAL_SLOW' && probe) results = probe;
    } catch (e) {
      console.log('probe failed:', String(e.message || e).slice(0, 120));
      results = await resultsP;
    }
  }
  if (!results) results = await resultsP;
  console.log('debug:', JSON.stringify(await evaluate(`({tabClicks: window.tabClicks, videoTabs: window.videoTabs, videoEndedSeen: window.videoEndedSeen, notes: window.__notes, errs: window.__errs, active: document.querySelector('.posCatalog_active')?.id, tabs: [...document.querySelectorAll('.prev_ul li')].map(x => x.id + ':' + x.className), visited: window.chaptersVisited})`)));
  for (const r of results) console.log(r.ok ? 'PASS' : 'FAIL', r.name, r.error || '');
  fs.writeFileSync(path.join(output, 'loop-results.json'), JSON.stringify(results, null, 2));
  assert.ok(results.every((r) => r.ok), 'Course loop checks failed; see .tmp-watch-tests/loop-results.json');
  console.log(`\n${results.length} course loop groups passed.`);
} finally {
  socket?.close();
  child.kill();
  server.closeAllConnections();
  server.close();
  await pause(300);
  const relative = path.relative(output, profile);
  if (!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('edge-loop-')) {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
    catch { console.warn('Temporary browser profile is still locked:', profile); }
  }
}
