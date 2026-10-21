/* 刷课：把整门课自动走一遍——目录逐节前进，每节切三个页签（元典阅读／视频讲义／章节测验），
   视频按所选倍速播完，阅读类停留，测验交给面板已有的 AI 识题＋填写。

   为什么顶层就能跨 iframe：content script 的隔离世界只隔离 JS 变量，DOM 是同一份。
   顶层拿 iframe.contentDocument 就能读里面播放器的状态、点里面的按钮 ——
   不需要 all_frames，也不需要 postMessage。超星层级固定是 学习页 → #iframe 章节卡 → 视频模块 iframe。

   为什么坚持走点击：直接写 video.playbackRate、反复 play() 和站点的 studyControl 拉扯，
   既容易被它重置，也更容易触发风控。点它自己的控件等于「用户手点」，行为最干净。
   进度真的推不动（站点按真实时长校验）就如实停下报告，不硬造完成状态。

   shortcut: 只处理站点自己暴露的三类任务点。视频以外的 PPT／文档类没有可靠的完成信号，
   就只是把页签打开停留几秒；站点若要求额外的「学完」确认按钮，这里不代点。 */
(function () {
  'use strict';
  const HW = (window.HW = window.HW || {});
  if (HW.Watch) return;

  const MAX_DEPTH = 6; // iframe 嵌套深度上限，够覆盖超星这三层
  const TICK = 500; // 视频守倍速／补点击的节奏
  const TAB_WAIT = 1800; // 点页签后等 iframe 重新加载
  const NODE_WAIT = 3500; // 点目录项后等 AJAX 换页
  const VIDEO_WAIT = 12000; // 进视频页后等 <video> 出现
  const DWELL_TEXT = 4000; // 阅读／PPT 类停留时长
  const QUIZ_TIMEOUT = 240000; // 一道测验最多等多久（AI 识题＋逐题填写）
  const MAX_KICK_FAIL = 5; // 连续几次点不起播放就停手，不跟播放器拉扯

  const STOP = { stop: true };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtRate = (n) => String(Math.round(n * 100) / 100);

  /* 本页 + 所有同源 iframe 的 document（跨域读不到的跳过） */
  function docs() {
    const out = [];
    const walk = (doc, depth) => {
      if (!doc || depth > MAX_DEPTH) return;
      out.push(doc);
      for (const f of doc.querySelectorAll('iframe')) {
        let d = null;
        try { d = f.contentDocument; } catch { d = null; }
        if (d) walk(d, depth + 1);
      }
    };
    walk(document, 0);
    return out;
  }

  const allVideos = () => docs().flatMap((d) => [...d.querySelectorAll('video')]);
  function finishedVideo(v) {
    try {
      let frame = v.ownerDocument.defaultView.frameElement;
      for (let n = 0; frame && n < MAX_DEPTH; n++) {
        if (frame.closest('.ans-job-finished')) return true;
        frame = frame.ownerDocument.defaultView.frameElement;
      }
    } catch { /* 跨域父框架不作为完成依据 */ }
    return false;
  }
  const pendingVideos = () => allVideos().filter((v) => !finishedVideo(v));
  /* 不能只看 offsetParent：position:fixed（站点弹层「确认提交？」就是）的 offsetParent
     恒为 null，会被当成不可见而漏掉（真实页面 2026-10-20 实测，白等 12 次确认框）。 */
  function visible(el) {
    if (!el || !el.getClientRects().length) return false;
    const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
    return !cs || (cs.display !== 'none' && cs.visibility !== 'hidden');
  }

  /* 跨所有同源 document 找第一个可见的匹配元素（播放器控件在视频模块 iframe 里） */
  function pick(sel, root) {
    for (const d of root ? [root] : docs()) {
      const el = d.querySelector(sel);
      if (visible(el)) return el;
    }
    return null;
  }

  /* 正在用的那个视频。先认已经加载出时长的，再退一步认「所在文档里有播放器 UI」的。
    不能只看有没有 <video>：PDF／文档任务点里也常驻一个没源的 <video>
    （readyState=0、duration 非有限值），算进来会让 classify() 误判成视频页，
    然后一直点不起播放（真实页面 2026-10-19 实测过）。
    也不能只认已加载的：preload=none 的视频在用户点播放前就是 readyState=0，
    真实视频页会被当成没有视频。播放器 UI 才是「这是视频任务点」的可靠信号。 */
  /* 元数据已就绪、值得守着看的视频（PDF／文档页里那个没源的 <video> 不算） */
  const usable = (v) => v.readyState > 0 || v.currentTime > 0 || (isFinite(v.duration) && v.duration > 0);

  const PLAYER_UI = '.video-js,.vjs-tech,.vjs-big-play-button,.vjs-playback-rate';
  function findVideo(ended) {
    /* 播完的（ended）不再认：一个页签里可能不止一个视频任务点（阅读卡里两幅画
       各带一个介绍短片，2026-10-20 实测），第一个播完要接着看第二个，
       不能抱着已结束的那个反复 kick 重播。 */
    const list = pendingVideos().filter((v) => !v.ended && !ended?.has(v));
    for (const v of list) {
      if (usable(v)) return v;
    }
    for (const v of list) {
      try {
        if (v.ownerDocument.querySelector(PLAYER_UI)) return v;
      } catch { /* 跨域文档跳过 */ }
    }
    return null;
  }

  /* 阅读卡里的视频任务点角标（<span class="ans-job-icon ans-job-video …">）。
     2026-10-20 实测：2.2「元典阅读」卡里有两个，是两幅画作的介绍短片，
     刷课脚本当时只停留 4 秒就走，任务点永远不计（目录里 2.2 一直剩 1）。 */
  function videoJobs() {
    const out = [];
    for (const d of docs()) {
      try { out.push(...d.querySelectorAll('.ans-job-icon.ans-job-video')); } catch { /* 跨域文档跳过 */ }
    }
    return out;
  }

  /* 这一页签里的视频任务点是否全都完成了。站点自己的判定法（hw-debug 导出里
     站点脚本 jobflag() 就是这么算的）：.ans-job-icon 的父元素挂 .ans-job-finished
     即已完成。一节里剩的那 1 个任务点常常是第 4 个页签「本章讨论」，视频早就
     看完了——不查这个的话每路过一次都要把十几分钟的视频重看一遍
     （5.3 节 2026-10-20 实测）。没有角标可看时返回 false，不乱猜，照常播。 */
  function videoJobsDone() {
    const jobs = videoJobs();
    if (!jobs.length) return false;
    return jobs.every((ic) => !!(ic.parentElement && ic.parentElement.classList.contains('ans-job-finished')));
  }

  /* 阅读卡的短视频是懒加载的，不滚到跟前它连 <iframe> 都不放出来。
     逐个滚到任务点跟前（最后停在最后一个），给它们一个机会冒出来。 */
  function revealJobs() {
    const icons = videoJobs().filter((ic) => !ic.parentElement.classList.contains('ans-job-finished'));
    icons.forEach((ic, i) => {
      setTimeout(() => {
        try { ic.scrollIntoView({ block: 'center' }); } catch { /* 已换页 */ }
      }, i * 400);
    });
    return icons.length;
  }

  /* ---------------- 目录：把课程所有任务点按页面顺序列出来 ---------------- */

  /* 站点写法是 getTeacherAjax('267020767','154541991','1244073642')，
     三个参数都带引号；早期页面有不带的，所以引号一律可选。 */
  const chapterIdOf = (onclick) => {
    const m = /getTeacherAjax\(\s*['"]?\d+['"]?\s*,\s*['"]?\d+['"]?\s*,\s*['"]?(\d+)/.exec(onclick || '');
    return m ? m[1] : null;
  };

  function nodes() {
    const out = [];
    const seen = new Set();
    for (const span of document.querySelectorAll('.posCatalog_name')) {
      const id = chapterIdOf(span.getAttribute('onclick'));
      if (!id || seen.has(id)) continue; // 分组标题没有 onclick，天然被排除
      seen.add(id);
      /* 有的课把「已完成」三个字直接接在节点名后面，课名要切掉，否则日志里读着别扭 */
      const name = (span.getAttribute('title') || span.textContent || '')
        .replace(/\s*已完成\s*$/, '').replace(/\s+/g, ' ').trim();
      out.push({ id, span, name });
    }
    return out;
  }

  /* 这一节还剩几个任务点没完成。站点自己写在目录项里，是「刷完别再刷」最可靠的依据——
     比本地记账准，换设备也认。两种写法都要认（真实页面 2026-10-19 导出里两种并存）：
     ① <input type="hidden" class="jobUnfinishCount" value="N">，可能不止一个，要相加；
     ② 整节做完时站点不写这个 input，只留 <span class="orangeNew">0</span> 角标。
     两个都没有就是「不知道」，返回 null —— 不能当成 0（纯阅读节、旧版目录都没有角标）。
     站点每次换节会重建目录树，所以不能缓存节点，必须按 id 现查。 */
  function unfinishedOf(id) {
    const sel = document.getElementById('cur' + id);
    if (!sel) return null;
    const inputs = sel.querySelectorAll('.jobUnfinishCount');
    let total = 0;
    for (const inp of inputs) {
      if (!/^\d+$/.test(String(inp.value).trim())) return null;
      total += Number(inp.value);
    }
    if (inputs.length) return total;
    const badge = sel.querySelector('.orangeNew');
    if (badge && /^\d+$/.test((badge.textContent || '').trim()) && Number(badge.textContent.trim()) > 0) return Number(badge.textContent.trim());
    /* ③ 有的课（真实页面 2026-10-20「中国共产党简史」实测）既不给 input 也不给角标，
       整节做完只挂一个 <span class="icon_Completed prevTips"><span class="prevHoverTips">已完成<i></i></span></span>——
       这是那里唯一的完成信号。注意不能反过来用「有数字就算没做完」：纯阅读节本来就没有数字。 */
    if (sel.querySelector('.icon_Completed')) return 0;
    return null;
  }

  /* 点目录里第 id 节。目录树会被站点整段重建，早先拿到的 span 可能已经脱离文档，
     所以每次都按 id 重新找 —— 点脱离文档的元素什么也不会发生。 */
  function clickNode(id) {
    const sel = document.getElementById('cur' + id);
    const target = (sel && sel.querySelector('.posCatalog_name')) || sel;
    if (!target) return false;
    try { target.click(); } catch { return false; }
    return true;
  }

  /* 当前激活的章节 id：站点换节成功后会给自己加 posCatalog_active，这是最可靠的信号 */
  function activeChapterId() {
    const act = document.querySelector('#coursetree .posCatalog_select.posCatalog_active');
    return act && act.id ? act.id.replace(/^cur/, '') : null;
  }

  const tabList = () => [...document.querySelectorAll('.prev_ul li[id^="dct"]')];

  /* 估算剩余时长（用户 2026-10-20 要求：面板上要能看到「预计还要多久」）。
     做法：目录里每节的 jobUnfinishCount 总和 = 剩余任务点数；按 3 个任务点/节、
     平均每节 8 分钟估。只是给用户一个预期，不是承诺——视频长短差异很大，
     站点没把每个视频的时长暴露给目录树，精确不了。 */
  function remainingJobs() {
    let total = 0;
    for (const n of nodes()) {
      const u = unfinishedOf(n.id);
      if (u) total += u;
    }
    return total;
  }
  function fmtLeft(sec) {
    if (!isFinite(sec) || sec <= 0) return '快了';
    if (sec < 60) return '不到 1 分钟';
    const m = Math.round(sec / 60);
    if (m < 60) return `约 ${m} 分钟`;
    const h = Math.floor(m / 60);
    return `约 ${h} 小时 ${m % 60 ? (m % 60) + ' 分' : ''}`.trim();
  }
  const courseTimeKey = (course) => 'watchTime:' + course.key + '|' + (course.cpi || '');
  function estimateCourseSeconds(course, speed = 2, timing) {
    const known = Number.isFinite(course.done) && Number.isFinite(course.total);
    if (known && (course.done < 0 || course.total < course.done)) return null;
    const jobs = known ? course.total - course.done : timing?.remainingJobs;
    if (!Number.isFinite(jobs) || jobs < 0) return null;
    if (!jobs) return 0;
    // 未采到实际耗时前沿用原有粗估：2 倍速约 4 分钟/任务点。
    const secondsPerJob = timing?.jobs > 0 && timing.seconds > 0 ? timing.seconds / timing.jobs : 480;
    return jobs * secondsPerJob / Math.max(0.25, Number(speed) || 2);
  }
  function courseProgress() {
    const list = nodes();
    const counts = list.map(n => unfinishedOf(n.id));
    return list.length && counts.every(n => n !== null) ? { remainingJobs: counts.reduce((sum, n) => sum + n, 0) } : null;
  }
  async function rememberCourseProgress() {
    const course = currentCourse(), progress = courseProgress();
    if (!course || !progress) return;
    const key = courseTimeKey(course);
    const stored = await chrome.storage.local.get(key);
    courseTiming = { ...stored[key], ...progress };
    if (stored[key]?.remainingJobs === progress.remainingJobs) return;
    await chrome.storage.local.set({ [key]: courseTiming });
  }
  const tabActive = (li) => li.classList.contains('active');

  /* ---------------- 课程列表页：把这一页的课都列出来 ----------------
     列表页的卡片是站点自己用 JS 渲染的，抓源码什么都抓不到，只能读 DOM。
     每门课有两个同名链接（封面 + 课程名），按 courseid+clazzid 去重，取文字最长的那个当课名。
     链接里的 cpi 每门课可能不一样（实测有 492223855 / 494419162 两种），必须逐卡片取。 */
  function courseLinks() {
    const out = [];
    const byKey = new Map();
    for (const a of document.querySelectorAll('a[href*="stucoursemiddle"]')) {
      let u;
      try { u = new URL(a.href, location.href); } catch { continue; }
      const courseid = u.searchParams.get('courseid');
      const clazzid = u.searchParams.get('clazzid');
      if (!courseid || !clazzid) continue;
      /* 已结束 / 已退课的课整块在 #isState 里（2026-10-20 实测：这块 36 个链接、在学的 46 个），
         整块跳过最省事，也不依赖文案。 */
      if (a.closest('#isState')) continue;
      const key = courseid + '|' + clazzid;
      const text = (a.getAttribute('title') || a.textContent || '')
        .replace(/\s+/g, ' ').trim()
        .replace(/\s*(置顶|示范教学包)$/, ''); // 卡片角标会混进标题里
      /* 卡片里还有个「课程已结束」的同款链接（href 一样、文字是状态），它不是课程名 */
      if (/^(课程已结束|已退课)$/.test(text)) continue;
      /* 卡片范围要收得够紧：一旦 closest() 命中外层容器（class 里带 course_card 的列表），
         容器文字里会同时包含底部「已结束课程」区块，导致整页课程全被当成已结束筛掉。
         真实站点（2026-10-20 实测）每张卡片是 <div class="course clearfix learnCourse" id="c_<id>">，
         里面套 .course-info，所以认 div.course；没有这种结构的旧列表退回 parentElement。 */
      const card = a.closest('li,div.course') || a.parentElement || a;
      const cardText = (card.textContent || '').replace(/\s+/g, ' ').trim();
      if (/课程已结束|已退课/.test(cardText)) continue; // 结束/退课的课不刷
      const prog = /(\d+)\s*\/\s*(\d+)/.exec(cardText);
      const cpi = u.searchParams.get('cpi') || '';
      const item = {
        key, courseid, clazzid, cpi,
        entryUrl: a.href,
        name: text,
        done: prog ? Number(prog[1]) : null,
        total: prog ? Number(prog[2]) : null,
        // 直接打开这个页能在顶层读到目录树（不需要 enc），进去后再点节点
        scUrl: `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse?courseid=${courseid}&clazzid=${clazzid}`
          + (cpi ? `&cpi=${cpi}` : '') + '&ut=s',
      };
      const prev = byKey.get(key);
      if (!prev) { byKey.set(key, item); out.push(item); }
      else if (item.name.length > prev.name.length) Object.assign(prev, { name: item.name, done: item.done, total: item.total });
    }
    return out.filter((c) => c.name);
  }

  /* 课程目录页（studentcourse）：站点把目录画成 .catalog_title，id 在 aria-labelledby="tab_cur<id>"
     或 checkbox 的 value 上；已完成状态是 .catalog_state.icon_yiwanc。
     这一页的目录在顶层就能读（不像 mycourse/stu 那页塞在跨域 iframe 里）。 */
  function catalogEntries() {
    const out = [];
    for (const t of document.querySelectorAll('.catalog_title')) {
      const a = t.querySelector('a.clicktitle');
      if (!a) continue;
      const box = t.querySelector('input[name="checkbox"]');
      const lbl = t.getAttribute('aria-labelledby') || '';
      const id = (box && box.value) || lbl.replace(/^tab_cur/, '');
      if (!/^\d+$/.test(id || '')) continue;
      out.push({
        id,
        name: (a.textContent || '').replace(/\s+/g, ' ').trim(),
        done: !!t.querySelector('.catalog_state.icon_yiwanc'),
        anchor: a,
      });
    }
    return out;
  }

  /* 进课程：点目录里第一个没做完的节点（真实点击，和用户自己点一样） */
  function enterCourse() {
    const list = catalogEntries();
    const next = list.find((n) => !n.done);
    if (!next) return null;
    try { next.anchor.click(); } catch { return null; }
    return next;
  }

  /* 当前页面是哪一种：列表页 / 课程目录页 / 章节学习页 / 其它 */
  function pageKind() {
    if (document.querySelector('.posCatalog_name')) return 'study';
    if (document.querySelector('a.clicktitle')) return 'catalog';
    if (document.querySelector('a[href*="stucoursemiddle"]')) return 'courses';
    /* 有的课目录页是空壳（真实站点只给「已完成任务点: 0/0」+「新建课程目录」，一个节点都没有），
       这种页按地址认，否则排队会卡在这一页永远不动。 */
    if (/\/mycourse\/studentcourse/.test(location.pathname)) return 'catalog';
    return 'other';
  }

  /* 当前学习页属于哪门课。单课程模式也要走后台排队：点目录会整页导航，
     页面里的刷课状态跟着一起没了（真实页面 2026-10-20 实测），
     交给后台存队列，新页面加载后 resumeQueued() 才接得上。 */
  function currentCourse() {
    let u;
    try { u = new URL(location.href); } catch { return null; }
    const courseid = u.searchParams.get('courseId') || u.searchParams.get('courseid');
    const clazzid = u.searchParams.get('clazzid');
    if (!courseid || !clazzid) return null;
    const cpi = u.searchParams.get('cpi');
    return {
      key: courseid + '|' + clazzid,
      cpi: cpi || '',
      name: (document.title || '').replace(/\s+/g, ' ').trim() || courseid,
      scUrl: 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse?courseid=' + courseid +
        '&clazzid=' + clazzid + (cpi ? '&cpi=' + cpi : '') + '&ut=s',
    };
  }

  /* ---------------- 多门课排队 ----------------
     每跳一次页面，这个脚本就重新加载一遍，内存里的东西全丢。
     所以队列交给后台 service-worker 存，每到一个页面就问它一句「我该干什么」：
     列表页 → 进第一门勾的课；课程目录页 → 点第一个没做完的节点；章节学习页 → 逐节刷。
     一门课走完再让后台跳到下一门。全程还是点站点自己的链接。 */
  let multi = null;

  async function askQueue() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'HW_WATCH_QUEUE_GET' });
      if (r && r.ok && r.queue && r.queue.courses && r.queue.courses.length) return r.queue;
    } catch { /* 后台没响应就当没有队列，当普通页面处理 */ }
    return null;
  }

  async function reportCourseDone(key) {
    try { await chrome.runtime.sendMessage({ type: 'HW_WATCH_COURSE_DONE', payload: { key } }); }
    catch { /* 后台不在就只能停在这里 */ }
  }

  /* 等某个条件成立（页面是 JS 画的，脚本跑起来时目录常常还没渲染出来） */
  async function until(fn, ms) {
    const dl = Date.now() + ms;
    while (Date.now() < dl) {
      const v = fn();
      if (v) return v;
      await wait(300);
    }
    return null;
  }

  /* 页面加载后自动接着干：这是「全自动」的关键一步，不需要用户再点。
     opts 里可以带面板的回调，这样连播时状态行和日志照样动。 */
  async function resumeQueued(opts) {
    const q = await askQueue();
    if (!q) return false;
    multi = q;
    if (/\/mycourse\/stu$/.test(location.pathname)) {
      const tab = await until(() => [...document.querySelectorAll('a,button,li,span,div')]
        .find(el => visible(el) && el.textContent.replace(/\s+/g, ' ').trim() === '章节'), 12000);
      if (tab) tab.click();
      const frame = await until(() => [...document.querySelectorAll('iframe')].find(f => {
        try { return /\/mycourse\/studentcourse$/.test(new URL(f.src, location.href).pathname); } catch { return false; }
      }), 12000);
      if (frame) {
        const result = await chrome.runtime.sendMessage({ type: 'HW_WATCH_OPEN_CATALOG', payload: { url: frame.src } });
        if (!result?.ok) opts?.onNote?.('课程目录未能打开，保留队列：' + (result?.error || '页面未就绪'));
      } else opts?.onNote?.('课程首页没有加载章节目录，保留队列，请手动打开章节');
      return true;
    }
    // 章节目录常在 document_idle 之后才由站点画出来，不能把暂时的 other 当成不用接续。
    const kind = await until(() => {
      const k = pageKind();
      return k === 'study' || k === 'catalog' ? k : null;
    }, 15000);
    if (kind === 'catalog') {
      const next = await until(() => enterCourse(), 12000);
      if (!next) await reportCourseDone(q.courses[q.index] && q.courses[q.index].key);
      return true;
    }
    if (kind === 'study') {
      const ok = await until(() => nodes().length > 0, 15000);
      if (!ok) {
        const o = opts || {};
        if (o.onNote) o.onNote('这一页没等到目录，保留队列，请刷新后接续');
        return true;
      }
      start({ rate: q.rate, autoRate: q.autoRate, onLive: opts && opts.onLive, onNote: opts && opts.onNote, onStop: opts && opts.onStop });
      return true;
    }
    return false;
  }

  /* ---------------- 视频：守倍速 + 点播放 + 等播完 ---------------- */

  let lastKick = 0;
  let kickFails = 0;
  let lastRateTry = 0;
  let rateBusy = false;
  let menuSupport = null; // null=还没确认；true=菜单里有这档；false=没有
  let seekTried = false; // 每个视频只试一次「能不能拖进度条」
  let menuClickedRate = 0; // 已经用播放器菜单切到过的档位，用来避免反复点菜单

  /* 找倍速菜单里对应的那一项。菜单项文本形如 "2x" / "1.5x" / "1x, 选择"，
     字幕那几项的文本以中文开头，正则匹配不到，不会点错。
     只认展开后看得见的项：菜单没打开时 videojs 里的项点在隐藏容器里，点了不算数。 */
  function menuItem(want, root) {
    for (const d of root ? [root] : docs()) {
      let items;
      try { items = d.querySelectorAll('.vjs-menu-item'); } catch { continue; }
      for (const li of items) {
        const m = /^([\d.]+)\s*x/i.exec((li.textContent || '').trim());
        if (m && Math.abs(Number(m[1]) - want) < 0.01 && visible(li)) return li;
      }
    }
    return null;
  }

  /* 播放器菜单里最高的一档（多数课 2x）。菜单没打开时项在隐藏容器里也照样能读文本，
     所以这里不看 visible —— 用户要的是先问播放器「你最高多少」。 */
  function menuMaxRate(root) {
    let max = 0;
    for (const d of root ? [root] : docs()) {
      let items;
      try { items = d.querySelectorAll('.vjs-menu-item'); } catch { continue; }
      for (const li of items) {
        const m = /^([\d.]+)\s*x/i.exec((li.textContent || '').trim());
        if (m) max = Math.max(max, Number(m[1]));
      }
    }
    return max;
  }

  /* 切倍速：优先点播放器自己的菜单项（等于用户手点一遍），菜单里没这档才退回写 playbackRate。
     autoRate 时不看用户选的数字，直接跟播放器菜单里最高那一档走——
    多数课只给到 2x，选 4x 没有意义（用户 2026-10-19 反馈）。 */
  async function applyRate(v) {
    if (!v || v.ended) return;
    if (autoRate) {
      const m = menuMaxRate(v.ownerDocument);
      if (m && Math.abs(m - rate) > 0.01) rate = m;
    }
    if (Math.abs(v.playbackRate - rate) < 0.01) return; // 已经是目标倍速
    /* 想用播放器自己的菜单切一次（等于用户手点一遍），但每种倍速只点一次：
       点过之后再被播放器重置就直接写 playbackRate —— 既不会每轮都把菜单弹出来，
       又能守住倍速（videojs 换源后会把 rate 打回 1，那时菜单项也已经是选中态，点了没用）。 */
    const wantMenu = menuSupport !== false && Math.abs(menuClickedRate - rate) > 0.01;
    // 菜单路线：限速 2.5s 一次，免得每 500ms 把播放器菜单弹一遍
    if (wantMenu && !rateBusy && Date.now() - lastRateTry >= 2500) {
      lastRateTry = Date.now();
      rateBusy = true;
      let toggle = null;
      let opened = false;
      let clicked = false;
      try {
        toggle = pick('.vjs-playback-rate', v.ownerDocument);
        if (!toggle) {
          menuSupport = false; // 这个播放器没有倍速菜单，别再找了
        } else {
          let item = menuItem(rate, v.ownerDocument); // 菜单本来就开着
          if (!item) {
            try { toggle.click(); } catch { /* 控件可能正被重建 */ }
            opened = true;
            await wait(150);
            item = menuItem(rate, v.ownerDocument);
          }
          if (item) {
            menuSupport = true;
            clicked = true;
            menuClickedRate = rate;
            try { item.click(); } catch { /* 同上 */ }
            await wait(150);
          } else {
            menuSupport = false; // 站点菜单里确实没有这一档
          }
        }
      } finally {
        rateBusy = false;
      }
      if (!on || v.ended) return;
      if (Math.abs(v.playbackRate - rate) < 0.01) return; // 点菜单就生效了
      if (opened && !clicked && toggle) { try { toggle.click(); } catch { /* 菜单关不上就算了 */ } }
    }
    try { v.playbackRate = rate; } catch { /* 个别内核拒绝超范围值，下轮再试 */ }
  }

  /* 让视频播起来：只点播放器自己的播放按钮（用户手点的等价动作）。
     浏览器在「没有用户手势」的页面（比如脚本自己 F5 之后）会拦掉 play()，
     这时点多少遍都没用，所以连续失败到上限就停手、只提示一次，不再每 2 秒弹一条
    （真实页面 2026-10-20 实测：F5 后连刷 9 条「视频点不起来」）。 */
  function kick(v) {
    if (!v || v.ended || !v.paused) return;
    if (kickFails >= MAX_KICK_FAIL) return; // 已经放弃这一节，别再点
    if (Date.now() - lastKick < 1500) return; // tick 很密，别一直重试
    lastKick = Date.now();
    try { v.muted = muted; } catch { /* 静音设不上也不影响后面点按钮 */ }
    const btn = pick('.vjs-big-play-button', v.ownerDocument) || pick('.vjs-play-control', v.ownerDocument);
    if (btn) { try { btn.click(); } catch { /* 控件可能正好被重建，忽略 */ } }
    setTimeout(() => {
      if (!on || !v.paused) { kickFails = 0; return; }
      if (++kickFails >= MAX_KICK_FAIL) {
        note('视频点不起来：请在页面里点一下播放（这一节先跳过）');
        return;
      }
      try {
        const p = v.play();
        if (p) p.catch(() => { /* 还是被拦就只能等用户手点 */ });
      } catch { /* 直接调也失败就只能等用户手点 */ }
    }, 900);
  }

  /* 播放器自己的暂停：播放中那个按钮的类名仍是 vjs-play-control，文本/aria-label 是「暂停」。
     点不动才退回 v.pause()——暂停不是绕过站点逻辑，只是本地播放状态。 */
  function pauseVideo(v) {
    if (!v || v.paused) return;
    for (const d of [v.ownerDocument]) {
      let btns;
      try { btns = d.querySelectorAll('.vjs-play-control'); } catch { continue; }
      for (const b of btns) {
        const t = (b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '');
        if (/暂停|pause/i.test(t) && visible(b)) {
          try { b.click(); } catch { /* 忽略 */ }
          if (v.paused) return;
        }
      }
    }
    try { v.pause(); } catch { /* 停不了就算了 */ }
  }

  function pauseAll() {
    for (const v of allVideos()) pauseVideo(v);
  }

  function setMuted(value) {
    muted = !!value;
    for (const v of allVideos()) v.muted = muted;
  }

  /* 有些课的进度条是能拖的：站点只看「看过」，不逐秒校验时长。
     试一次跳到最后，1.2 秒后看有没有被弹回去——弹回去就是不让拖，老老实实播完。
     每个视频只试一次，免得跟 seekBarControl 插件反复拉扯。 */
  async function maybeSeek(v) {
    if (seekTried || !v || !isFinite(v.duration) || v.duration < 60) return;
    seekTried = true;
    const ctrl = pick('.vjs-progress-control', v.ownerDocument);
    if (!ctrl) return;
    if (ctrl && /vjs-disabled/.test(ctrl.className)) return; // 站点自己把进度条禁了
    const target = v.duration * 0.98;
    const bar = ctrl.querySelector('.vjs-progress-holder') || ctrl;
    const rect = bar.getBoundingClientRect();
    if (!rect.width) return;
    const Mouse = v.ownerDocument.defaultView.MouseEvent;
    const point = { bubbles: true, clientX: rect.left + rect.width * 0.98, clientY: rect.top + rect.height / 2, button: 0 };
    for (const type of ['mousedown', 'mouseup', 'click']) bar.dispatchEvent(new Mouse(type, point));
    await step(1200);
    if (v.currentTime >= target - 3) note('这一节能拖进度条，已跳到最后');
    else note('这一节不让拖进度条，正常播完');
  }

  /* ---------------- 页签：切到第 n 个，并等它加载完 ---------------- */

  async function goto(tabIndex) {
    const li = tabList()[tabIndex];
    if (!li) return false;
    if (!tabActive(li)) {
      try { li.click(); } catch { return false; }
      await step(TAB_WAIT);
    } else {
      await step(300);
    }
    let frame = document.querySelector('#iframe');
    if (!frame) return true;
    const chapter = activeChapterId();
    const deadline = Date.now() + 45000;
    while (on && Date.now() < deadline) {
      frame = document.querySelector('#iframe');
      let card;
      try { card = frame?.contentDocument; } catch { /* 等待同源章节卡片 */ }
      if (card?.body && card.readyState === 'complete') {
        const url = new URL(card.URL, location.href);
        const expected = new URL(frame.src || location.href, location.href);
        if (frame.hasAttribute('srcdoc') || !expected.pathname.includes('/knowledge/cards') ||
            (url.pathname.includes('/knowledge/cards') && url.searchParams.get('knowledgeid') === chapter && Number(url.searchParams.get('num')) === tabIndex)) {
          return true;
        }
      }
      await step(300);
    }
    note(`页签「${li.textContent.trim()}」尚未加载完成，不把它算作已处理`);
    return false;
  }

  /* 当前页签里是什么任务点。ended 的视频也算视频页：findVideo() 把它挪开是为了
     接着守第二个，但分类上它仍是视频任务点，交回 watchVideo 用 everEnded 收尾。 */
  function classify() {
    if (findVideo() || allVideos().some((v) => v.ended)) return 'video';
    const QUIZ = '.questionLi,.TiMu,.Zy_TItle,.exam-question,.mark_item,input[name^="answer"]';
    for (const d of docs()) {
      try {
        if (d.querySelector(QUIZ)) return 'quiz';
      } catch { /* 跨域文档跳过 */ }
    }
    return 'text';
  }

  /* ---------------- 主循环 ---------------- */

  let on = false;
  let gen = 0; // 每次 start/stop 自增：旧循环发现代号变了就自己退出
  let rate = 2;
  let courseTiming = null;
  let autoRate = false; // 倍速跟播放器菜单里最高档走，不看用户选的数字
  let muted = true;
  let guard = 0; // 只在看视频时开着的守倍速定时器
  let stopGuard = 0; // 停止后守 5 秒，防止站点自己把播放接回去
  let live = () => {};
  let note = () => {};
  let onStop = () => {};

  /* 可中断的等待：停止后立刻抛出去，避免脚本停不下来 */
  async function step(ms) {
    const my = gen;
    await wait(ms);
    if (!on || my !== gen) throw STOP;
  }

  async function watchVideo() {
    const deadline = Date.now() + VIDEO_WAIT;
    const chapter = activeChapterId();
    /* findVideo() 会把 ended 的视频挪开，所以 ended 状态要从原始列表里看，
       否则播完那一刻起循环里就再也看不到 ended，只能干等超时（测试抓过）。
       只靠轮询还会漏：站点在 ended 后半秒内就自动重播的话，下一次轮询看到
       的又是没播完的状态，everEnded 永远置不上位，脚本陪着同一个视频无限
       重播（1.2 节 9:45 的视频实测连播 5 轮都不前进，2026-10-20）。
       所以同时挂 ended 事件监听，事件一定接得住。 */
    const endedEls = new Set(); // 播完过的视频元素，用来识别「同一个又重播」
    const hooked = new Set();
    let myGuard = 0;
    let everEnded = pendingVideos().some((v) => v.ended);
    const markEnded = (v) => { if (v) { endedEls.add(v); everEnded = true; } };
    const onEnded = (e) => markEnded(e.currentTarget);
    const hookEnded = () => {
      for (const v of pendingVideos()) {
        if (!hooked.has(v)) {
          hooked.add(v);
          v.addEventListener('ended', onEnded, { once: true });
        }
      }
    };
    for (const v of pendingVideos()) if (v.ended) markEnded(v);
    hookEnded();
    try {
      while (on && !findVideo(endedEls)) {
        if (everEnded || videoJobsDone()) return true;
        if (Date.now() > deadline) {
          note('这一节没出现视频，跳过视频页');
          return false;
        }
        await step(400);
      }
      clearInterval(guard);
      // 每次只操作尚未播完的视频，播放器控件限定在该视频的 iframe 中。
      myGuard = setInterval(() => {
        if (!on) return;
        const v = findVideo(endedEls);
        if (!v) return;
        if (v.paused) kick(v); else kickFails = 0;
        applyRate(v);
      }, TICK);
      guard = myGuard;
      let giveUpSince = 0;
      let current = null;
      let videoStarted = 0;
      while (on) {
        if (chapter && activeChapterId() !== chapter) return false;
        hookEnded();
        for (const v of pendingVideos()) if (v.ended) markEnded(v);
        const v = findVideo(endedEls);
        if (v) {
          if (v !== current) {
            current = v;
            giveUpSince = 0;
            videoStarted = Date.now();
            kickFails = 0; lastKick = 0; lastRateTry = 0;
            menuSupport = null; menuClickedRate = 0; seekTried = false;
            try { v.ownerDocument.defaultView.frameElement?.scrollIntoView({ block: 'center' }); } catch { /* 框架刚换页 */ }
          }
          if (!seekTried) await maybeSeek(v);
          const pct = v.duration ? Math.round((v.currentTime / v.duration) * 100) : 0;
          live(`${fmtRate(rate)}x ${pct}%`);
          await applyRate(v);
          /* 自动播放被浏览器拦掉时（脚本自己 F5 之后没有用户手势），点多少遍播放都
             没用。放弃后赶紧离开这一节，别把整门课堵在这儿（真实页面 2026-10-20 实测）。 */
          if (v.paused && kickFails >= MAX_KICK_FAIL && !(v.readyState === 0 && !v.error && Date.now() - videoStarted < 60000)) {
            if (!giveUpSince) giveUpSince = Date.now();
            else if (Date.now() - giveUpSince > 4000) {
              note('这一节自动播放被拦，跳过');
              return false;
            }
          } else {
            giveUpSince = 0;
          }
        } else {
          /* 没有可守的视频了：要么全部播完（返回成功），要么本来就没有（等不到）。
             everEnded 已由 ended 事件置位，不受轮询窗口漏检影响。 */
          if (everEnded || videoJobsDone()) return true;
          if (Date.now() > deadline) {
            note('这一节没出现视频，跳过视频页');
            return false;
          }
        }
        await step(TICK);
      }
    } finally {
      clearInterval(myGuard);
      if (guard === myGuard) guard = 0;
      for (const v of hooked) v.removeEventListener('ended', onEnded);
    }
    return false;
  }

  /* 在所有同源文档里按文案找一个可见按钮。跨 iframe 的按钮坐标不可靠，
     只能按名字找（真实页面 2026-10-20：点坐标落在 iframe 边界上，点了没反应）。
     先只认真正的按钮元素，再退一步认 span/div —— 包装层点了往往没反应。 */
  const CLICKABLE = 'button,a,input[type="button"],input[type="submit"]';
  /* 超星的「确认提交？」弹层是 #workpop，里面那个确认按钮 id 是 popok，
     **文字写的是「提交」**（不是「确定」——UI 自动化把它的无障碍名读成「确定」，
     按文字找永远找不到，真实页面 2026-10-20 就是这样白等了 20 次）。 */
  function findConfirm() {
    for (const d of docs()) {
      let el = null;
      try { el = d.querySelector('#popok'); } catch { /* 换下一层文档 */ }
      if (el && visible(el)) return el;
    }
    for (const d of docs()) {
      let el = null;
      try { el = d.querySelector('#workpop .jb_btn_92, .maskDiv .jb_btn_92'); } catch { /* 同上 */ }
      if (el && visible(el)) return el;
    }
    return findButton(/^(确定|确认)$/);
  }

  function findButton(re) {
    for (const sel of [CLICKABLE, 'span,div']) {
      for (const d of docs()) {
        let list;
        try { list = d.querySelectorAll(sel); } catch { continue; }
        for (const el of list) {
          const raw = ((el.textContent || '') + ' ' + (el.value || '')).replace(/\s+/g, ' ').trim();
          if (!raw || raw.length > 12) continue; // 「提交」这类短文案，很长的容器跳过
          /* 站点的按钮文案里常夹空白与后缀（「确 定」「确认提交」），
             只按整串比会漏（真实页面 2026-10-20 就是弹着确认框却说没等到）。 */
          if (!re.test(raw) && !re.test(raw.replace(/\s+/g, ''))) continue;
          if (!visible(el)) continue;
          if (el.disabled) continue;
          return el;
        }
      }
    }
    return null;
  }

  /* 提交章节测验。不提交的话站点侧永远「任务点未完成」——填了也白填
     （真实页面 2026-10-20 实测：手动点「提交」→ 确认框「确定」后，
      页面立刻变「任务点已完成 / 章节测验 已完成」）。
     提交是站点自己的按钮，属于用户本来要做的一步，只是由脚本替他点。 */
  /* 这一节的测验是不是已经交过了。交过的页面没有「提交」按钮（站点直接把卷面换成
     「任务点已完成 / 已完成 / 查看已批阅作业」），不能把这种情况当失败
     （真实页面 2026-10-20 实测：2.2 节手动交过之后，全页 10 个文档里一个「提交」都没有）。 */
  function quizDone() {
    const t = docs().map((d) => d.body?.innerText || '').join(' ');
    if (/任务点已完成|查看已批阅|已交卷/.test(t)) return true;
    if (/已完成.{0,6}章节测验/.test(t)) return true;
    /* 交过卷的页面根本没有「提交」按钮，只剩「第1次作答本次成绩…」这类回执。
       所以「页面上没有『提交』又没有『待完成』」就当已经交过，别把已完成的节当成失败。 */
    if (!/待完成|任务点未完成|未交卷/.test(t) && !findButton(/^提交$/)) return true;
    return false;
  }

  function quizGrade() {
    for (const d of docs()) {
      if (d === document) continue;
      const text = d.body?.innerText || '';
      const score = text.match(/本次成绩\s*([\d.]+)\s*分/);
      const total = text.match(/满分\s*[:：]?\s*([\d.]+)/);
      if (score && total) return { score: Number(score[1]), total: Number(total[1]),
        question: d.querySelector('.TiMu .fontLabel,.mark_name')?.innerText || '',
        answer: text.split('我的答案：')[1]?.slice(0, 1200) || '' };
    }
    return null;
  }

  async function submitQuiz() {
    if (quizDone()) {
      note('测验页：这一节已经交过了，跳过提交');
      return true;
    }
    const btn = findButton(/^提交$/);
    if (!btn) {
      note('测验页：没找到「提交」按钮，这一节不算完成');
      return false;
    }
    try { btn.click(); } catch { note('测验页：提交按钮点不动'); return false; }
    live('测验页：提交中…');
    // 站点会弹一层「确认提交？」对话框，按钮是「确定」（不是「提交」）
    for (let i = 0; i < 20 && on; i++) {
      await step(500);
      const yes = findConfirm();
      if (yes) {
        try { yes.click(); } catch { /* 对话框可能刚被换掉 */ }
        await step(1500);
        const okText = docs().map((d) => d.body?.innerText || '').join(' ');
        if (/任务点已完成|已完成/.test(okText)) note('测验页：已提交，任务点已完成');
        else note('测验页：已点提交，结果请在页面上核对');
        return true;
      }
    }
    /* 没找到确认按钮时把现场留下来：真实的确认框在哪一层文档、按钮是什么标签，
       否则只能反复猜（真实页面 2026-10-20 就是弹着框却说没等到）。 */
    const seen = [];
    for (const d of docs()) {
      let list;
      try { list = d.querySelectorAll('button,a,span,div,input'); } catch { continue; }
      for (const el of list) {
        const t = ((el.textContent || '') + ' ' + (el.value || '')).replace(/\s+/g, ' ').trim();
        if (!t || t.length > 8 || !/确定|确认/.test(t)) continue;
        seen.push(el.tagName.toLowerCase() + ':' + t + (visible(el) ? '' : '(不可见)'));
        if (seen.length >= 6) break;
      }
      if (seen.length >= 6) break;
    }
    note('测验页：提交后没等到确认框，请手动核对' + (seen.length ? '｜候选 ' + seen.join(' / ') : '｜全页没有「确定」'));
    return false;
  }

  async function runQuiz() {
    if (quizDone()) {
      note('测验页：任务已完成，跳过答题');
      return true;
    }
    const P = HW.Panel;
    if (!P || typeof P.runHomework !== 'function') {
      note('测验页：面板没有暴露自动答题，跳过');
      return;
    }
    live('测验页：AI 答题中…');
    try {
      const r = await P.runHomework({ timeout: QUIZ_TIMEOUT });
      note('测验页：' + (r || '已填写'));
    } catch (e) {
      note('测验页：' + ((e && e.message) || e));
      stop();
      return false;
    }
    if (!on) return;
    await step(600);
    await submitQuiz();
  }

  /* ---------------- 本章讨论：替用户发一条相关的短帖（用户 2026-10-20 批准） ----------------
     讨论的输入框不在正文卡里，在顶层页右侧栏：点「讨论」页签（#tit2）后站点才用 AJAX
     把讨论列表拉进 #posDiscussScroll，每条讨论带一个 #discuss<id> textarea，提交按钮的
     onclick 里写着 addDiscussReply。没有列表时若「新建话题」按钮可用（.newTopic_bnt，
     老师只许自己发帖时站点自己把它藏掉），就走发新话题那条路
     （#toplevelTextCommentTitle / #toplevelTextCommentContent + addtopcomment）。
     全程只点站点自己的按钮、填站点自己的输入框，不直接发请求。 */
  const DISCUSS_KEY = 'hwDiscussed'; // 发过的章节 id 存 sessionStorage：F5 接力后也不重发

  function postedSet() {
    try { return new Set(JSON.parse(sessionStorage.getItem(DISCUSS_KEY) || '[]')); }
    catch { return new Set(); }
  }
  function rememberPosted(id) {
    try {
      const s = postedSet();
      s.add(String(id));
      sessionStorage.setItem(DISCUSS_KEY, JSON.stringify([...s]));
    } catch { /* 存不了就只靠本次运行的记忆 */ }
  }

  /* 帖子内容从讨论卡正文里的「思考与讨论」材料取一段，别发无关的口水话 */
  function discussMaterial() {
    for (const d of docs()) {
      let el = null;
      try { el = d.getElementById('discussTextArea'); } catch { /* 跨域文档跳过 */ }
      if (!el) continue;
      const t = ((d.body && d.body.innerText) || '').replace(/\s+/g, ' ').trim();
      const at = t.indexOf('思考与讨论');
      return at >= 0 ? t.slice(at + 6, at + 220) : t.slice(0, 220);
    }
    return '';
  }

  function setInputValue(el, val) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    try { Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val); } catch { el.value = val; }
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch { /* 旧站点没有 Event 构造器就算了 */ }
  }

  function discussText(cur, excerpt) {
    return `学习了「${cur.name}」这一节。` +
      (excerpt ? `材料里提到：${excerpt}。` : '') +
      '我的体会是：把这些道理放到自己的学习和生活里对照，从小事做起，慢慢就有自己的理解。';
  }

  async function runDiscuss(cur) {
    if (postedSet().has(String(cur.id))) {
      note(`讨论：这一节发过帖子了，不重复发：${cur.name}`);
      return;
    }
    const tit2 = document.querySelector('#tit2');
    if (!tit2) {
      note('讨论页：这一节没有讨论入口，跳过');
      return;
    }
    try { tit2.click(); } catch { note('讨论页：讨论入口点不动，跳过'); return; }
    /* 列表是 AJAX 拉的，等 #posDiscussScroll 里出现回复框（等不到就走发新话题） */
    const scroll = document.querySelector('#posDiscussScroll');
    const dl = Date.now() + 8000;
    while (on && Date.now() < dl) {
      await step(300);
      if (scroll && scroll.querySelector('textarea')) break;
    }
    if (!on) return;
    const excerpt = discussMaterial().slice(0, 150);
    const reply = scroll ? [...scroll.querySelectorAll('textarea')].find((t) => /^discuss\d+$/.test(t.id)) : null;
    if (reply) {
      const id = reply.id.replace(/^discuss/, '');
      /* 有的讨论要先点「回复」把输入区展开（replay(disid,...)），再填再提交 */
      const opener = [...document.querySelectorAll('#posDiscussScroll [onclick*="replay("]')]
        .find((el) => String(el.getAttribute('onclick') || '').includes(id));
      if (opener) {
        try { opener.click(); } catch { /* 展开不了就直接试输入框 */ }
        await step(500);
      }
      setInputValue(reply, discussText(cur, excerpt));
      let btn = null;
      for (const el of document.querySelectorAll('#posDiscussScroll [onclick*="addDiscussReply"]')) {
        if (new RegExp(`[(,]\\s*['"]?${id}['"]?`).test(String(el.getAttribute('onclick') || ''))) { btn = el; break; }
      }
      if (!btn) btn = findButton(/^(回复|提交)$/);
      if (!btn) {
        note('讨论页：没找到回复按钮，这一节没发');
        return;
      }
      try { btn.click(); } catch { note('讨论页：回复按钮点不动'); return; }
      await step(1200);
      rememberPosted(cur.id);
      note(`讨论：已在「${cur.name}」回复了一条讨论`);
      return;
    }
    const newBtn = document.querySelector('#content2 .newTopic_bnt');
    if (newBtn && visible(newBtn)) {
      try { newBtn.click(); } catch { note('讨论页：新建话题点不动'); return; }
      await step(600);
      const title = document.querySelector('#toplevelTextCommentTitle');
      const body = document.querySelector('#toplevelTextCommentContent');
      if (!title || !body) {
        note('讨论页：话题输入框没出现，跳过');
        return;
      }
      setInputValue(title, String(cur.name).slice(0, 50));
      setInputValue(body, discussText(cur, excerpt));
      const pub = document.querySelector('#content2 [onclick*="addtopcomment"]') || findButton(/^发布$/);
      if (!pub) {
        note('讨论页：没找到发布按钮，这一节没发');
        return;
      }
      try { pub.click(); } catch { note('讨论页：发布按钮点不动'); return; }
      await step(1500);
      rememberPosted(cur.id);
      note(`讨论：已在「${cur.name}」发了一条新话题`);
      return;
    }
    note('讨论页：这一节没有可发的讨论（可能只许老师发帖），跳过');
  }

  async function courseLoop(pass = 0) {
    const my = gen;
    const list = nodes();
    if (!list.length) {
      note('这个页面上没找到课程目录（需要停在章节学习页）');
      stop();
      return;
    }    /* 一律从目录第一节开始，不看当前打开的是哪一节：用户 2026-10-19 反馈
       他从第 43 节起刷，以为是随手挑的。从头刷完才是他要的。
       已经刷完的节（站点 jobUnfinishCount = 0）直接跳过，别让用户看着它重刷一遍。 */
    let i = 0;
    let skipped = 0;
    /* 预计剩余时间：剩余任务点 × 平均 4 分钟/个（视频平均 8 分钟÷2 个，粗估），
       从每节完成后的「已完成 i/N」一行里带出来给用户（用户 2026-10-20 要求）。
       startedAt = start() 的时刻，进度是按真实耗时算的，2x 倍速已经体现在里面。 */
    const startedAt = Date.now();
    const timingCourse = currentCourse();
    const timingKey = timingCourse && courseTimeKey(timingCourse);
    let timing = timingKey ? (await chrome.storage.local.get(timingKey).catch(() => ({})))[timingKey] : null;
    courseTiming = timing;
    const leftText = () => {
      const jobs = remainingJobs();
      if (!jobs) return '剩余：快了';
      const elapsed = (Date.now() - startedAt) / 1000;
      const done = Math.max(1, list.length ? (i + skipped) : 1);
      /* 按已完成节数摊均每节耗时，再乘剩余节数；没有历史就退回 4 分钟/任务点 */
      const perNode = i + skipped > 0 ? elapsed / done : 240;
      const left = unfinishedKnown() ? estimateCourseSeconds({ done: 0, total: jobs }, rate, timing) : (list.length - i) * perNode;
      return `剩余${fmtLeft(left)}（${jobs} 个任务点）`;
    };
    const unfinishedKnown = () => {
      for (const n of list) { if (unfinishedOf(n.id) !== null) return true; }
      return false;
    };
    note(`从第 1/${list.length} 节开始（从头刷）· ${leftText()}`);
    while (on && my === gen && i < list.length) {
      const cur = list[i];
      if (unfinishedOf(cur.id) === 0) {
        skipped++;
        i++;
        continue;
      }
      const jobsBefore = unfinishedOf(cur.id);
      const chapterStartedAt = Date.now();
      const nowId = activeChapterId();
      if (nowId !== cur.id) {
        live(`进入 ${cur.name}`);
        if (!clickNode(cur.id)) {
          note(`第 ${i + 1} 节目的项找不到了，停止`);
          stop();
          return;
        }
        const dl = Date.now() + NODE_WAIT;
        while (on && activeChapterId() !== cur.id && Date.now() < dl) await step(300);
        if (activeChapterId() !== cur.id) {
          note(`第 ${i + 1} 节没打开，停止`);
          stop();
          return;
        }
        await step(600);
      }
      // 三个页签依次过；有「本章讨论」页签（dct4）的节多走一个
      let jumped = false; // 页面转去了别的章节（站点自动下一节 / 用户手动点节）
      const tabs = tabList().length;
      for (let t = 0; t < tabs && on; t++) {
        if (!(await goto(t))) break;
        if (activeChapterId() !== cur.id) {
          /* 页面自己跳走了：站点看完视频自动进下一节（正常推进），或者用户手动
             点了目录里别的节。两种都认账——转去处理当前打开的这一节，别把
             用户点的那节跳过去（2026-10-20 用户反馈：他把页面调回 5.2，脚本
             却越过 5.2、5.3 直奔 5.4）。 */
          jumped = true;
          break;
        }
        const kind = classify();
        live(`${cur.name}｜${tabList()[t]?.textContent.trim() || '任务'}`);
        if (kind === 'video') {
          /* 视频早就看完、剩下的是「本章讨论」这类别的任务点的节，不重看视频——
             站点在任务点角标的父元素上挂 .ans-job-finished，照抄它的判定
             （5.3 节 2026-10-20 实测：每次路过都把 15 分钟的视频重看一遍）。 */
          if (videoJobsDone()) {
            note(`这一节视频都已完成，不重看：${cur.name}`);
          } else {
            const done = await watchVideo();
            if (!done) note('视频没播完就离开了');
            else note(`视频看完：${cur.name}`);
            await step(1200);
          }
          if (activeChapterId() !== cur.id) {
            jumped = true;
            break; // 站点自动进下一节
          }
        } else if (kind === 'quiz') {
          await runQuiz();
          await step(800);
        } else if (/讨论/.test(tabList()[t]?.textContent || '')) {
          /* 第 4 个页签是「本章讨论」：替用户发一条相关短帖（用户 2026-10-20 批准）。
             发完站点自己会刷新任务点数；判过「发过」的节直接跳过不重发。 */
          await runDiscuss(cur);
          await step(600);
        } else {
          /* 阅读卡里可能嵌着视频任务点（两幅画各带一个介绍短片，2026-10-20 实测），
             只停留 4 秒就走的话任务点永远不计。先滚动把懒加载的视频带出来，
             出现了就走视频流程播完；真没有才纯停留。 */
          if (videoJobs().length && !videoJobsDone()) {
            if (revealJobs() && (await watchVideo())) note(`阅读页里的视频看完：${cur.name}`);
            else note('阅读页里的视频没播完就离开了');
            await step(1200);
          } else {
            await step(DWELL_TEXT);
          }
        }
      }
      if (jumped) note('页面自动换章，按目录继续；未完成任务会在收尾时补查');
      i++;
      /* 每节走完复查一遍任务点数：站点说这节还剩几个就直接告诉用户，别让
         「日志说刷完了、角标还挂着 1」这种对不上（12.4 节 2026-10-20 实测：
         三页签都过完了，角标还剩 1——那一节的讨论任务点根本没发出去）。
         不自动重刷：重刷大概率卡在同一处，先把真相记进日志。 */
      const left = unfinishedOf(cur.id);
      if (on && my === gen && timingKey && jobsBefore !== null && left !== null && jobsBefore > left) {
        timing = { ...timing, jobs: (timing?.jobs || 0) + jobsBefore - left,
          seconds: (timing?.seconds || 0) + (Date.now() - chapterStartedAt) / 1000 * rate };
      }
      const progress = courseProgress();
      if (on && my === gen && timingKey && progress) {
        timing = { ...timing, ...progress };
        courseTiming = timing;
        await chrome.storage.local.set({ [timingKey]: timing }).catch(() => {});
      }
      if (left > 0) note(`注意：${cur.name} 还剩 ${left} 个任务点没完成（本节日志见上），稍后整课过完会再从第一节补刷`);
      live(`已完成 ${i}/${list.length} 节 · ${leftText()}`);
    }
    if (on && my === gen) {
      note(`本轮目录已检查（跳过已完成 ${skipped} 节）`);
      const pending = nodes().filter((n) => unfinishedOf(n.id) > 0);
      const remain = pending.reduce((sum, n) => sum + unfinishedOf(n.id), 0);
      if (remain > 0) {
        if (pass === 0) {
          note(`还剩 ${remain} 个任务点，再从第一节补刷一遍…`);
          live('补刷中…');
          return courseLoop(1);
        }
        stop();
        note(`仍有 ${remain} 个任务点未完成：${pending.map((n) => n.name).join('、')}，保留队列，不报完成`);
        live(`剩余 ${remain} 个任务点，请核对日志`);
        return;
      }
      if (multi) {
        // 这门课走完了，交给后台跳下一门（后台会把标签页导航过去，这一页随后就没了）
        const cur = multi.courses[multi.index];
        note(`这门课走完了（跳过已完成 ${skipped} 节），换下一门…`);
        live('换下一门…');
        await reportCourseDone(cur ? cur.key : '');
        return;
      }
      note(`整门课已走完一遍（跳过已完成 ${skipped} 节，提交与最终成绩请自行核对）`);
      stop();
    }
  }

  /* 停止后站点可能自己把播放接回去（播放器有断点续播/自动播放），
     所以点完暂停再守 5 秒：期间每 300ms 重新点一次它自己的暂停按钮。
     全程都是点站点控件，不改它的脚本。 */
  function holdPaused() {
    clearInterval(stopGuard);
    const until = Date.now() + 5000;
    const beat = () => {
      // start() 会先调 stop()，这时不能继续按着暂停，否则刚起来的刷课立刻被按住
      if (on || Date.now() > until) {
        clearInterval(stopGuard);
        stopGuard = 0;
        return;
      }
      pauseAll();
    };
    beat();
    if (!on) stopGuard = setInterval(beat, 300);
  }

  function stop() {
    const was = on;
    on = false;
    gen++;
    clearInterval(guard);
    guard = 0;
    if (was) holdPaused();
    live('已停止');
    if (was) {
      try { onStop(); } catch { /* 面板回调出错不影响脚本收尾 */ }
    }
  }

  function start(opts) {
    stop();
    rate = Math.min(16, Math.max(0.25, Number(opts && opts.rate) || 2));
    autoRate = !!(opts && opts.autoRate);
    live = (opts && opts.onLive) || (() => {});
    note = (opts && opts.onNote) || (() => {});
    onStop = (opts && opts.onStop) || (() => {});
    on = true;
    gen++;
    live('准备中…');
    courseLoop().catch((e) => {
      if (e === STOP) return;
      note('刷课出错：' + ((e && e.message) || e));
      stop();
    });
  }

  HW.Watch = {
    start,
    stop,
    resumeQueued,
    courseLinks,
    courseTimeKey,
    estimateCourseSeconds,
    rememberCourseProgress,
    remainingSeconds: () => {
      const progress = courseProgress();
      return progress ? estimateCourseSeconds({ done: 0, total: progress.remainingJobs }, rate, courseTiming) : null;
    },
    formatCourseTime: fmtLeft,
    catalogEntries,
    enterCourse,
    pageKind,
    currentCourse,
    quizGrade,
    setMuted,
    findVideo,
    nodes,
    unfinishedOf,
    activeChapterId,
    get running() { return on; },
    get rate() { return rate; },
  };
})();
