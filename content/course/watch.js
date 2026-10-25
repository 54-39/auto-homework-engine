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
  const TAB_WAIT = 300; // 点击后短暂让出执行，后续按章节和页签核验实际加载状态
  const NODE_WAIT = 3500; // 点目录项后等 AJAX 换页
  const VIDEO_WAIT = 12000; // 进视频页后等 <video> 出现
  const DWELL_TEXT = 4000; // 阅读／PPT 类停留时长
  const QUIZ_TIMEOUT = 240000; // 测验连续没有逐题进展时的等待上限
  const MAX_KICK_FAIL = 2; // 播放未能启动时停止，不反复点播放器
  const CHAPTER_GAP = 8000; // 相邻两节开始时间的基准间隔，章节处理耗时已超过时无需再等
  const TAB_GAP = 600; // 同一节里切换页签前的短暂停顿
  const SUBMIT_GAP = 1500; // 收到填写回执后，提交前的短暂停顿
  /* 所有间隔都加随机抖动：固定节律本身就是机器特征。 */
  const jitter = (ms, pct = 0.35) => Math.round(ms * (1 + (Math.random() * 2 - 1) * pct));

  /* 英文课程（大学英语等）的小节/页签名保持平台原文（用户 2026-10-22：节名不要翻译），
     只是太长的截断，别在日志里整段整段刷；插件的提示语本身全中文。 */
  const shortName = (n) => {
    const s = String(n || '');
    return s.length > 18 ? s.slice(0, 16) + '…' : s;
  };

  const STOP = { stop: true };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtRate = (n) => String(Math.round(n * 100) / 100);

  function checkVerification() {
    for (const doc of docs()) {
      const text = doc.body?.innerText || '';
      if (!/9010[\s\S]{0,100}验证码|操作异常[\s\S]{0,100}验证码/.test(text)) continue;
      if (![...doc.querySelectorAll('input')].some(el => visible(el) && /验证码/.test(el.placeholder || ''))) continue;
      const error = new Error('学习通要求手动完成验证码，已暂停并保留队列');
      error.code = 'HW_VERIFICATION_REQUIRED';
      throw error;
    }
  }

  /* 本页 + 所有同源 iframe 的 document（跨域读不到的跳过） */
  function docs(root = document) {
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
    walk(root, 0);
    return out;
  }

  /* 音频任务点（ananas/modules/audio/index_new.html）用的是同一个 video.js 播放器，
     只是媒体元素是 <audio>。大学英语 6 节里有 4 个任务点是音频，只认 <video> 的话
     这些节永远刷不完（2026-10-21 实测：Active reading 剩 4 个点，其中就有音频）。 */
  const allVideos = () => docs().flatMap((d) => [...d.querySelectorAll('video, audio')]);
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
  /* 没有 src 的媒体元素不是任务点：openGauss 每张卡里都常驻一个
     <audio src="">（MEDIA_ELEMENT_ERROR，err=4），以前 findVideo() 会把它当播放器，
     于是整节误判成「视频页」，真的空卡反而没人管（2026-10-22 现场诊断）。 */
  const hasSource = (v) => !!(v.currentSrc || v.getAttribute('src') || v.querySelector('source[src]'));

  function findVideo(ended) {
    /* 播完的（ended）不再认：一个页签里可能不止一个视频任务点（阅读卡里两幅画
       各带一个介绍短片，2026-10-20 实测），第一个播完要接着看第二个，
       不能抱着已结束的那个反复 kick 重播。 */
    const list = pendingVideos().filter((v) => !v.ended && !ended?.has(v) && hasSource(v));
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

  /* 非视频任务点（阅读／文档／PPT）的角标。第一站那节就是视频看完了、
     还剩一个非视频点没完成（2026-10-21 实测：父元素没有 .ans-job-finished）。 */
  function textJobs() {
    const out = [];
    for (const d of docs()) {
      try { out.push(...d.querySelectorAll('.ans-job-icon:not(.ans-job-video)')); } catch { /* 跨域文档跳过 */ }
    }
    return out;
  }

  function textJobsDone() {
    const chapter = activeChapterId();
    if (chapter && unfinishedOf(chapter) === 0) return true;
    const jobs = textJobs();
    if (!jobs.length) return !docs().some(d => [...d.querySelectorAll('.ans-attach-ct:not(.ans-job-finished) iframe')].some(frame => DOC_FRAME.test(frame.src)));
    return jobs.every((ic) => !!(ic.parentElement && ic.parentElement.classList.contains('ans-job-finished')));
  }

  /* 学情调查／问卷：卡片是站点自己的「投票」模块（ananas/modules/zt/vote）。
     封面本身没有 iframe 问卷，必须点一下 #render，站点才会在顶层页面把
     #voteIframe 指到 mobilelearn 的问卷页并显示 .voteContainer。
     问卷页在 mobilelearn 域下，顶层读不到，由 content/course/survey.js 在那一帧里填写提交；
     这里只负责点开、并等站点自己把任务点记账（目录角标归零）再算完成。 */
  function surveyCard() {
    for (const d of docs()) {
      let el = null;
      try { el = d.querySelector('#render'); } catch { continue; }
      if (el && /\/ananas\/modules\/zt\/vote\//.test(d.URL || '')) return el;
    }
    return null;
  }

  const SURVEY_RELOAD_KEY = 'hwSurveyReloaded';
  const surveyReloaded = (id) => {
    try { return sessionStorage.getItem(SURVEY_RELOAD_KEY) === String(id); } catch { return true; }
  };

  async function openSurveyCard() {
    const card = surveyCard();
    if (!card) return false;
    const chapter = activeChapterId();
    const my = gen;
    /* 问卷提交成功后，站点自己会 parent.postMessage({"cmd":"callBackFinishJob"}) 上报任务点完成。
       这是站点脚本在服务端返回 result==1 之后发的，比“我点过提交了”硬得多。 */
    let receipt = false;
    let frame = null, started = false, retried = false;
    const onMessage = (e) => {
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (frame && e.source === frame.contentWindow && e.origin === new URL(frame.src).origin &&
            data && data.cmd === 'callBackFinishJob') receipt = true;
      } catch { /* 不是站点的完成任务通知 */ }
    };
    window.addEventListener('message', onMessage);
    try {
      live('问卷：打开投票卡片…');
      try { card.click(); } catch { return false; }
      for (let i = 0; i < 90 && on; i++) {
        await step(1000);
        frame = document.querySelector('#voteIframe');
        if (chapter && activeChapterId() !== chapter) return true;
        if (chapter && unfinishedOf(chapter) === 0) return true;
        const state = frame && await chrome.runtime.sendMessage({ type: 'HW_WATCH_SURVEY', payload: { start: !started, url: frame.src } }).catch(() => null);
        if (!on || my !== gen) throw STOP;
        if (state?.ok && state.state !== 'idle') started = true;
        if (state?.state === 'submitted') receipt = true;
        if (state?.state === 'expired') throw new Error('问卷已被教师结束或已截止，平台不再接受作答；继续后续任务');
        if (state?.state === 'blocked') throw new Error(state.reason);
        // 仅重载问卷框架一次，不刷新课程、不清空队列；已确认提交的问卷不重复提交。
        if (!receipt && !retried && i >= 30 && state?.state !== 'submitted' &&
            (!state?.ok || ['failed', 'pending', 'idle'].includes(state.state))) {
          if (frame && /\/page\/questionnaire\/answerQuestionChapter/.test(frame.src)) {
            checkVerification();
            frame.src = frame.src;
            retried = true; started = false;
            live('问卷未收到回执，重新加载问卷后恢复一次');
          }
        }
        if (!receipt) continue;
        receipt = false;
        live('问卷已提交（站点回执），核对目录计数');
        await step(3000);
        if (!chapter || unfinishedOf(chapter) === 0) return true;
        /* 目录树是整页加载时画的，站点提交后不会重画：刷新一次拿平台最新计数。
           只刷一次，避免和问卷来回拉锯；刷完还是 1 就如实记成未完成。 */
        if (!surveyReloaded(chapter)) {
          try { sessionStorage.setItem(SURVEY_RELOAD_KEY, String(chapter)); } catch { /* 存不了就不刷 */ }
          live('学情调查已提交，刷新目录核对平台计数');
          setTimeout(() => location.reload(), 600);
          return true;
        }
      }
      note('问卷自动恢复后仍未收到平台回执，记录未完成并继续后续任务');
      return false;
    } finally {
      window.removeEventListener('message', onMessage);
      // 超星把跨域问卷留在顶层弹层，换章不会自动关闭；只收起界面，不改任务完成状态。
      const overlay = document.querySelector('.voteContainer');
      if (overlay && (!frame || overlay.contains(frame))) overlay.style.display = 'none';
    }
  }

  /* 万能兜底：任务点反复计不上时，把卡片里站点自己的入口按钮点一遍，再滚一遍到底。
     各门课的阅读/文档卡片结构差异很大（有的是「开始学习」，有的是「继续」，有的藏在折叠里），
     与其一门门写适配，不如把站点自己暴露的入口都点一次——点的都是它自己的控件，不伪造状态。
     用户 2026-10-21：先刷完，别一门门卡住。 */
  async function nudgeCard() {
    /* 「开始实训／进入实验／开始答题」这类入口也要点：openGauss 的【练】页签就是
       实训模块，只有点进去站点才记账（2026-10-22 审计）。长度限制放宽到 12，
       这些词本身就 4~6 个字。 */
    const CLICK = /^(播放|开始|继续|进入|开始学习|立即学习|查看|展开|更多|开始实训|进入实训|开始实验|进入实验|开始练习|开始答题|开始做题|去实训|去实验|去完成|去学习|立即答题|继续实验|继续实训|进入练习)$/;
    let clicked = 0;
    for (const d of docs()) {
      let list;
      try { list = d.querySelectorAll('button,a,span,div[class*="btn"],div[class*="play"]'); } catch { continue; }
      for (const el of list) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 12 || !CLICK.test(t) || !visible(el)) continue;
        try { el.click(); clicked++; } catch { /* 换下一个 */ }
        if (clicked >= 3) break;
      }
      if (clicked >= 3) break;
    }
    if (clicked) { await step(jitter(1200)); await readThrough(20000); }
    return clicked;
  }

  /* 站点在「本节还有任务点没完成」时会弹一个「提示」框挡住整页：
     「去学习」＝留在本节继续做，「下一节」＝直接跳走。
     脚本以前不认这个框：要么干等，要么被后面的点击顺手带成「下一节」——用户 2026-10-21
     截图反馈的就是这个，表现为「卡住」或「莫名跳过」。一律选「去学习」：欠账不能用跳节绕过。 */
  function unfinishedDialog() {
    for (const d of docs()) {
      let box = null;
      try { box = d.querySelector('.maskDiv.jobFinishTip'); } catch { continue; }
      if (box && visible(box)) return box;
    }
    /* 结构变了就按文案找，但**必须真的可见**：这个框常驻在 DOM 里、默认 display:none，
       只按文字找会对着一个空壳反复点，日志还会误报「已处理提示框」。 */
    for (const d of docs()) {
      let hit = null;
      try {
        for (const el of d.querySelectorAll('.maskDiv,.popDiv')) {
          const t = (el.textContent || '').replace(/\s+/g, '');
          if (t.includes('当前章节还有任务点未完成') && visible(el)) { hit = el; break; }
        }
      } catch { continue; }
      if (hit) return hit;
    }
    return null;
  }

  async function dismissUnfinishedDialog() {
    const box = unfinishedDialog();
    if (!box) return false;
    /* 站点自己的三个按钮：上一节 / 下一节 / 去学习（a.btnBlue，onclick=scroll2Job）。
       一律选「去学习」：欠账不能靠跳节绕过。找按钮时也按可见性过滤，别点到隐藏的。 */
    const go = [...box.querySelectorAll('.popBottom a,button,span')]
      .filter((el) => visible(el) && /^去学习$/.test((el.textContent || '').trim())).pop();
    if (go) {
      try { go.click(); } catch { return false; }
      live('站点提示本节还有任务点，已选「去学习」留在本节继续');
      await step(jitter(1200));
      return true;
    }
    const close = box.querySelector('.popClose');
    if (close && visible(close)) {
      try { close.click(); } catch { return false; }
      live('站点提示框没有「去学习」按钮，已关闭提示框');
      await step(jitter(800));
      return true;
    }
    return false;
  }

  /* 空壳卡：cards iframe 的 body 只有隐藏 input 和一堆 script，正文一个字都没有，
     附件区只有 100px 高的空 iframe。站点偶尔就下发成这种半成品（2026-10-22 现场诊断：
     num=3/5 的帧 readyState=complete 但 innerText 只有空格、.card=0）。
     这种页再怎么滚也不会记账，先让它自己重画一次；同一节同一页签只做一次。 */
  const cardReloaded = new Set();
  const failedCardDocs = new WeakSet();
  function cardLooksEmpty(doc) {
    if (!doc?.body) return false;
    if ((doc.body.innerText || '').trim().length) return false;
    if (doc.querySelector('.card,.ans-attach-ct,video,canvas,.TiMu,.questionLi')) return false;
    /* 大尺寸 iframe 说明正文在子框架里，不算空壳 */
    return ![...doc.querySelectorAll('iframe')].some((f) => f.clientHeight > 150);
  }
  async function ensureCardRendered(tabIndex) {
    const frame = document.querySelector('#iframe');
    if (!frame) return true;
    const chapter = activeChapterId();
    const sameCard = () => activeChapterId() === chapter && document.querySelector('#iframe') === frame;
    const ready = () => {
      try {
        const doc = frame.contentDocument;
        return !!doc?.body && doc.URL !== 'about:blank' && doc.readyState !== 'loading' && !cardLooksEmpty(doc);
      } catch { return false; }
    };
    const key = (currentCourse()?.key || '') + ':' + (chapter || '') + ':' + tabIndex;
    if (ready()) return true;
    try { if (failedCardDocs.has(frame.contentDocument)) return false; } catch { /* 文档尚不可读 */ }
    /* complete 也可能只是空壳脚本刚启动：先等异步正文，别重载正在渲染的卡片。 */
    const waitRendered = async () => {
      const deadline = Date.now() + 12000;
      while (on && sameCard() && Date.now() < deadline) {
        if (ready()) return true;
        await step(400);
      }
      return sameCard() && ready();
    };
    if (await waitRendered()) return true;
    if (!sameCard()) return false;
    if (cardReloaded.has(key)) return false;
    cardReloaded.add(key);
    live('这一页是空壳卡，让站点重画一次');
    try {
      /* 直接重载原地址；停止信号不能把页面留在 about:blank。 */
      frame.src = frame.src;
    } catch { return false; }
    await step(400);
    if (await waitRendered()) return true;
    if (!sameCard()) return false;
    let state = '文档不可读';
    try {
      const doc = frame.contentDocument;
      if (doc) failedCardDocs.add(doc);
      if (doc) state = `${doc.readyState}，正文 ${(doc.body?.innerText || '').trim().length} 字，子框架 ${doc.querySelectorAll('iframe').length} 个`;
    } catch { /* 跨域文档只报告不可读 */ }
    note(`重画后仍未渲染（${state}），跳过这一页，不计完成`);
    return false;
  }

  const expandedTaskCards = new WeakSet();
  function cardHasNoTasks() {
    try {
      const page = document.querySelector('#iframe')?.contentDocument?.querySelector('#pageDiv');
      const empty = page?.querySelector('.nullpage');
      return !!(visible(empty) && /暂无内容/.test(empty.textContent || '') &&
        !page.querySelector('.ans-attach-ct,iframe,video,audio,form,.questionLi,.TiMu'));
    } catch { return false; }
  }
  async function expandTaskCards() {
    const chapter = activeChapterId();
    const my = gen;
    for (const doc of docs()) for (const card of doc.querySelectorAll('.blockquote-wrap')) {
      const handle = card.querySelector('.ans-blockquote-handle');
      if (!card.querySelector('.cmd-autoblockquote') || card.classList.contains('open') || !visible(handle) || expandedTaskCards.has(card)) continue;
      if (!on || my !== gen || activeChapterId() !== chapter) return;
      expandedTaskCards.add(card);
      handle.click();
      const deadline = Date.now() + 8000;
      while (card.isConnected && !card.querySelector('.cmd-autoblockquote iframe') && Date.now() < deadline) {
        await step(200);
        if (activeChapterId() !== chapter) return;
      }
    }
  }

  /* 讨论任务点：卡片是 ananas 的话题模块（ananas/modules/insertbbs），
     内层 #topicMainDiv 的 data 属性就是话题页地址（groupweb 域，跨域读不到内容）。
     直接点它开不了新页（程序化点击没有 user gesture，会被弹窗拦截），
     所以把话题地址交给后台开标签页；回帖由 content/course/bbs.js 在那个标签页里完成。 */
  /* bbs.js 回帖成功后经后台转发 HW_BBS_NOTIFY；把 completeTopic 消息补进
     insertbbs 那层窗口——正常由话题页 postMessage 给 opener，而话题页是
     扩展开的标签页、没有 opener。回帖是真的发到服务器了，这条消息只是
     把「已完成」如实通知给卡片自己的完成链路。 */
  /* 收到回帖通知就自增：openBbsCard 用它判断「这一张卡的回复已经真的发出去了」。 */
  let bbsNotifySeq = 0;
  if (window.top === window && !HW._bbsNotifyHooked) {
    HW._bbsNotifyHooked = true;
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type !== 'HW_BBS_NOTIFY') return;
        bbsNotifySeq++;
        const jobId = String(msg.payload?.jobId || '');
        if (!/^\d+$/.test(jobId) || String(activeChapterId()) !== String(msg.payload?.knowledgeId)) return;
        for (const d of docs()) {
          for (const f of d.querySelectorAll('iframe')) {
            if ((f.src || '').includes('/ananas/modules/insertbbs/') && String(f.getAttribute('jobid')) === jobId) {
              try { f.contentWindow.postMessage({ opType: 'completeTopic' }, '*'); } catch { /* 跨域就算了 */ }
            }
          }
        }
        /* ② 服务端记账补发（2026-10-22 接口分析结论）：JC.completed 只改本地状态、
           零网络调用——讨论的账平台靠回帖请求自带 job 上下文，而我们从独立话题页发的
           回帖没有这套上下文。补发一次 readv2（与阅读任务同款记账接口），
           参数在 AttachmentSetting/mArg/卡片 DOM 里，只有页面自己读得到 → 注入 <script> 执行。 */
        try {
          const q = new URLSearchParams(location.search);
          const courseId = q.get('courseId') || '';
          const clazzId = q.get('clazzid') || '';
          const chapter = activeChapterId() || '';
          const cards = document.querySelector('#iframe');
          const cd = cards?.contentDocument;
          if (cd && chapter) {
            const sc = cd.createElement('script');
            sc.textContent = `(function(){
              try {
                var ibs = Array.from(document.querySelectorAll('iframe[src*="insertbbs"]')).find(function(f) { return f.getAttribute('jobid') === '${jobId}'; });
                var jobid = ibs ? ibs.getAttribute('jobid') : null;
                if (ibs) {
                  try {
                    var inner = ibs.contentDocument.getElementById('frame_content');
                    if (inner) { var iu = new URL(inner.src, 'https://mooc1.chaoxing.com'); jobid = iu.searchParams.get('jobid') || jobid; }
                  } catch (e) {}
                }
                if (!jobid) { document.documentElement.setAttribute('data-readv2-err', 'no jobid'); return; }
                var setting = window.AttachmentSetting || null;
                var mArg = window.mArg || null;
                var def = (mArg && mArg.defaults) || (setting && setting.defaults) || {};
                var knowledgeid = (def.knowledgeid || '') + '' || '${chapter}';
                var courseid = (def.courseid || '') + '' || '${courseId}';
                var clazzid = (def.clazzId || def.clazzid || '') + '' || '${clazzId}';
                var jtoken = '';
                var atts = (mArg && mArg.attachments) || (setting && setting.attachments) || [];
                for (var i = 0; i < atts.length; i++) {
                  var a = atts[i] || {}; var pr = a.property || {};
                  if ((pr.jobid || a.jobid || '') + '' === jobid + '') { jtoken = a.jtoken || pr.jtoken || ''; break; }
                }
                var url = '/ananas/job/readv2?jobid=' + jobid + '&knowledgeid=' + knowledgeid + '&courseid=' + courseid + '&clazzid=' + clazzid + (jtoken ? '&jtoken=' + jtoken : '');
                fetch(url, { credentials: 'include' }).then(function (r) { return r.text(); }).then(function (t) {
                  document.documentElement.setAttribute('data-readv2', String(t).slice(0, 160));
                }).catch(function (e) { document.documentElement.setAttribute('data-readv2-err', String(e).slice(0, 120)); });
              } catch (e) { document.documentElement.setAttribute('data-readv2-err', String(e).slice(0, 120)); }
            })();`;
            cd.documentElement.appendChild(sc);
            setTimeout(() => { try { sc.remove(); } catch {} }, 4000);
          }
        } catch { /* 注入失败就只留 postMessage 那条链 */ }
      });
    } catch { /* 监听器注册失败不影响其它流程 */ }
  }

  /* 同一节里试过的讨论卡记在这里。站点不会给跨标签页回帖的卡片挂 .ans-job-finished
     （2026-10-23 实测：1.2 连续几轮都是「等满 90 秒仍无回执」，而这一节的任务点数
     确实按 9→8、8→7…往下掉），所以只靠这个类既认不出完成、也会反复返回同一张卡。
     卡片本身没法用来区分：站点的讨论卡没有 jobid 属性，几张卡的 iframe 地址完全相同，
     卡片外层标题也是空的——只有卡片里那层 frame_content 的地址带得出 jobid。 */
  const bbsTried = new Set();
  const bbsKeyOf = (h) => {
    const f = h.querySelector('iframe');
    if (!f) return 'no-frame';
    const jid = f.getAttribute?.('jobid') || '';
    if (jid) return 'job:' + jid;
    try {
      const d = f.contentDocument;
      if (d) {
        for (const doc of docs(d)) {
          const fc = doc.getElementById?.('frame_content');
          if (fc?.src) {
            const id = new URL(fc.src, location.href).searchParams.get('jobid');
            if (id) return 'job:' + id;
          }
        }
      }
    } catch { /* 跨域或还没加载 */ }
    /* 实在读不到 jobid 才退回「文档地址 + 同文档内序号」，至少不会把整节卡死 */
    const owner = h.ownerDocument;
    const idx = owner ? [...owner.querySelectorAll('.ans-attach-ct')].indexOf(h) : -1;
    return 'idx:' + (owner?.URL || '') + '#' + idx;
  };
  function bbsCard() {
    for (const d of docs()) {
      for (const h of d.querySelectorAll('.ans-attach-ct')) {
        const src = h.querySelector('iframe')?.src || '';
        if (src.includes('/ananas/modules/insertbbs/') && !h.classList.contains('ans-job-finished')
          && !bbsTried.has(bbsKeyOf(h))) return h;
      }
    }
    return null;
  }

  async function openBbsCard() {
    const card = bbsCard();
    if (!card) return false;
    /* 认领这张卡：即使后面某一步失败也不会在同一轮里重试同一张（否则会重复回帖）。 */
    bbsTried.add(bbsKeyOf(card));
    const chapter = activeChapterId();
    const before = unfinishedOf(chapter);
    const seq0 = bbsNotifySeq;
    /* topicMainDiv 不在 insertbbs 那层文档里，在它内层 bbscircle 文档里——
       必须跨全部同源文档找，只看第一层 iframe 会拿到 null（2026-10-22 实测）。 */
    let topicDoc = null;
    try { topicDoc = card.querySelector('iframe')?.contentDocument; } catch { /* 跨域时停止 */ }
    const main = await until(() => {
      try { topicDoc = card.querySelector('iframe')?.contentDocument; } catch { return null; }
      return (topicDoc ? docs(topicDoc) : []).map(d => d.getElementById?.('topicMainDiv')).find(el => el?.getAttribute('data')) || null;
    }, 8000);
    const topicUrl = main?.getAttribute('data') || '';
    let u;
    try { u = new URL(topicUrl); } catch { await recordWatchSkip(new Error('讨论卡内层话题未加载，未发帖'), { task: '讨论卡' }, true); return false; }
    if (!/(^|\.)chaoxing\.com$/.test(u.hostname)) { note('讨论话题地址不在超星域，留给人工核对'); return false; }
    const inner = topicDoc?.getElementById('frame_content');
    if (inner) {
      const iu = new URL(inner.src, location.href);
      for (const key of ['jobid', 'knowledgeid', 'enc', 'utenc', 'courseid', 'clazzId', 'ut', 'isJob']) {
        const value = iu.searchParams.get(key);
        if (value) u.searchParams.set(key, value);
      }
    }
    live('讨论：打开话题页…');
    const opened = await chrome.runtime.sendMessage({ type: 'HW_WATCH_OPEN_TOPIC', payload: { url: u.href } });
    if (!opened?.ok) { note('话题页没能打开：' + (opened?.error || '未知错误')); return false; }
    /* 回帖后站点走 opType=completeTopic 的消息链把角标翻绿；等不到就如实记 gap。 */
    /* 回执只认三个都可信的信号：卡片自己被站点挂上完成类、本节任务点数下降、
       或者话题页回帖后由后台转回通知。等不到就不再空耗，如实记 gap。 */
    for (let i = 0; i < 90 && on; i++) {
      await step(1000);
      if (chapter && activeChapterId() !== chapter) return true;
      if (card.classList.contains('ans-job-finished')) return true;
      if (bbsNotifySeq > seq0) { live('讨论已回帖并收到回帖通知'); return true; }
      if (before !== null && unfinishedOf(chapter) < before) { live('讨论已计入本节任务点数'); return true; }
    }
    note('讨论卡没等到完成回执，留给人工核对');
    return false;
  }

  /* 只滚阅读正文，不碰课程外壳和目录。预览器由自己的框架负责，避免两处抢滚动。
     用户在正文中滚轮、拖动或用键盘阅读后，本张文档让出控制，换文档后恢复自动阅读。 */
  const scrollCache = new WeakMap();
  const scrollObserved = new WeakSet();
  const readingControls = new WeakMap();
  function readingControl(d) {
    let control = readingControls.get(d);
    if (control) return control;
    control = { manual: false };
    const takeOver = (event) => {
      if (!event.isTrusted) return;
      if (event.type === 'keydown' && !/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End| )$/.test(event.key)) return;
      control.manual = true;
    };
    for (const type of ['wheel', 'pointerdown', 'touchstart', 'keydown']) {
      d.addEventListener(type, takeOver, { capture: true, passive: true });
    }
    readingControls.set(d, control);
    return control;
  }

  function readingDocuments(root = document, viewer = false) {
    const out = [];
    const walk = (d, depth, reading) => {
      if (!d || depth > MAX_DEPTH) return;
      reading = reading || /\/knowledge\/cards/.test(d.URL || '');
      if (reading) out.push(d);
      for (const frame of d.querySelectorAll('iframe')) {
        if (!visible(frame) || DOC_FRAME.test(frame.src) || /\/ananas\/modules\/(video|audio|work|bbs|zt)\//.test(frame.src)) continue;
        try { walk(frame.contentDocument, depth + 1, reading || (d === document && frame.id === 'iframe')); } catch { /* 跨域预览器自己处理 */ }
      }
    };
    walk(root, 0, viewer);
    return out;
  }

  function scrollTargets(d) {
    if (!d.documentElement) return [];
    if (!scrollObserved.has(d)) {
      new MutationObserver(() => scrollCache.delete(d)).observe(d.documentElement, {
        subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'],
      });
      scrollObserved.add(d);
    }
    const cached = scrollCache.get(d);
    if (cached?.length && cached.every(el => el.isConnected)) return cached;
    const root = d.scrollingElement || d.documentElement;
    const targets = [root, ...d.querySelectorAll('*')].filter((el) => {
      if (!el || !visible(el) || el.clientHeight <= 80 || el.scrollHeight <= el.clientHeight + 40) return false;
      if (el.closest('nav,aside,[role="navigation"],#coursetree,#sidebarContainer,#thumbnailView')) return false;
      return el === root || /auto|scroll/.test(d.defaultView.getComputedStyle(el).overflowY);
    });
    const unique = [...new Set(targets)];
    if (unique.length) scrollCache.set(d, unique);
    return unique;
  }

  function scrollReading(d) {
    if (readingControl(d).manual) return { moved: false, manual: true, scrollable: false };
    const targets = scrollTargets(d);
    let moved = false;
    for (const el of targets) {
      const bottom = el.scrollHeight - el.clientHeight;
      const before = el.scrollTop;
      if (before >= bottom - 4) continue;
      el.scrollTo({ top: bottom, behavior: 'instant' });
      if (el.scrollTop > before + 4) moved = true;
    }
    return { moved, manual: false, scrollable: targets.length > 0 };
  }

  async function readThrough(maxMs = 45000) {
    const started = Date.now();
    const dl = started + maxMs;
    let stuck = 0;
    let scrollable = false; // 这一页有没有任何一个能滚的地方
    live('阅读任务点：翻页中…');
    try { await chrome.runtime.sendMessage({ type: 'HW_WATCH_READ_DOC' }); } catch { /* 正文仍按可读取区域处理 */ }
    while (on && Date.now() < dl) {
      if (textJobsDone()) return true;
      let moved = false;
      for (const d of readingDocuments()) {
        try {
          const progress = scrollReading(d);
          if (progress.scrollable) scrollable = true;
          if (progress.moved) moved = true;
        } catch { /* 跨域文档跳过 */ }
      }
      /* 空壳卡（附件区只有 100px 高的空 iframe、正文一个字都没有）滚不动，
         以前照样空转满 45 秒，4 节×多轮全浪费在这上面。8 秒还没发现可滚区域就收工。 */
      if (!scrollable && Date.now() - started > 8000) return textJobsDone();
      if (moved) { stuck = 0; await step(800); continue; }
      stuck++;
      if (stuck >= 3) {
        await step(4000); // 到底了：等站点上报
        return textJobsDone();
      }
      await step(1500);
    }
    return textJobsDone();
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

  /* 仅在采到足够的新版本成功任务样本后估算；缺少样本时不外推整课。 */
  function remainingJobs() {
    let total = 0;
    for (const n of nodes()) {
      const u = unfinishedOf(n.id);
      if (u) total += u;
    }
    return total;
  }
  function fmtLeft(sec) {
    if (!Number.isFinite(sec)) return '暂无法估算';
    if (sec <= 0) return '快了';
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
    // 不再用固定「4 分钟/任务点」或旧版受等待污染的样本外推整门课程。
    const samples = timing?.schema === 2 ? (timing.samples || []).filter(n => Number.isFinite(n) && n > 0) : [];
    if (samples.length < 3) return null;
    const sorted = samples.slice().sort((a, b) => a - b);
    const secondsPerJob = sorted[Math.floor(sorted.length / 2)];
    return jobs * secondsPerJob / Math.max(0.25, Number(speed) || 2);
  }
  function courseProgress() {
    const list = nodes();
    const counts = list.map(n => unfinishedOf(n.id));
    return list.length && counts.every(n => n !== null) ? { remainingJobs: counts.reduce((sum, n) => sum + n, 0), sectionsDone: counts.filter(n => n === 0).length, sectionsTotal: list.length } : null;
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
      /* 进度优先认「任务点进度: X/Y」标签，防止课名/班级里的其他 X/Y 数字对抢先命中；
         没有这个标签的旧皮肤退回任意数字对。都没有就是这门课不开任务点（done=null）。 */
      const prog = /任务点进度:\s*(\d+)\s*\/\s*(\d+)/.exec(cardText) || /(\d+)\s*\/\s*(\d+)/.exec(cardText);
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
    /* 新版目录（2026-10-22 用户浏览器实测）：站点把目录画成 role=link 的 div/a 列表，
       没有 .catalog_title/.checkbox。章节号是 8 位以上长数字，页面里的计数都是
       两三位数，按长度区分；完成状态看文字（旧版绿 ✓ 的新版直接写「已完成」）。
       解析不到 id 的行不收——宁可漏收让上层自愈，也不能拿错 id 跳错节。 */
    if (!out.length) {
      for (const el of document.querySelectorAll('[role="link"]')) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const html = el.outerHTML || '';
        const m = /(?:chapterId|knowledgeid|knowledgeId|cid|data-id)[=:"'\\s]+(\d{8,})/.exec(html)
          || /(\d{8,})/.exec(html);
        if (!m) continue;
        out.push({
          id: m[1],
          name: text.slice(0, 40),
          done: /已完成/.test(text),
          anchor: el.querySelector('a') || el,
        });
      }
    }
    return out;
  }

  /* 开头连续 N 节（N 由设置页决定，默认 4）：返回这段窗口的完成情况。
     用户 2026-10-23 要求节数可自行设置，所以这里不再写死 4。 */
  function windowOf(entries, n, attempted = []) {
    const size = Math.max(1, Math.min(10, Number(n) || 4));
    const win = entries.slice(0, size);
    if (win.length !== size) return null;
    const chapterIds = win.map(e => e.id);
    if (win.every(e => e.done)) return { complete: true, chapterIds, exceptions: [] };
    const exceptions = win.filter(e => !e.done && /口语/.test(e.name))
      .map(e => ({ id: e.id, name: e.name }));
    if (attempted.includes(0)) {
      return win.every(e => e.done || exceptions.some(x => x.id === e.id))
        ? { complete: true, chapterIds, exceptions }
        : { incomplete: true, chapterIds, exceptions };
    }
    return { start: 0, chapterIds, left: win.filter(e => !e.done).length };
  }
  // 旧的 4 节版本保留成薄封装：测试脚本与历史调用还在用它。
  const fourWindow = (entries, attempted) => windowOf(entries, 4, attempted);
  /* 限定节数模式：队列里带 targetRun（设置页选的节数）就是这种模式，不再只认 4 */
  const limitedRun = (q) => Number(q?.targetRun) >= 1;

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
  let lastEnterAt = 0; // 上一次切换章节的时间，用来卡 CHAPTER_GAP
  let resumeRetry = 0; // 目录渲染慢时的接续重试次数

  async function askQueue() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'HW_WATCH_QUEUE_GET' });
      if (r && r.ok && r.queue && r.queue.courses && r.queue.courses.length) return r.queue;
    } catch { /* 后台没响应就当没有队列，当普通页面处理 */ }
    return null;
  }

  async function reportCourseDone(key, details = {}) {
    try { await chrome.runtime.sendMessage({ type: 'HW_WATCH_COURSE_DONE', payload: { key, ...details } }); }
    catch { /* 后台不在就只能停在这里 */ }
  }

  async function verifyWindowFromCatalog(q, opts) {
    const course = q.courses[q.index];
    const size = Math.max(1, Math.min(10, Number(q.targetRun) || 4)); // 设置页选的节数
    const entries = await until(() => catalogEntries().length ? catalogEntries() : null, 15000);
    if (!entries) {
      /* 目录没渲染先自愈一次：刷新后 resumeQueued 重入本函数（flag 防死循环）。 */
      if (!sessionStorage.getItem('hwCatRetry')) {
        try { sessionStorage.setItem('hwCatRetry', '1'); } catch { }
        opts?.onLive?.('课程目录未渲染，刷新一次再核验');
        setTimeout(() => location.reload(), 800);
        return;
      }
      try { sessionStorage.removeItem('hwCatRetry'); } catch { }
      const reason = `课程目录未加载，连续 ${size} 节状态无法核验`;
      await recordWatchSkip(new Error(reason), { task: '课程目录核验' });
      await reportCourseDone(course.key, { status: 'incomplete' });
      opts?.onNote?.(reason + '，已跳过当前课程');
      return;
    }
    try { sessionStorage.removeItem('hwCatRetry'); } catch { }
    const window = windowOf(entries, size, course.attempted || []);
    if (window?.complete) {
      const exceptions = window.exceptions || [];
      opts?.onNote?.(exceptions.length
        ? `开头 ${size} 节已核验；${exceptions.length} 个口语小节按例外跳过：${exceptions.map(e => e.name).join('、')}`
        : `平台目录确认开头连续 ${size} 节已完成：${window.chapterIds.join('、')}`);
      await reportCourseDone(course.key, { status: exceptions.length ? 'complete_with_exceptions' : 'complete',
        chapterIds: window.chapterIds, exceptions });
      return;
    }
    if (!window || window.incomplete) {
      /* attempted 里有 0，说明这门课之前跑过一轮。以前一律直接记「未达标」，
         上一轮没跑完（关窗口、刷新、队列恢复）的课就被白白跳过——2026-10-21 实测：
         openGauss 开头 4 节 22 个任务点被一句「记录为未达标」跳过去。
         这里每门课再给一轮机会，跑完还缺才记未达标。 */
      const ids = window?.chapterIds || [];
      if (ids.length === size) {
        const retry = await chrome.runtime.sendMessage({ type: 'HW_WATCH_RETRY_ONCE', payload: { key: course.key } });
        if (retry?.ok && retry.first) {
          const saved = await chrome.runtime.sendMessage({ type: 'HW_WATCH_SCOPE_SET', payload: { key: course.key, start: 0, chapterIds: ids } });
          if (saved?.ok) {
            opts?.onLive?.(`开头 ${size} 节还没做完，本轮重新补一遍`);
            try { entries[0]?.anchor?.click(); } catch { opts?.onNote?.('未能打开第 1 节，请手动检查'); }
            return;
          }
        }
      }
      opts?.onNote?.(`课程开头 ${size} 节仍有普通任务未完成，记录为未达标`);
      await reportCourseDone(course.key, { status: 'incomplete', chapterIds: ids });
      return;
    }
    const saved = await chrome.runtime.sendMessage({ type: 'HW_WATCH_SCOPE_SET', payload: {
      key: course.key, start: window.start, chapterIds: window.chapterIds } });
    if (!saved?.ok) {
      opts?.onNote?.('保存连续小节范围失败：' + (saved?.error || '未知错误'));
      return;
    }
    opts?.onLive?.(`从课程开头处理前 ${size} 节（尚未完成 ${window.left} 节）`);
    const target = entries[window.start].anchor;
    try { target.click(); } catch { opts?.onNote?.('未能打开选定小节，请手动检查'); }
  }

  async function returnToCatalog() {
    const cur = currentCourse();
    if (!cur) return false;
    const back = [...document.querySelectorAll('a[href]')].find(a => {
      if (!visible(a) || (a.textContent || '').trim() !== '返回课程') return false;
      try {
        const url = new URL(a.href);
        return /\/mycourse\/stu$/.test(url.pathname) &&
          `${url.searchParams.get('courseid') || url.searchParams.get('courseId')}|${url.searchParams.get('clazzid')}` === cur.key;
      } catch { return false; }
    });
    if (back) { back.click(); return true; }
    const r = await chrome.runtime.sendMessage({ type: 'HW_WATCH_OPEN_CATALOG', payload: { url: cur.scUrl } });
    return !!r?.ok;
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
    try { checkVerification(); }
    catch (e) {
      if (e.code !== 'HW_VERIFICATION_REQUIRED') throw e;
      await chrome.runtime.sendMessage({ type: 'HW_WATCH_PAUSE', payload: { reason: e.message } });
      q.paused = e.message;
    }
    if (q.paused) {
      opts?.onNote?.(q.paused);
      opts?.onLive?.('已暂停：' + q.paused);
      return true;
    }
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
      } else {
        /* 章节页签/目录 iframe 没加载出来：以前只留一句 note 就死等人工。
           先自愈刷新一次（flag 防死循环），刷新后 resumeQueued 重入。 */
        if (!sessionStorage.getItem('hwStuRetry')) {
          try { sessionStorage.setItem('hwStuRetry', '1'); } catch { }
          opts?.onLive?.('课程首页章节目录未就绪，刷新一次再试');
          setTimeout(() => location.reload(), 800);
          return true;
        }
        try { sessionStorage.removeItem('hwStuRetry'); } catch { }
        await recordWatchSkip(new Error('课程首页未加载章节目录'), { task: '进入课程' });
        await reportCourseDone(q.courses[q.index]?.key || '', { status: 'incomplete' });
      }
      return true;
    }
    // 章节目录常在 document_idle 之后才由站点画出来，不能把暂时的 other 当成不用接续。
    const kind = await until(() => {
      const k = pageKind();
      return k === 'study' || k === 'catalog' ? k : null;
    }, 20000);
    if (kind === 'catalog') {
      if (limitedRun(q)) {
        await verifyWindowFromCatalog(q, opts);
        return true;
      }
      const next = await until(() => enterCourse(), 15000);
      if (!next) {
        /* 目录解析成功才算这门课走完；解析为空多半是新版目录/渲染慢，
           刷新一次自愈（flag 防死循环），不能把整门课静默跳过（昨晚漏 12 节的根因之一）。
           刷新后仍是空的空壳课（站点只给「已完成任务点 0/0」）就报完成翻下一门，
           否则这一页会永远停着、整条队列卡死（2026-10-23 回归用例抓到）。 */
        if (catalogEntries().length) await reportCourseDone(q.courses[q.index] && q.courses[q.index].key);
        else if (!sessionStorage.getItem('hwCatRetry')) {
          try { sessionStorage.setItem('hwCatRetry', '1'); } catch { }
          opts?.onLive?.('目录未解析出节点，刷新一次再试');
          setTimeout(() => location.reload(), 800);
        } else {
          try { sessionStorage.removeItem('hwCatRetry'); } catch { }
          opts?.onNote?.('刷新后目录仍没有节点，按已完成处理，翻下一门');
          await reportCourseDone(q.courses[q.index] && q.courses[q.index].key);
        }
      }
      return true;
    }
    if (kind === 'study') {
      if (limitedRun(q) && !q.courses[q.index]?.chapterIds?.length) {
        await returnToCatalog();
        return true;
      }
      /* 目录是站点异步画的，偶尔比脚本慢很多。以前等 15 秒就放弃，整轮就停在这一页不动
         （2026-10-21 实测：换了章节后队列直接摆烂）。改成等 45 秒，还不行就过几秒重试，
         最多 3 次；真拿不到才报错保留队列。 */
      const ok = await until(() => nodes().length > 0, 45000);
      if (!ok) {
        const o = opts || {};
        if (resumeRetry < 3) {
          resumeRetry += 1;
          if (o.onLive) o.onLive(`目录还没出来，${resumeRetry}/3 次重试接续`);
          setTimeout(() => { resumeQueued(opts).catch(() => { }); }, 6000);
          return true;
        }
        resumeRetry = 0;
        if (o.onNote) o.onNote('这一页没等到目录，保留队列，请刷新后接续');
        return true;
      }
      resumeRetry = 0;
      start({ rate: q.rate, autoRate: q.autoRate, chapterIds: q.courses[q.index]?.chapterIds,
        onLive: opts && opts.onLive, onNote: opts && opts.onNote, onStop: opts && opts.onStop });
      return true;
    }
    /* 页面还没进入可用状态（刚跳转/还在画）：也给一次延迟重试的机会。 */
    if (resumeRetry < 3) {
      resumeRetry += 1;
      setTimeout(() => { resumeQueued(opts).catch(() => { }); }, 6000);
      return true;
    }
    resumeRetry = 0;
    return false;
  }

  /* ---------------- 视频：守倍速 + 点播放 + 等播完 ---------------- */

  let lastKick = 0;
  let kickFails = 0;
  let lastRateTry = 0;
  let rateBusy = false;
  let menuSupport = null; // null=还没确认；true=菜单里有这档；false=没有
  let menuClickedRate = 0; // 已经用播放器菜单切到过的档位，用来避免反复点菜单

  /* 找倍速菜单里对应的那一项。菜单项文本形如 "2x" / "1.5x" / "1x, 选择"，
     字幕那几项的文本以中文开头，正则匹配不到，不会点错。
     只认展开后看得见的项：菜单没打开时 videojs 里的项点在隐藏容器里，点了不算数。 */
  function menuItem(want, root, loose) {
    for (const d of root ? [root] : docs()) {
      let items;
      try { items = d.querySelectorAll('.vjs-menu-item'); } catch { continue; }
      for (const li of items) {
        const m = /^([\d.]+)\s*x/i.exec((li.textContent || '').trim());
        if (m && Math.abs(Number(m[1]) - want) < 0.01 && (loose || visible(li))) return li;
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

  /* 每个视频、每个目标档位只尝试一次原生菜单；不强写倍速，不与站点重置拉扯。
     站点偶尔会把 playbackRate 重置回 1x，所以允许「再纠正 2 次、间隔 45 秒」，
     既不放弃速度，也不会变成每 500ms 弹一次菜单的机器行为。 */
  let rateFixes = 0;
  let rateNoted = false; // 已经提示过「这门没有倍速」，只提示一次
  async function applyRate(v) {
    if (!v || v.ended) return;
    if (autoRate) {
      const m = menuMaxRate(v.ownerDocument);
      if (m && Math.abs(m - rate) > 0.01) rate = m;
    }
    if (Math.abs(v.playbackRate - rate) < 0.01) return; // 已经是目标倍速
    const driftedRetry = rateFixes < 3 && Date.now() - lastRateTry >= 20000;
    const wantMenu = menuSupport !== false && (Math.abs(menuClickedRate - rate) > 0.01 || driftedRetry);
    // 菜单路线：限速 2.5s 一次，免得每 500ms 把播放器菜单弹一遍
    if (wantMenu && !rateBusy && Date.now() - lastRateTry >= 2500) {
      lastRateTry = Date.now();
      menuClickedRate = rate;
      rateBusy = true;
      rateFixes += 1;
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
            await wait(350);
            item = menuItem(rate, v.ownerDocument);
            /* 有的皮肤给菜单容器加了 transition，350ms 还量不到尺寸（宽高为 0），
               但项本身是存在的、点了就生效 —— 这时候放宽可见性要求再找一次。 */
            if (!item) item = menuItem(rate, v.ownerDocument, true);
          }
          if (item) {
            menuSupport = true;
            clicked = true;
            menuClickedRate = rate;
            try { item.click(); } catch { /* 同上 */ }
            await wait(150);
          } else {
            menuSupport = false; // 站点菜单里确实没有这一档
            /* 有的课播放器把倍速菜单整个留空（站点按课程配置关掉了），
               这时候只能按 1x 播；提一句就够，别每个视频都念一遍。 */
            if (!rateNoted) {
              rateNoted = true;
              live('这门的播放器没提供倍速选项（站点限制），按 1x 播放');
            }
          }
        }
      } finally {
        rateBusy = false;
      }
      if (!on || v.ended) return;
      if (Math.abs(v.playbackRate - rate) < 0.01) return; // 点菜单就生效了
      if (opened && !clicked && toggle) { try { toggle.click(); } catch { /* 菜单关不上就算了 */ } }
    }
  }

  /* 让视频播起来：只点播放器自己的播放按钮（用户手点的等价动作）。
     浏览器在「没有用户手势」的页面（比如脚本自己 F5 之后）会拦掉 play()，
     这时点多少遍都没用，所以最多尝试两次后停手、只提示一次
    （真实页面 2026-10-20 实测：F5 后连刷 9 条「视频点不起来」）。 */
  function kick(v) {
    if (!v || v.ended || !v.paused) return;
    if (kickFails >= MAX_KICK_FAIL) return; // 已经放弃这一节，别再点
    if (Date.now() - lastKick < 4000) return;
    lastKick = Date.now();
    const attempt = videoAttempt;
    try { v.muted = muted; } catch { /* 静音设不上也不影响后面点按钮 */ }
    const doc = v.ownerDocument;
    const btn = pick('.vjs-big-play-button', doc) || pick('.vjs-play-control', doc);
    if (btn) { try { btn.click(); } catch { /* 控件可能正好被重建，忽略 */ } }
    setTimeout(() => {
      if (!on || attempt !== videoAttempt || v.ended || v.isConnected === false || !v.paused) { kickFails = 0; return; }
      /* 有的课把播放按钮画在 canvas 里、或者被遮罩挡住，点按钮没反应。
         再点一次画面本身——原生播放器点画面就是播放/暂停，仍然是模拟点击，
         不改任何播放器状态（2026-10-21 赌徒的困惑实测：按钮点了两轮还在 37 秒停着）。 */
      try { v.click(); } catch { /* 画面被别的层盖住时忽略 */ }
      setTimeout(() => {
        if (!on || attempt !== videoAttempt || v.ended || v.isConnected === false || !v.paused) { kickFails = 0; return; }
        if (++kickFails >= MAX_KICK_FAIL) {
          videoFailure = new Error('视频无法启动：点击播放后仍保持暂停');
        }
      }, 1200);
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

  function setRate(value, automatic = false) {
    rate = Math.min(16, Math.max(0.25, Number(value) || 2));
    autoRate = !!automatic;
  }

  /* ---------------- 页签：切到第 n 个，并等它加载完 ---------------- */

  async function goto(tabIndex) {
    const li = tabList()[tabIndex];
    if (!li) return false;
    if (!tabActive(li)) {
      /* 页签切换也给个随机停顿：同一节里连点四个页签太像脚本。 */
      await step(jitter(TAB_GAP));
      try { li.click(); } catch { return false; }
      await step(TAB_WAIT);
    } else {
      await step(300);
    }
    let frame = document.querySelector('#iframe');
    if (!frame) return true;
    const chapter = activeChapterId();
    const deadline = Date.now() + 45000;
    let softUntil = 0;
    /* 站点收到页签点击后偶尔停在半路：#iframe 的 src 被清成无参数（cards?）就再也不动
       ——2026-10-23 异常记录里 5 次「页签加载失败」全是这种状态，白等 45 秒还把这一
       页签的任务点全落下。15 秒 iframe 毫无变化就再点一次页签，最多两次。 */
    const frameState = () => {
      try { return (frame ? String(frame.getAttribute('src') || '') : 'gone') + '|' + (frame?.contentDocument?.URL || ''); } catch { return '?'; }
    };
    let lastState = frameState();
    let lastMove = Date.now();
    let reClicks = 0;
    while (on && Date.now() < deadline) {
      frame = document.querySelector('#iframe');
      let card;
      try { card = frame?.contentDocument; } catch { /* 等待同源章节卡片 */ }
      if (frameState() !== lastState) { lastState = frameState(); lastMove = Date.now(); }
      else if (reClicks < 2 && Date.now() - lastMove > 15000) {
        reClicks++;
        lastMove = Date.now();
        try { li.click(); } catch { /* 点不动就继续等 */ }
        await step(TAB_WAIT);
        continue;
      }
      if (card?.body && card.readyState === 'complete') {
        const url = new URL(card.URL, location.href);
        const expected = new URL(frame.src || location.href, location.href);
        if (frame.hasAttribute('srcdoc')) return true;
        const isCards = expected.pathname.includes('/knowledge/cards');
        if (isCards && url.pathname.includes('/knowledge/cards') &&
            url.searchParams.get('knowledgeid') === chapter && Number(url.searchParams.get('num')) === tabIndex) {
          return true;
        }
        if (!isCards) {
          /* 实训／实验／投票这类不是 cards 模块。原来这里立刻返回 true，页签内容还没画出来
             就被当成「处理过了」——openGauss 的【练】页签就是这样空过的（2026-10-22 审计）。
             改成等正文真的出现，最多 8 秒；等不到也放行，不能让一个模块把整轮拖住。 */
          if (!softUntil) softUntil = Date.now() + 8000;
          const body = (card.body.innerText || '').trim();
          if (body.length > 20 || card.querySelector('video,audio,iframe,form,input,canvas')) return true;
          if (Date.now() > softUntil) return true;
        }
      }
      await step(300);
    }
    note(`页签「${li.textContent.trim()}」尚未加载完成，不把它算作已处理`);
    return false;
  }

  /* 当前页签里是什么任务点。ended 的视频也算视频页：findVideo() 把它挪开是为了
     接着守第二个，但分类上它仍是视频任务点，交回 watchVideo 用 everEnded 收尾。 */
  let activeQuizFrame = null;
  let activeQuizId = '';
  function quizDocuments(root) {
    if (!root) return [];
    const out = [];
    const QUIZ = '.questionLi,.TiMu,.Zy_TItle,.exam-question,.mark_item,input[name^="answer"]';
    for (const d of docs(root)) {
      try {
        if (/\/page\/questionnaire\//.test(d.URL || '') || d.querySelector('#answer_form .question-lists')) continue;
        let frame = d.defaultView?.frameElement;
        while (frame && visible(frame)) frame = frame.ownerDocument.defaultView?.frameElement;
        if (frame) continue;
        if ([...d.querySelectorAll(QUIZ + ',.Finalresult')].some(visible)) out.push(d);
      } catch { /* 跨域文档跳过 */ }
    }
    return out;
  }
  function quizDocument() {
    try {
      const root = activeQuizFrame ? activeQuizFrame.contentDocument : document.querySelector('#iframe')?.contentDocument || document;
      return quizDocuments(root)[0] || null;
    } catch { return null; }
  }
  const quizRetryKey = () => activeChapterId() + (activeQuizId ? ':' + activeQuizId : '');
  function quizActionDocuments() {
    if (!activeQuizFrame) return docs();
    const roots = docs(activeQuizFrame.contentDocument);
    for (let frame = activeQuizFrame; frame; frame = frame.ownerDocument.defaultView?.frameElement) roots.push(frame.ownerDocument);
    return [...new Set(roots)];
  }

  async function runQuizzes() {
    const my = gen, chapter = activeChapterId();
    const cards = document.querySelector('#iframe');
    let root;
    try { root = cards?.contentDocument || document; } catch { return; }
    const frames = [...root.querySelectorAll('iframe')].filter(frame =>
      /\/ananas\/modules\/work\//.test(frame.getAttribute('src') || '') && visible(frame));
    for (const quiz of quizDocuments(root)) {
      let frame = quiz.defaultView?.frameElement;
      while (frame && frame.ownerDocument !== root && frame !== cards) frame = frame.ownerDocument.defaultView?.frameElement;
      if (!frames.includes(frame || cards)) frames.push(frame || cards);
    }
    const done = new Set();
    for (const [index, frame] of frames.entries()) {
      if (!on || my !== gen || activeChapterId() !== chapter) return;
      if (frame && !frame.isConnected) continue;
      let data = {};
      try { data = JSON.parse(frame?.getAttribute('data') || '{}'); } catch { /* 使用当前页签内的顺序作为兜底 */ }
      const id = String(frame?.getAttribute('jobid') || data.jobid || data._jobid || (tabList().find(tabActive)?.id || 'card') + '-frame-' + index);
      if (done.has(id)) continue;
      done.add(id);
      activeQuizFrame = frame;
      activeQuizId = id;
      try {
        const ready = await until(() => quizDocument(), 15000);
        if (!on || my !== gen || activeChapterId() !== chapter) return;
        if (!ready) {
          await recordWatchSkip(new Error('测验内层题目未加载，未计为完成'), { task: '章节测验 ' + (index + 1) }, true);
          continue;
        }
        await runQuiz();
      } catch (e) {
        if (e === STOP || e.code === 'HW_VERIFICATION_REQUIRED') throw e;
        await recordWatchSkip(e, { task: '章节测验 ' + (index + 1) }, true);
      } finally {
        if (my === gen) { activeQuizFrame = null; activeQuizId = ''; }
      }
    }
  }

  function classify() {
    if (findVideo() || allVideos().some((v) => v.ended)) return 'video';
    if (quizDocument()) return 'quiz';
    return 'text';
  }

  /* ---------------- 主循环 ---------------- */

  let on = false;
  let scopeChapters = null;
  let gen = 0; // 每次 start/stop 自增：旧循环发现代号变了就自己退出
  let rate = 2;
  let courseTiming = null;
  let videoFailure = null;
  let lastQuizGrade = null; // 本节最近一次交卷的测验成绩，收尾解释「剩 1 个任务点」用
  let chapterSkipTrail = []; // 本节过程性跳过的原因清单（quiet 时收集，收尾汇总进未完成记录）
  let videoAttempt = 0;
  const failedChapters = new Set();
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
    checkVerification();
    dismissQuizRetryNotice();
  }

  async function watchVideo() {
    videoFailure = null;
    videoAttempt++;
    let deadline = Date.now() + VIDEO_WAIT;
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
        if (chapter && unfinishedOf(chapter) === 0) return true;
        if (everEnded || videoJobsDone()) return true;
        if (Date.now() > deadline) {
          /* 页签里没有未完成的视频角标就不算失败：拓展练习这类页签只有站点模板的
             空壳 video（无 src），上一节播完的 ended 让 classify 误进视频分支，
             空等 12 秒后原来按失败跳过整页（2026-10-24 异常记录 3 组）。 */
          if (!videoJobs().some((ic) => ic.parentElement && !ic.parentElement.classList.contains('ans-job-finished'))) {
            live('这一页没有待播的视频任务点');
            return true;
          }
          note('这一节没出现视频，跳过视频页');
          return false;
        }
        await step(400);
      }
      clearInterval(guard);
      // 每次只操作尚未播完的视频，播放器控件限定在该视频的 iframe 中。
      myGuard = setInterval(() => {
        if (!on || document.hidden) return;
        const v = findVideo(endedEls);
        if (!v) return;
        if (v.paused) kick(v); else kickFails = 0;
        applyRate(v);
      }, TICK);
      guard = myGuard;
      let current = null;
      let lastPosition = 0;
      let lastAdvance = 0;
      let hiddenSince = 0;
      let hiddenTries = 0, hiddenTryAt = 0;
      let reloaded = false;
      const reloadPlayer = async v => {
        if (reloaded) return false;
        let frame;
        try { frame = v.ownerDocument.defaultView.frameElement; } catch { return false; }
        if (!frame?.isConnected || !/\/ananas\/modules\/(video|audio)\//.test(frame.src)) return false;
        checkVerification();
        reloaded = true;
        videoAttempt++; kickFails = 0; videoFailure = null; lastKick = 0;
        hiddenTries = 0; hiddenTryAt = 0;
        deadline = Date.now() + VIDEO_WAIT;
        frame.src = frame.src;
        live('播放恢复失败，重新加载播放器后继续一次');
        await step(750);
        return true;
      };
      while (on) {
        if (chapter && activeChapterId() !== chapter) return false;
        if (chapter && unfinishedOf(chapter) === 0) return true;
        hookEnded();
        for (const v of pendingVideos()) if (v.ended) markEnded(v);
        const v = findVideo(endedEls);
        if (v) {
          if (v !== current) {
            current = v;
            videoAttempt++;
            hiddenSince = 0; hiddenTries = 0; hiddenTryAt = 0;
            lastPosition = v.currentTime;
            lastAdvance = Date.now();
            kickFails = 0; lastKick = 0; lastRateTry = 0;
            menuSupport = null; menuClickedRate = 0; rateFixes = 0;
            try { v.ownerDocument.defaultView.frameElement?.scrollIntoView({ block: 'center' }); } catch { /* 框架刚换页 */ }
          }
          if (v.currentTime > lastPosition + 0.2) {
            lastPosition = v.currentTime;
            lastAdvance = Date.now();
            hiddenTries = 0; hiddenTryAt = 0;
          }
          if (document.hidden && v.paused) {
            if (v.error) {
              if (await reloadPlayer(v)) continue;
              throw new Error('播放器重新加载后仍报错：' + (v.error.message || v.error.code));
            }
            if (!hiddenSince) hiddenSince = Date.now();
            /* 先在原播放器里恢复，最多两轮、间隔至少 5 秒；只有真实播放进展才重置次数。 */
            if (hiddenTries < MAX_KICK_FAIL && (!hiddenTries || Date.now() - hiddenTryAt >= 5000)) {
              checkVerification();
              hiddenTries++; hiddenTryAt = Date.now();
              kick(v);
            }
            if (hiddenTries >= MAX_KICK_FAIL && Date.now() - hiddenTryAt >= 2500) {
              if (await reloadPlayer(v)) continue;
              throw new Error('后台播放自动恢复仍失败，保留未完成并继续后续任务');
            }
            lastAdvance = Date.now();
            live(`正在后台恢复播放（${hiddenTries}/${MAX_KICK_FAIL}）`);
            await step(1000);
            continue;
          }
          if (hiddenSince && !document.hidden) {
            videoAttempt++; kickFails = 0; videoFailure = null; lastKick = 0;
            hiddenTries = 0; hiddenTryAt = 0;
          }
          hiddenSince = 0;
          if (v.error || Date.now() - lastAdvance >= 150000) {
            if (await reloadPlayer(v)) continue;
            throw new Error(v.error ? '播放器错误：' + (v.error.message || v.error.code) : '播放停滞超过150秒');
          }
          if (videoFailure) {
            if (await reloadPlayer(v)) continue;
            throw videoFailure;
          }
          const pct = v.duration ? Math.round((v.currentTime / v.duration) * 100) : 0;
          live(`${fmtRate(v.playbackRate)}x ${pct}%`);
          await applyRate(v);
        } else {
          /* 没有可守的视频了：要么全部播完（返回成功），要么本来就没有（等不到）。
             everEnded 已由 ended 事件置位，不受轮询窗口漏检影响。 */
          if (everEnded || videoJobsDone()) return true;
          if (Date.now() > deadline) {
            if (!videoJobs().some((ic) => ic.parentElement && !ic.parentElement.classList.contains('ans-job-finished'))) {
              live('这一页没有待播的视频任务点');
              return true;
            }
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
    const roots = quizActionDocuments();
    if (roots.some(doc => { const dialog = doc.querySelector('#workpop'); return visible(dialog) && QUIZ_RETRY_NOTICE.test(dialog.textContent || ''); })) return null;
    for (const d of roots) {
      let el = null;
      try { el = d.querySelector('#popok'); } catch { /* 换下一层文档 */ }
      if (el && visible(el)) return el;
    }
    for (const d of roots) {
      let el = null;
      try { el = d.querySelector('#workpop .jb_btn_92, .maskDiv .jb_btn_92'); } catch { /* 同上 */ }
      if (el && visible(el)) return el;
    }
    return findButton(/^(确定|确认)$/, roots);
  }

  function findButton(re, roots = docs()) {
    for (const sel of [CLICKABLE, 'span,div']) {
      for (const d of roots) {
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
    const quiz = quizDocument();
    if (quiz && findButton(/^提交$/, [quiz])) return false;
    if (quiz && (/selectWorkQuestionYiPiYue/.test(quiz.URL || '') || /查看已批阅作业/.test(quiz.title || '') || quiz.querySelector('.Finalresult'))) return true;
    const roots = quiz ? [quiz] : docs();
    const t = roots.map((d) => d.body?.innerText || '').join(' ');
    if (/任务点已完成|查看已批阅|已交卷/.test(t)) return true;
    if (/已完成.{0,6}章节测验/.test(t)) return true;
    /* 交过卷的页面根本没有「提交」按钮，只剩「第1次作答本次成绩…」这类回执。
       所以「页面上没有『提交』又没有『待完成』」就当已经交过，别把已完成的节当成失败。 */
    if (!/待完成|任务点未完成|未交卷/.test(t) && !findButton(/^提交$/, roots)) return true;
    return false;
  }

  function quizGrade() {
    const quiz = quizDocument();
    for (const d of quiz ? [quiz] : docs()) {
      if (d === document && !quiz) continue;
      const text = d.body?.innerText || '';
      const score = text.match(/本次成绩\s*([\d.]+)\s*分/);
      const total = text.match(/满分\s*[:：]?\s*([\d.]+)/);
      if (score && total) return { score: Number(score[1]), total: Number(total[1]),
        attempt: Number(text.match(/第\s*(\d+)\s*次作答/)?.[1]) || null,
        question: d.querySelector('.TiMu .fontLabel,.mark_name')?.innerText || '',
        answer: text.split('我的答案：')[1]?.slice(0, 1200) || '' };
    }
    return null;
  }

  const quizRetrySignals = new Set();
  const quizGrades = new Map();
  function rememberQuizGrade(grade) {
    if (!grade) return;
    lastQuizGrade = { chapter: activeChapterId(), quizKey: quizRetryKey(), score: grade.score, total: grade.total };
    quizGrades.set(lastQuizGrade.quizKey, lastQuizGrade);
  }
  const QUIZ_RETRY_NOTICE = /未达(?:到)?及格线[，,、\s]*(?:请)?重做/;
  function dismissQuizRetryNotice() {
    for (const doc of quizActionDocuments()) {
      const dialog = doc.querySelector('#workpop');
      if (!visible(dialog) || !QUIZ_RETRY_NOTICE.test(dialog.textContent || '')) continue;
      const key = quizDocument() ? quizRetryKey() : lastQuizGrade?.quizKey || lastQuizGrade?.chapter || activeChapterId();
      quizRetrySignals.add(key);
      const close = [...dialog.querySelectorAll('#popno,#popCloseFocus,.popClose')].find(visible);
      if (close) { close.click(); return true; }
    }
    return false;
  }

  async function submitQuiz() {
    if (quizDone()) {
      live('测验页：这一节已经交过了，跳过提交');
      return true;
    }
    const quiz = quizDocument();
    const btn = findButton(/^提交$/, quiz ? [quiz] : docs());
    if (!btn) {
      note('测验页：没找到「提交」按钮，这一节不算完成');
      return false;
    }
    /* 填完先停一会儿再提交：真实用户不会瞬间交卷，固定零延迟也是机器特征。 */
    live('测验页：检查完再提交…');
    await step(jitter(SUBMIT_GAP));
    if (!on) return false;
    try { btn.click(); } catch { note('测验页：提交按钮点不动'); return false; }
    live('测验页：提交中…');
    // 站点会弹一层「确认提交？」对话框，按钮是「确定」（不是「提交」）
    for (let i = 0; i < 20 && on; i++) {
      await step(500);
      if (quizDone() && quizGrade()) {
        const grade = quizGrade();
        rememberQuizGrade(grade);
        live(`测验已交卷：${grade.score}/${grade.total}，任务点以平台回执为准`);
        return true;
      }
      const yes = findConfirm();
      if (yes) {
        await step(jitter(600)); // 确认框出现后短暂停顿
        try { yes.click(); } catch { /* 对话框可能刚被换掉 */ }
        await step(1500);
        if (unfinishedOf(activeChapterId()) === 0) live('测验页：已提交，任务点已完成');
        else live('测验页：已点提交，结果请在页面上核对');
        let grade = quizGrade();
        for (let check = 0; check < 10 && on && !grade; check++) { await step(250); grade = quizGrade(); }
        if (grade) {
          live(`测验成绩：${grade.score}/${grade.total}`);
          rememberQuizGrade(grade);
          /* 用户 2026-10-22 明确「先刷完，不强求正确率」：低分只记日志，不再暂停整轮
             （留空提交的卷子分数必然低，暂停只会让任务点永远计不上）。 */
          if (limitedRun(multi) && grade.total > 0 && grade.score / grade.total < .8) {
            note(`测验仅得 ${grade.score}/${grade.total}（低于 80%）。按「先刷完」约定不暂停，错题自己回头核对`);
          }
        } else if (limitedRun(multi)) {
          note('测验已提交但成绩尚未返回，继续下一节');
        }
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

  async function runQuiz(retry = false) {
    if (!on) return false;
    const my = gen, chapter = activeChapterId();
    dismissQuizRetryNotice();
    if (quizDone()) {
      const grade = quizGrade();
      rememberQuizGrade(grade);
      live('测验页：已经交卷，保留平台任务点状态');
    } else {
      const P = HW.Panel;
      if (!P || typeof P.runHomework !== 'function') {
        note('测验页：面板没有暴露自动答题，跳过');
        return;
      }
      live('测验页：AI 答题中…');
      try {
        const r = await P.runHomework({ timeout: QUIZ_TIMEOUT, retry });
        live('测验页：' + (r || '已填写'));
      } catch (e) {
        /* 这一份测验读不出来（字形无法唯一还原、图片题、结构不认识…）：
           不提交、也不算完成，但**不要停整轮**——停下来就永远刷不完剩下的课，
           而限定的这几节本来就有「补刷一轮、仍不行就记下继续」的兜底。
           真正需要人来的只有验证码，那条在 checkVerification 里会暂停。（2026-10-21） */
        if (e === STOP || e.code === 'HW_VERIFICATION_REQUIRED') throw e;
        await recordWatchSkip(e, { task: '章节测验', submitted: false }, true);
        return false;
      }
      if (!on || my !== gen || activeChapterId() !== chapter) return false;
      await step(300);
      if (activeChapterId() !== chapter) return false;
      await submitQuiz();
    }
    if (!on || my !== gen || activeChapterId() !== chapter) return false;
    const quiz = quizDocument();
    if (!quizRetrySignals.has(quizRetryKey()) && !QUIZ_RETRY_NOTICE.test(quiz?.body?.innerText || '')) return true;
    const failed = async message => {
      await recordWatchSkip(new Error(message), { task: '章节测验重做', score: quizGrade() }, true);
      if (on && my === gen) dismissQuizRetryNotice();
      return false;
    };
    if (retry) return failed('平台仍提示未达及格线，本轮已重做一次，保留未完成并继续后续章节');
    const redo = [...(quiz?.querySelectorAll('a.jb_btn_bg,button') || [])].find(el => visible(el) && !el.disabled
      && /^重做/.test(el.textContent.trim()) && !/剩余\s*0\s*次/.test(el.textContent));
    if (!redo) return failed('平台要求重做，但没有可用的原生重做入口，保留未完成');
    const claim = await chrome.runtime.sendMessage({ type: 'HW_WATCH_QUIZ_RETRY', payload: { key: currentCourse()?.key, chapterId: chapter, quizId: activeQuizId || undefined } });
    if (!on || my !== gen || activeChapterId() !== chapter) return false;
    if (!claim?.ok || !claim.first) return failed(claim?.ok ? '本轮已经重做过这份测验，保留未完成并继续' : '无法登记本轮重做次数，未重复交卷：' + (claim?.error || '后台无回执'));
    quizRetrySignals.delete(quizRetryKey());
    live('平台要求重做：正在打开本轮唯一一次重做');
    redo.click();
    let confirmed = false;
    const ready = await until(() => {
      const next = quizDocument();
      if (activeChapterId() !== chapter) return null;
      if (next && !quizDone() && findButton(/^提交$/, [next])) return true;
      if (!confirmed) for (const doc of docs()) {
        const dialog = doc.querySelector('#workpop');
        if (!visible(dialog) || !/重做|重新作答/.test(dialog.textContent || '')) continue;
        const yes = dialog.querySelector('#popok');
        if (visible(yes)) { confirmed = true; yes.click(); break; }
      }
      return null;
    }, 15000);
    if (!on || my !== gen || activeChapterId() !== chapter) return false;
    if (!ready) return failed('原生重做入口未打开新的答题页，保留未完成并继续');
    return runQuiz(true);
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
    return `学习了「${shortName(cur.name)}」这一节。` +
      (excerpt ? `材料里提到：${excerpt}。` : '') +
      '我的体会是：把这些道理放到自己的学习和生活里对照，从小事做起，慢慢就有自己的理解。';
  }

  async function runDiscuss(cur) {
    if (postedSet().has(String(cur.id))) {
      live(`讨论：这一节发过帖子了，不重复发：${shortName(cur.name)}`);
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
      live(`讨论：已在「${shortName(cur.name)}」回复了一条讨论`);
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
      live(`讨论：已在「${shortName(cur.name)}」发了一条新话题`);
      return;
    }
    note('讨论页：这一节没有可发的讨论（可能只许老师发帖），跳过');
  }

  /* 收尾诊断：列出本节还挂着哪些未完成任务点（角标类型 + 所在框架），讨论卡单独说明。 */
  function unfinishedJobSummary() {
    const out = [];
    for (const d of docs()) {
      try {
        for (const ic of d.querySelectorAll('.ans-job-icon')) {
          if (ic.parentElement && ic.parentElement.classList.contains('ans-job-finished')) continue;
          const kind = ic.classList.contains('ans-job-video') ? '视频' : ic.classList.contains('ans-job-work') ? '测验/作业' : '阅读/其他';
          const frame = d === document ? '主文档' : String(d.URL || '').replace(/^https?:\/\/[^/]+\//, '/').slice(0, 50);
          out.push(kind + '（' + frame + '）');
        }
      } catch { /* 跨域文档跳过 */ }
    }
    if (bbsCard()) { out.push('讨论卡待处理'); return out; }
    for (const d of docs()) {
      try {
        for (const h of d.querySelectorAll('.ans-attach-ct')) {
          const src = h.querySelector('iframe')?.src || '';
          if (src.includes('/ananas/modules/insertbbs/') && !h.classList.contains('ans-job-finished') && bbsTried.has(bbsKeyOf(h))) {
            out.push('讨论卡本轮已尝试处理，但未确认平台任务点完成');
            return out;
          }
        }
      } catch { /* 跨域文档跳过 */ }
    }
    if (!out.length) out.push('当前页签未发现未完成角标，目录仍有剩余；需核对其他页签或平台计数');
    return out;
  }

  async function recordWatchSkip(error, context = {}, quiet = false) {
    failedChapters.add(activeChapterId());
    const message = String(error?.message || error);
    /* 节内的过程性跳过（页签没加载、空壳卡、空壳视频、回执没等到…）只进日志不进异常
       记录；低分本身也不单独上报。收尾的「仍有 N 个任务点未完成」汇总这些节的结果。 */
    note('已跳过：' + message + (quiet ? '' : '（详情见诊断）'));
    if (quiet) {
      chapterSkipTrail.push(((context.task || '') ? context.task + '：' : '') + message);
      return;
    }
    const course = currentCourse();
    const chapter = nodes().find(n => n.id === activeChapterId());
    if (chapter && unfinishedOf(chapter.id) === 0) return;
    const details = {
      chapterId: activeChapterId(), pageKind: pageKind(), rate,
      remainingJobs: chapter ? unfinishedOf(chapter.id) : null,
      queueIndex: multi?.index, targetRun: multi?.targetRun,
      tabs: tabList().map(t => ({ id: t.id, title: t.textContent.trim(), active: tabActive(t) })),
      media: pendingVideos().slice(0, 8).map(v => ({ currentTime: v.currentTime, duration: Number.isFinite(v.duration) ? v.duration : null,
        playbackRate: v.playbackRate, paused: v.paused, ended: v.ended, readyState: v.readyState, error: v.error?.message || v.error?.code || null })),
      ...context,
    };
    const payload = { stage: '刷课跳过', message, course: course?.name || context.course || multi?.courses[multi.index]?.name || document.title,
      chapter: context.chapter || chapter?.name || '', task: context.task || tabList().find(tabActive)?.textContent.trim() || '',
      url: location.href, action: '跳过出错任务，继续后续；未计为完成', stack: String(error?.stack || new Error(message).stack || ''),
      details: JSON.stringify(details, null, 2), scene: globalThis.HW?.Diagnostics?.capture() };
    try {
      const result = await chrome.runtime.sendMessage({ type: 'HW_ISSUE_ADD', payload });
      if (!result?.ok) note('异常记录保存失败：' + (result?.error || '后台无回执'));
    } catch (e) { note('异常记录保存失败：' + String(e.message || e)); }
  }

  const STALL_TIMEOUT = 5 * 60 * 1000;
  let stallState = null;
  let stallRecording = false;
  function progressSnapshot() {
    const chapterId = activeChapterId();
    const tab = tabList().find(tabActive);
    const documents = docs();
    const media = allVideos().map(v => ({ position: Math.floor(v.currentTime || 0),
      duration: Number.isFinite(v.duration) ? v.duration : null, paused: v.paused, ended: v.ended, readyState: v.readyState }));
    const frames = documents.map(doc => ({ path: new URL(doc.URL || location.href).pathname,
      readyState: doc.readyState, scroll: Math.floor(doc.scrollingElement?.scrollTop || 0),
      viewers: [...doc.querySelectorAll('#viewerContainer,#docContainer,.fileBox,.pdfViewer')].map(el => Math.floor(el.scrollTop || 0)),
      pages: [...doc.querySelectorAll('#pageNum,#pagenum,.current-page,[aria-label="页码"]')]
        .map(el => String(el.value || el.textContent || '').trim().slice(0, 40)) }));
    return { chapterId, taskId: tab?.id || '', remainingJobs: unfinishedOf(chapterId),
      finishedJobs: documents.reduce((count, doc) => count + doc.querySelectorAll('.ans-job-finished').length, 0),
      answers: (HW.questions || []).map(q => q._status || 'queued'), media, frames };
  }
  async function observeProgress(active = on) {
    if (!active) { stallState = null; return; }
    if (stallRecording) return;
    const state = progressSnapshot();
    // 播放按钮反复变暂停/播放、日志和倒计时变化都不算实际进展。
    const key = JSON.stringify({ ...state, media: state.media.map(v => [v.position, v.ended]),
      frames: state.frames.map(frame => [frame.path, frame.scroll, frame.viewers, frame.pages]) });
    const now = Date.now();
    if (!stallState || stallState.key !== key) { stallState = { key, since: now, reported: false }; return; }
    if (stallState.reported || now - stallState.since < STALL_TIMEOUT) return;
    stallState.reported = true;
    stallRecording = true;
    const chapter = nodes().find(n => n.id === state.chapterId);
    const message = '页面连续 5 分钟没有实际进展，已自动记录现场';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'HW_ISSUE_ADD', payload: {
        stage: '刷课停滞', message, course: currentCourse()?.name || document.title,
        chapter: chapter?.name || '', task: tabList().find(tabActive)?.textContent.trim() || '',
        url: location.href, action: '自动记录停滞现场，保留当前队列；未计为完成',
        details: JSON.stringify({ idleSeconds: Math.floor((now - stallState.since) / 1000),
          lastProgressAt: new Date(stallState.since).toISOString(), running: on,
          hidden: document.hidden, stopTrace: HW.Watch?.stopTrace, ...state }),
        scene: HW.Diagnostics?.capture(),
      } });
      note(result?.ok ? message : '停滞现场保存失败：' + (result?.error || '后台无回执'));
    } catch (e) { note('停滞现场保存失败：' + String(e.message || e)); }
    finally { stallRecording = false; }
  }

  async function courseLoop() {
    const my = gen;
    checkVerification();
    dismissQuizRetryNotice();
    const catalog = nodes();
    let list = scopeChapters ? catalog.filter(n => scopeChapters.has(n.id)) : catalog;
    if (scopeChapters && list.length !== scopeChapters.size) {
      throw new Error('本次限定的小节未完整加载，跳过当前课程，未确认完成');
    }
    if (!list.length) {
      throw new Error('学习页没有加载课程目录');
    }    /* 一律从目录第一节开始，不看当前打开的是哪一节：用户 2026-10-19 反馈
       他从第 43 节起刷，以为是随手挑的。从头刷完才是他要的。
       已经刷完的节（站点 jobUnfinishCount = 0）直接跳过，别让用户看着它重刷一遍。 */
    let i = 0;
    let skipped = 0;
    /* 预计用时只使用本次范围及成功任务的有效耗时样本。 */
    const timingCourse = currentCourse();
    const timingKey = timingCourse && courseTimeKey(timingCourse);
    let timing = timingKey ? (await chrome.storage.local.get(timingKey).catch(() => ({})))[timingKey] : null;
    courseTiming = timing;
    const leftText = () => {
      const jobs = scopeChapters ? list.reduce((sum, n) => sum + (unfinishedOf(n.id) || 0), 0) : remainingJobs();
      if (!unfinishedKnown()) return '剩余时间暂无法估算（任务数量未知）';
      if (!jobs) return '剩余：快了';
      const left = unfinishedKnown() ? estimateCourseSeconds({ done: 0, total: jobs }, rate, timing) : null;
      return `剩余${fmtLeft(left)}（${jobs} 个任务点）`;
    };
    const unfinishedKnown = () => list.length > 0 && list.every(n => unfinishedOf(n.id) !== null);
    live(`${scopeChapters ? `本次限定 ${list.length} 个小节` : `从第 1/${list.length} 节开始（从头刷）`}· ${leftText()}`);
      i = 0;
      skipped = 0;
      while (on && my === gen && i < list.length) {
      checkVerification();
      await dismissUnfinishedDialog(); // 挡在切节前的「还有任务点未完成」提示，选「去学习」
      const cur = list[i];
      chapterSkipTrail = []; // 本节的过程性跳过轨迹：收尾随「仍未完成」一起进异常记录
      if (unfinishedOf(cur.id) === 0) {
        skipped++;
        i++;
        continue;
      }
      try {
      const jobsBefore = unfinishedOf(cur.id);
      let chapterStartedAt = Date.now();
      const nowId = activeChapterId();
      if (nowId !== cur.id) {
        live(`进入 ${shortName(cur.name)}`);
        /* 只补足短章节的切换间隔；视频、答题等处理时间也计入。 */
        const gap = CHAPTER_GAP - (Date.now() - lastEnterAt);
        if (lastEnterAt && gap > 0) {
          const waitMs = jitter(gap);
          live(`等待 ${Math.ceil(waitMs / 1000)} 秒再进入下一节…`);
          await step(waitMs);
        }
        lastEnterAt = Date.now();
        if (!clickNode(cur.id)) {
          throw new Error(`第 ${i + 1} 节目录项无法打开`);
        }
        const dl = Date.now() + NODE_WAIT;
        let blocked = false;
        while (on && activeChapterId() !== cur.id && Date.now() < dl) {
          /* 站点有时不让离开还有任务点的章节，弹「是否去完成」挡住切节。
             点掉它（去学习）；被拦住的这一节本轮先放弃，别把整轮停在这里。 */
          if (await dismissUnfinishedDialog()) blocked = true;
          await step(300);
        }
        if (activeChapterId() !== cur.id) {
          throw new Error(blocked ? `站点阻止进入第 ${i + 1} 节` : `第 ${i + 1} 节打开超时`);
        }
        await step(600);
      }
      chapterStartedAt = Date.now();
      // 三个页签依次过；有「本章讨论」页签（dct4）的节多走一个
      let jumped = false; // 页面转去了别的章节（站点自动下一节 / 用户手动点节）
      /* 换节后站点会重建页签条，偶尔比 activeChapterId 晚一拍。以前这里直接取长度，
         拿到 0 就一个页签都不走、整节被跳过——2026-10-21 实测：openGauss 任务1.2
         明明还有 9 个任务点，日志里 0 秒就「检查完」了。等它画出来再数。 */
      await until(() => (tabList().length ? true : null), 12000);
      const tabs = tabList().length;
      if (!tabs) {
        await recordWatchSkip(new Error('章节页签未加载'), { chapter: cur.name }, true);
        i++;
        continue;
      }
      for (let t = 0; on && t < tabList().length; t++) {
        if (unfinishedOf(cur.id) === 0) break;
        /* 切页签前先处理站点的「还有任务点未完成」提示框：它盖在整页上，
           不点掉的话后面的点击全落在遮罩上，表现为「卡住」或「被带到下一节」。 */
        await dismissUnfinishedDialog();
        /* 页签数每轮重算：站点换卡会重建 .prev_ul，早先取的长度会过期（2026-10-22 审计）。
           单个页签超时不再直接 break 掉剩下的页签，最多容忍一个。 */
        if (!(await goto(t))) {
          await recordWatchSkip(new Error('页签加载失败'), { chapter: cur.name, task: `第 ${t + 1} 页签` }, true);
          continue;
        }
        if (activeChapterId() !== cur.id) {
          /* 页面自己跳走了：站点看完视频自动进下一节（正常推进），或者用户手动
             点了目录里别的节。两种都认账——转去处理当前打开的这一节，别把
             用户点的那节跳过去（2026-10-20 用户反馈：他把页面调回 5.2，脚本
             却越过 5.2、5.3 直奔 5.4）。 */
          jumped = true;
          break;
        }
        try {
        const rendered = await ensureCardRendered(t);
        if (activeChapterId() !== cur.id) {
          jumped = true;
          break;
        }
        if (!rendered) {
          await recordWatchSkip(new Error('页面刷新后仍为空壳卡片'), { chapter: cur.name, task: `第 ${t + 1} 页签` }, true);
          continue;
        }
        if (cardHasNoTasks()) { live('该页签暂无内容，继续检查后续任务'); continue; }
        await expandTaskCards();
        if (activeChapterId() !== cur.id) { jumped = true; break; }
        const kind = classify();
        let readCard = docs().some(d => [...d.querySelectorAll('.ans-attach-ct:not(.ans-job-finished) iframe')].some(frame => DOC_FRAME.test(frame.src)));
        let handled = false;
        live(`${shortName(cur.name)}｜${tabList()[t]?.textContent.trim() || '任务'}`);
        if (kind === 'video') {
          handled = true;
          readCard = true;
          /* 视频早就看完、剩下的是「本章讨论」这类别的任务点的节，不重看视频——
             站点在任务点角标的父元素上挂 .ans-job-finished，照抄它的判定
             （5.3 节 2026-10-20 实测：每次路过都把 15 分钟的视频重看一遍）。 */
          if (videoJobsDone()) {
            live(`这一节视频都已完成，不重看：${shortName(cur.name)}`);
          } else {
            const done = await watchVideo();
            if (!done) await recordWatchSkip(new Error('视频未播放完成即离开'), { chapter: cur.name }, true);
            else live(`视频看完：${shortName(cur.name)}`);
            await step(1200);
          }
          if (activeChapterId() !== cur.id) {
            jumped = true;
            break; // 站点自动进下一节
          }
        }
        if (bbsCard()) {
          handled = true;
          /* 讨论任务点：用户 2026-10-22 反馈「讨论点不会打开」。点开话题页、回一条
             切题短帖（bbs.js 在话题页里完成），这里等平台把角标翻绿再算完成。
             回帖成功后站点会重绘卡片区、甚至自己跳到下一个页签，紧接着再查
             bbsCard() 常常是空的。2026-10-23 实测：原来每节因此只做掉一张卡。
             这里回到本页签重新取卡，直到真的没有待完成卡；最多 12 张封顶。 */
          let bbsTries = 0;
          while (on && activeChapterId() === cur.id && bbsTries++ < 12) {
            if (!bbsCard()) {
              if (!(await goto(t))) break;
              if (!(await until(() => bbsCard(), 8000))) break;
            }
            if (!(await openBbsCard())) { await recordWatchSkip(new Error('讨论未收到完成回执'), { chapter: cur.name }, true); break; }
            live(`讨论已回帖：${shortName(cur.name)}`);
          }
          await step(1200);
          if (activeChapterId() !== cur.id) {
            jumped = true;
            break;
          }
        }
        if (surveyCard()) {
          handled = true;
          /* 学情调查／调查问卷：用户 2026-10-21 明确要求本人能填的问卷也要做。
             页面读不到问卷内部，靠 survey.js 在问卷页自己那一帧填写提交，
             这里只等目录角标归零（平台回执）再算完成。 */
          if (await openSurveyCard()) live(`问卷已提交：${shortName(cur.name)}`);
          else await recordWatchSkip(new Error('问卷自动恢复后90秒内仍未收到完成回执'), { chapter: cur.name }, true);
          await step(1200);
          if (activeChapterId() !== cur.id) {
            jumped = true;
            break;
          }
        } else if (kind === 'quiz') {
          handled = true;
          // 在本页签其他任务处理后逐份核验测验，不能只答第一份。
        } else if (!handled && /讨论/.test(tabList()[t]?.textContent || '')) {
          /* 第 4 个页签是「本章讨论」：替用户发一条相关短帖（用户 2026-10-20 批准）。
             发完站点自己会刷新任务点数；判过「发过」的节直接跳过不重发。 */
          await runDiscuss(cur);
          await step(600);
        } else if (!handled) {
          readCard = true;
          /* 阅读卡里可能嵌着视频任务点（两幅画各带一个介绍短片，2026-10-20 实测），
             只停留 4 秒就走的话任务点永远不计。先滚动把懒加载的视频带出来，
             出现了就走视频流程播完；真没有才纯停留。 */
          if (videoJobs().length && !videoJobsDone()) {
            if (revealJobs() && (await watchVideo())) live(`阅读页里的视频看完：${shortName(cur.name)}`);
            else note('阅读页里的视频没播完就离开了');
            await step(1200);
          } else {
            /* 音频任务点（大学英语里很多）没有 .ans-job-video 角标，走不到上面那个分支，
               但它一样是 video.js 播放器，播放按钮/倍速完全相同。先滚一遍让懒加载的
               播放器冒出来，再等它把播放器 UI 画出来（实测要 3~5 秒，等 600ms 太早，
               会误判成纯文本页然后一直不播）。 */
            revealJobs();
            const media = await until(() => findVideo(), 15000);
            if (media) {
              if (await watchVideo()) live(`阅读页里的音视频看完：${shortName(cur.name)}`);
              else note('阅读页里的音视频没播完就离开了');
              await step(1200);
            } else {
              await step(DWELL_TEXT);
            }
          }
        }
        if (activeChapterId() === cur.id && (kind === 'quiz' || quizDocument() || docs().some(d => d.querySelector('iframe[src*="/ananas/modules/work/"]')))) {
          await runQuizzes();
          await step(800);
        }
        if (readCard && activeChapterId() === cur.id && !textJobsDone()) {
          /* 剩下的非视频任务点（阅读/文档/PPT）常和视频同在一个页签里：只停几秒站点不计，
             必须把内容滚到底才算读过（2026-10-21 第一站实测：视频已完成，仍剩 1 个点）。
             这个检查放在视频分支之外，否则视频一播完就跳过去，永远走不到。 */
          if (await readThrough(45000)) live(`阅读任务点已完成：${shortName(cur.name)}`);
          else {
            const nudged = await nudgeCard();
            if (textJobsDone()) live(`阅读任务点已完成：${shortName(cur.name)}`);
            else note(`阅读任务点还没计上，留给收尾复查：${shortName(cur.name)}${nudged ? `（已试点 ${nudged} 个入口）` : ''}`);
          }
        }
        } catch (e) {
          if (e === STOP || e.code === 'HW_VERIFICATION_REQUIRED') throw e;
          await recordWatchSkip(e, { chapter: cur.name, task: `第 ${t + 1} 页签` }, true);
        }
      }
      if (jumped) live('页面自动换章，按目录继续；未完成任务会在收尾时补查');
      /* 每节走完复查一遍任务点数：站点说这节还剩几个就直接告诉用户，别让
         「日志说刷完了、角标还挂着 1」这种对不上（12.4 节 2026-10-20 实测：
         三页签都过完了，角标还剩 1——那一节的讨论任务点根本没发出去）。
         不自动重刷：重刷大概率卡在同一处，先把真相记进日志。 */
      const left = unfinishedOf(cur.id);
      if (on && my === gen && timingKey && jobsBefore !== null && left === 0 && !failedChapters.has(cur.id) && jobsBefore > left) {
        const secondsPerJob = (Date.now() - chapterStartedAt) / 1000 * rate / (jobsBefore - left);
        const samples = timing?.schema === 2 ? timing.samples || [] : [];
        timing = { ...timing, schema: 2, samples: secondsPerJob > 0 && secondsPerJob <= 1800
          ? [...samples, secondsPerJob].slice(-20) : samples };
      }
      const progress = courseProgress();
      if (on && my === gen && timingKey && progress) {
        timing = { ...timing, ...progress };
        courseTiming = timing;
        await chrome.storage.local.set({ [timingKey]: timing }).catch(() => {});
      }
      let leftNow = left;
      if (leftNow > 0 && on && activeChapterId() === cur.id) {
        /* 融思政等页签的讨论卡（insertbbs）是懒加载的：页签刚切过去时 bbsCard() 常常
           为空，整节被当纯阅读走完、process 里无痕（2026-10-24 异常记录 6 节）。收尾
           发现没做完时卡片多半已经冒出来——此刻补做再复查；第一次根本没做，不算重做。 */
        while (on && unfinishedOf(cur.id) > 0 && activeChapterId() === cur.id && bbsCard()) {
          live(`收尾补做讨论卡：${shortName(cur.name)}`);
          if (!(await openBbsCard())) break;
          await step(1500);
        }
        leftNow = unfinishedOf(cur.id);
      }
      if (leftNow > 0) {
        /* 测验低分是「剩 1 个任务点」的主因（2026-10-24 异常记录 41 组）：交卷了但站点
           不认低分卷为完成。分数、剩余任务点的类型与本节的过程性跳过轨迹都写进原因，
           导出记录即可看到「为什么没完成」的完整链条。 */
        const grades = [...quizGrades.values()].filter(g => g.chapter === cur.id);
        const g = grades.find(g => g.score < g.total) || grades[0];
        const quizNote = !g ? '' : g.score >= g.total ? '本节已读取的测验均为满分，其他任务仍待核对'
          : `本节测验 ${g.score}/${g.total} 分` + (quizRetrySignals.has(g.quizKey) ? '，平台提示未达及格线' : '，剩余任务点原因尚待核对');
        const trail = chapterSkipTrail.length ? '；过程：' + chapterSkipTrail.join('；') : '';
        await recordWatchSkip(new Error((`仍有 ${leftNow} 个任务点未完成` + (quizNote ? '；' + quizNote : '') + trail).slice(0, 300)),
          { chapter: cur.name, remainingJobs: leftNow, process: chapterSkipTrail.slice(), jobs: unfinishedJobSummary() });
      } else if (chapterSkipTrail.length) {
        /* 角标缺失（任务计数未知）的节凑不出 leftNow>0，但 quiet 轨迹里已经发生
           过真失败（测验没做成、页签没加载…）：不落一条，完整诊断就永远丢了。 */
        await recordWatchSkip(new Error('本节任务计数未知（页面没有角标），处理中有未完成事项'),
          { chapter: cur.name, remainingJobs: leftNow, process: chapterSkipTrail.slice(), jobs: unfinishedJobSummary() });
      }
      const completed = list.filter(n => unfinishedOf(n.id) === 0).length;
      live(`${scopeChapters ? '本次' : ''}已完成 ${completed}/${list.length} 节 · ${leftText()}`);
      i++;
      } catch (e) {
        if (e === STOP || e.code === 'HW_VERIFICATION_REQUIRED') throw e;
        await recordWatchSkip(e, { chapter: cur.name, task: '进入或处理章节' });
        i++;
      }
    }
    if (on && my === gen) {
      live(`本轮目录已检查（跳过已完成 ${skipped} 节）`);
      if (scopeChapters && list.some(n => unfinishedOf(n.id) === null)) {
        await recordWatchSkip(new Error('限定小节的任务计数未知，无法确认完成'), { task: '课程核验' });
        if (multi) await reportCourseDone(multi.courses[multi.index]?.key || '', { status: 'incomplete' });
        stop();
        return;
      }
      let pending = nodes().filter((n) => (!scopeChapters || scopeChapters.has(n.id)) && unfinishedOf(n.id) > 0);
      let remain = pending.reduce((sum, n) => sum + unfinishedOf(n.id), 0);
      // 播放器完成回执先到，目录角标可能晚几秒更新；先复查再决定是否补刷或暂停。
      if (scopeChapters && remain > 0) {
        for (let check = 0; check < 10 && on && my === gen && remain > 0; check++) {
          await step(500);
          pending = nodes().filter(n => scopeChapters.has(n.id) && unfinishedOf(n.id) > 0);
          remain = pending.reduce((sum, n) => sum + unfinishedOf(n.id), 0);
        }
      }
      if (remain > 0) {
        // 不重复进入出错小节，保留缺口并继续下一门。
        const gaps = pending.map((n) => ({ name: n.name, remain: unfinishedOf(n.id) || 0 }));
        note(`课程「${timingCourse?.name || document.title}」还有 ${gaps.length} 个小节未完成（跳过已完成 ${skipped} 节），${multi ? '记录缺口后继续下一门' : '本门课程已停止，缺口保留待处理'}：${gaps.map((g) => g.name).join('、')}`);
        live(`跳过 ${gaps.length} 节待人工`);
        try {
          const cur = multi && multi.courses[multi.index];
          const got = await chrome.storage.local.get('watchGaps').catch(() => ({}));
          const all = (got.watchGaps || []).filter((g) => g.course !== (cur ? cur.name : ''));
          all.push({ course: cur ? cur.name : (timingCourse && timingCourse.name) || '', sections: gaps, at: Date.now() });
          await chrome.storage.local.set({ watchGaps: all.slice(-20) }).catch(() => {});
        } catch { /* 记不上也不影响继续刷 */ }
        if (multi) {
          await reportCourseDone(multi.courses[multi.index]?.key || '', { status: 'incomplete', exceptions: gaps });
          return;
        }
        stop();
        return;
      }
      if (scopeChapters) {
        stop();
        note(`课程「${timingCourse?.name || document.title}」本次限定的 ${list.length} 个小节已完成，其余小节未纳入本次任务`);
        if (limitedRun(multi)) {
          if (!await returnToCatalog()) note('返回目录核验失败，队列保留在本页');
          return;
        }
        if (multi) await reportCourseDone(multi.courses[multi.index]?.key || '');
        return;
      }
      if (multi) {
        // 这门课走完了，交给后台跳下一门（后台会把标签页导航过去，这一页随后就没了）
        const cur = multi.courses[multi.index];
        note(`课程「${cur?.name || timingCourse?.name || document.title}」已完成（跳过已完成 ${skipped} 节），换下一门…`);
        live('换下一门…');
        await reportCourseDone(cur ? cur.key : '');
        return;
      }
      note(`课程「${timingCourse?.name || document.title}」已走完一遍（跳过已完成 ${skipped} 节，提交与最终成绩请自行核对）`);
      stop();
      return;
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

  /* 谁停的：循环偶尔会「无声无息」地退出，队列既没暂停也没结束，只能靠看门狗重新拉起来。
     把最近几次 stop() 的调用栈记在内存里（不发网络、不写存储），排查时一眼看到凶手。 */
  const stopTrace = [];
  function stop() {
    const was = on;
    on = false;
    gen++;
    activeQuizFrame = null;
    activeQuizId = '';
    clearInterval(guard);
    guard = 0;
    if (was) {
      const stack = String(new Error().stack || '').split('\n').slice(1, 4).map((s) => s.trim().slice(0, 90));
      stopTrace.push({ at: new Date().toISOString().slice(11, 19), stack });
      if (stopTrace.length > 5) stopTrace.shift();
      holdPaused();
    }
    live('已停止');
    if (was) {
      try { onStop(); } catch { /* 面板回调出错不影响脚本收尾 */ }
    }
  }

  function start(opts) {
    stop();
    scopeChapters = Array.isArray(opts?.chapterIds) && opts.chapterIds.length
      ? new Set(opts.chapterIds.map(String)) : null;
    rate = Math.min(16, Math.max(0.25, Number(opts && opts.rate) || 2));
    rateNoted = false; // 换课/重开都重新判断这门能不能倍速
    autoRate = !!(opts && opts.autoRate);
    live = (opts && opts.onLive) || (() => {});
    note = (opts && opts.onNote) || (() => {});
    onStop = (opts && opts.onStop) || (() => {});
    failedChapters.clear();
    bbsTried.clear(); // 新一轮重新认领讨论卡
    quizRetrySignals.clear();
    quizGrades.clear();
    on = true;
    gen++;
    live('准备中…');
    const my = gen;
    courseLoop().catch(async (e) => {
      if (my !== gen) return;
      if (e === STOP) return;
      if (e.code === 'HW_VERIFICATION_REQUIRED') {
        stop();
        try { await chrome.runtime.sendMessage({ type: 'HW_WATCH_PAUSE', payload: { reason: e.message } }); }
        catch { /* 当前页已停；后台不可用时不发起后续页面操作 */ }
        note(e.message);
        live('已暂停：请在网页手动完成验证码后继续');
        return;
      }
      await recordWatchSkip(e, { task: '课程处理', action: '跳过当前课程' });
      if (multi) await reportCourseDone(multi.courses[multi.index]?.key || '', { status: 'incomplete' });
      else note('本门课程已终止：' + String(e.message || e));
      stop();
    }).finally(() => { if (my === gen) stop(); });
  }

  HW.Watch = {
    observeProgress,
    quizDocument,
    start,
    stop,
    resumeQueued,
    courseLinks,
    courseTimeKey,
    estimateCourseSeconds,
    rememberCourseProgress,
    remainingSeconds: () => {
      const selected = nodes().filter(n => !scopeChapters || scopeChapters.has(n.id));
      const counts = selected.map(n => unfinishedOf(n.id));
      if (!selected.length || counts.some(n => n === null)) return null;
      return estimateCourseSeconds({ done: 0, total: counts.reduce((a, b) => a + b, 0) }, rate, courseTiming);
    },
    formatCourseTime: fmtLeft,
    catalogEntries,
    fourWindow,
    windowOf,
    enterCourse,
    pageKind,
    currentCourse,
    quizGrade,
    setMuted,
    setRate,
    findVideo,
    nodes,
    unfinishedOf,
    activeChapterId,
    get chapterIds() { return scopeChapters ? [...scopeChapters] : null; },
    get running() { return on; },
    get stopTrace() { return stopTrace.slice(); },
    get rate() { return rate; },
  };

  /* ---------- 文档/PDF 任务点：由预览器自己的框架去翻页 ----------
     文档、PPT、PDF 的阅读任务点长在跨域框架里（pan-yz.chaoxing.com/screen/… 或
     ananas/modules/pdf/…），顶层页面拿不到里面的滚动容器，站点只认框架自己报的阅读进度。
     所以谁在那个框架里，谁就自己把内容过一遍：滚到底、没有滚动条就点下一页。
     只在「后台队列正在跑」时动手，用户自己点开文档看的时候不会被打扰。 */
  const DOC_FRAME = /pan-yz\.chaoxing\.com\/screen|ananas\/modules\/(pdf|ppt|doc|image|insertdoc)/;
  function readPageState(reading) {
    return JSON.stringify(reading.map(d => [...d.querySelectorAll('#pageNum,#pagenum,#pageNumber,.page-number,.current-page,.pageNum,[aria-current="page"],[data-page-number]')]
      .map(el => el.value || el.getAttribute('data-page-number') || el.textContent.trim().slice(0, 40))));
  }
  function readNextButton(reading) {
    const buttons = reading.flatMap(d => [...d.querySelectorAll('button,a,input[type="button"],[role="button"]')]);
    const arrows = reading.flatMap(d => [...d.querySelectorAll('[class*="next"],[class*="arrow"]')]);
    return [...buttons, ...arrows].find(el => {
      if (el.querySelector('button,a,input[type="button"],[role="button"]')) return false;
      if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true' ||
          el.closest('aside,#sidebarContainer,#thumbnailView,.disabled,.is-disabled,.swiper-button-disabled,[aria-disabled="true"]')) return false;
      const text = (el.getAttribute('aria-label') || el.title || el.value || el.textContent || '').trim();
      return /下一页|下一张|next/i.test(text) || /next|swiper-button-next|arrow-right/i.test(String(el.className)) || /^(next|nextPage|next-page)$/i.test(el.id);
    });
  }
  async function readDocFrame() {
    let q = null;
    try { q = (await chrome.runtime.sendMessage({ type: 'HW_WATCH_QUEUE_GET' }))?.queue; } catch { return; }
    if (!q || q.paused) return;
    const deadline = Date.now() + 240000;
    const courseKey = q.courses?.[q.index]?.key;
    let checkedAt = Date.now(), idleSince = Date.now(), acted = false;
    let pageState = '', lastButton = null, lastClick = 0, unconfirmed = 0;
    while (Date.now() < deadline) {
      /* 检查频率独立于滚动节奏，暂停或换课后停止，不解除人工暂停。 */
      if (Date.now() - checkedAt >= 1000) {
        try {
          const now = (await chrome.runtime.sendMessage({ type: 'HW_WATCH_QUEUE_GET' }))?.queue;
          if (!now || now.paused || now.courses?.[now.index]?.key !== courseKey) return;
        } catch { return; }
        checkedAt = Date.now();
      }
      let moved = false;
      const reading = readingDocuments(document, true);
      for (const d of reading) {
        const progress = scrollReading(d);
        if (progress.manual) return;
        if (progress.moved) moved = true;
      }
      const state = readPageState(reading);
      const changed = pageState !== state;
      if (moved || changed) {
        idleSince = Date.now();
        unconfirmed = 0;
        if (moved) acted = true;
      }
      pageState = state;
      if (!moved) {
        const btn = readNextButton(reading);
        /* 有真实页码变化就快速推进；按钮无响应时最多补点一次，不反复空点。 */
        if (btn && unconfirmed < 2 && (btn !== lastButton || changed || Date.now() - lastClick >= 1000)) {
          try { btn.click(); acted = true; } catch { /* 按钮被重建 */ }
          lastButton = btn; lastClick = Date.now(); unconfirmed++;
        }
      }
      if (Date.now() - idleSince >= (acted ? 3000 : 8000)) return;
      await new Promise((r) => setTimeout(r, 350));
    }
  }
  if (DOC_FRAME.test(location.href)) {
    let reading = null;
    const begin = () => {
      if (!reading) reading = readDocFrame().catch(() => { /* 文档框架异常不影响主流程 */ }).finally(() => { reading = null; });
    };
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (message.type !== 'HW_WATCH_READ_DOC') return;
      begin();
      respond({ ok: true });
    });
    begin();
  }
})();
