/* 任务跟进：盯住 mobilelearn 任务列表页，把「进行中」任务逐个处理完。
   状态存 chrome.storage.local（跨 mobilelearn / groupweb 两个域都能读）。
   一轮结束后重新刷新列表发现新任务；托管到期自动停止，并列出未完成项。
   签到需要重绘老师的手势图案，始终留给人工。抢答题由设置「taskGrab」控制，默认不碰。 */
(function () {
  'use strict';
  const HW = (window.HW = window.HW || {});
  if (HW.TaskFollow) return;

  const KEY = 'hwTaskState';
  const R = {
    list: /\/page\/active\/stuActiveList/,
    quiz: /\/page\/quiz\/stu\/answerQuestion2/,
    vote: /\/page\/qvote\/stu\/answerQvote/,
    grab: /\/page\/answer\/stuAnswer/,
    sign: /\/page\/sign\/signIn/,
    topic: /groupweb\.chaoxing\.com\/course\/topic\//,
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

  const getState = async () => (await chrome.storage.local.get(KEY))[KEY] || null;
  const setState = async (s) => chrome.storage.local.set({ [KEY]: s });
  const params = () => {
    const p = new URLSearchParams(location.search);
    return {
      courseId: p.get('courseid') || p.get('courseId') || '',
      classId: p.get('clazzid') || p.get('classId') || '',
      cpi: p.get('cpi') || '',
      fid: p.get('fid') || '270',
      stuenc: p.get('stuenc') || p.get('enc') || '',
    };
  };

  function taskUrl(t, p) {
    const qs = `courseId=${p.courseId}&classId=${p.classId}&activeId=${t.id}&fid=${p.fid}&timetable=0`;
    const base = location.origin + '/page';
    if (t.type === '2') return base + '/sign/signIn?' + qs;
    if (t.type === '42') return base + '/quiz/stu/answerQuestion2?' + qs;
    if (t.type === '43') return base + '/qvote/stu/answerQvote?' + qs;
    if (t.type === '4') return base + '/answer/stuAnswer?' + qs;
    return null;
  }

  async function topicUrl(id) {
    try {
      const r = await fetch('/v2/apis/discuss/getTopicDiscussInfo?activeId=' + encodeURIComponent(id), { credentials: 'include' });
      const j = await r.json();
      return j?.result === 1 && j.data?.topicV3Url ? j.data.topicV3Url : null;
    } catch { return null; }
  }

  async function ask(q) {
    const r = await chrome.runtime.sendMessage({ type: 'HW_TASK_ASK', payload: { q } });
    if (!r || !r.ok) throw new Error((r?.error || 'AI 未返回答案') + (r?.raw ? '（原文：' + String(r.raw).replace(/\s+/g, ' ').slice(0, 200) + '）' : ''));
    return String(r.answer || '').trim();
  }

  /* ---------- 列表页 ---------- */
  const readTasks = () => [...document.querySelectorAll('.bottomList li')]
    .filter((li) => li.getAttribute('activestatus') === '1')
    .map((li) => ({
      id: li.getAttribute('activeid'),
      type: li.getAttribute('activetype'),
      title: norm(li.querySelector('.right-content p')?.textContent).slice(0, 60),
      left: norm(li.querySelector('.right-content span')?.textContent),
    }));

  async function onList() {
    const s = await getState();
    renderBar(s);
    if (!s) return;
    if (!s.active || running) {
      /* 未托管时也同步一次任务清单，面板才能看到「已结束的不再出现」 */
      for (let i = 0; i < 24 && !document.querySelectorAll('.bottomList li').length; i++) await wait(500);
      const fresh0 = readTasks();
      if (fresh0.length) { s.queue = fresh0.map((t) => ({ ...t })); await setState(s); }
      return;
    }
    running = true;

    /* 列表是异步拉取的：DOM 没就绪时读到 0 行会被误判成「没有任务」而直接收工，
       所以先等任务行出现（最多 12 秒），仍为空才按空处理。 */
    for (let i = 0; i < 24 && !document.querySelectorAll('.bottomList li').length; i++) await wait(500);

    const p = params();
    const fresh = readTasks();
    /* 用最新「进行中」列表覆盖队列：任务结束后不再出现在列表里 */
    if (fresh.length) s.queue = fresh.map((t) => ({ ...t }));
    else s.queue ||= [];
    s.params = p;
    s.listUrl = location.href;
    try { sessionStorage.setItem('hwTaskList', s.listUrl); } catch { /* 存不了就靠 state */ }
    if (!s.startedAt) s.startedAt = Date.now();

    const next = s.queue.find((t) => !s.permanent?.[t.id]);
    if (next) {
      let url = taskUrl(next, p);
      if (next.type === '5') url = await topicUrl(next.id);
      if (!url) {
        s.permanent ||= {};
        s.permanent[next.id] = { status: 'skip', reason: '找不到任务入口（可能已删除或需要人工）' };
        await setState(s);
        location.reload();
        return;
      }
      s.currentId = next.id;
      await setState(s);
      location.href = url;
      return;
    }

    /* 一轮走完：出清单，按托管设置决定刷新还是收工 */
    s.round = (s.round || 0) + 1;
    s.report = buildReport(s);
    s.currentId = '';
    if (s.endAt && Date.now() >= s.endAt) {
      s.active = false;
      await setState(s);
      renderBar(s);
      return;
    }
    const cfg = (await chrome.storage.local.get('config')).config || {};
    const gap = Math.max(1, Number(cfg.taskHostMin) || 2) * 60000;
    await setState(s);
    renderBar(s);
    setTimeout(() => location.reload(), gap);
  }

  function buildReport(s) {
    const done = [], miss = [];
    const TYPE = { 2: '签到', 4: '抢答', 5: '讨论', 42: '练习', 43: '投票', 14: '问卷' };
    for (const t of s.queue || []) {
      const r = s.permanent?.[t.id];
      const name = `[${TYPE[t.type] || t.type}] ${t.title}`;
      if (!r) { miss.push(name + ' —— 未处理（可能页面加载失败）'); continue; }
      if (r.status === 'done') done.push(name);
      else miss.push(name + ' —— ' + (r.reason || '未完成'));
    }
    return { at: new Date().toLocaleTimeString(), done: done.length, miss };
  }

  let running = false;

  /* 任务页处理完统一回列表 */
  async function finish(status, reason) {
    /* 重新读最新状态再写：否则会用任务开始时那份旧状态把「停止托管」覆盖回去 */
    const latest = (await getState()) || {};
    latest.permanent ||= {};
    latest.permanent[latest.currentId || ''] = { status, reason: reason || '' };
    /* 只做指定这一题：做完就停，不继续后面的 */
    if (latest.onlyId && latest.currentId === latest.onlyId) {
      latest.active = false;
      delete latest.onlyId;
    }
    await setState(latest);
    await wait(1600); // 太快会显得界面在闪
    /* 提交后页面常会自己再跳一次（如投票→详情），等它稳定再回列表，否则会被覆盖 */
    for (let i = 0; i < 15; i++) {
      if (document.readyState === 'complete') break;
      await wait(300);
    }
    const back = latest.listUrl || sessionStorage.getItem('hwTaskList') || '';
    if (!back) return;
    /* 页面可能自己跳回详情页，content 里跳会被顶掉，交给后台用 tabs.update 强跳 */
    const r = await chrome.runtime.sendMessage({ type: 'HW_TASK_BACK', payload: { url: back } }).catch(() => null);
    if (!r?.ok) location.replace(back);
  }

  /* ---------- 练习 / 抢答：结构化题目 ---------- */
  function readQuiz() {
    return [...document.querySelectorAll('.question-box .question-item')].map((item) => {
      const stem = norm(item.querySelector('.question-name')?.textContent);
      const opts = [...item.querySelectorAll('.option-list li')].map((li, i) => ({
        key: 'ABCDEFGH'[i],
        text: norm(li.textContent).replace(/^[A-H]\s*/, ''),
        clickEl: li,
      }));
      const kind = /\bmultiple-choice\b/.test(item.className) ? 'multi'
        : /\bsingle-choice\b|\bjudgement\b|\btrue-or-false\b/.test(item.className) ? 'judge' : 'choice';
      return { stem, options: opts, kind };
    });
  }

  function clickOption(opts, ans) {
    const letters = [...new Set(String(ans).toUpperCase().match(/[A-H]/g) || [])];
    const byText = opts.find((o) => norm(o.text) === norm(ans)) || opts.find((o) => norm(o.text).includes(norm(ans)));
    if (letters.length) {
      for (const k of letters) { const o = opts.find((x) => x.key === k); if (o) o.clickEl.click(); }
      return letters.length > 0;
    }
    if (byText) { byText.clickEl.click(); return true; }
    return false;
  }

  /* 这些任务页都是异步渲染的：DOM 没出来就读，会立刻判失败并跳回去，形成反复跳转 */
  async function waitFor(sel, ms = 12000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const el = document.querySelector(sel);
      if (el) return el;
      await wait(400);
    }
    return null;
  }

  async function fillQuizPage() {
    const qs = readQuiz();
    if (!qs.length) throw new Error('未识别到题目');
    for (const q of qs) {
      const type = q.kind === 'judge' ? 'judge' : q.options.length ? (q.kind === 'multi' ? 'multi' : 'choice') : 'subjective';
      const r = await ask({ type, stem: q.stem, options: q.options.map(({ key, text }) => ({ key, text })), blanks: 0 });
      if (type === 'multi' || type === 'choice' || type === 'judge') {
        if (!clickOption(q.options, r)) throw new Error('答案与选项不匹配：' + r.slice(0, 30));
      }
      await wait(300);
    }
  }

  const submitBtn = () => [...document.querySelectorAll('button,.btn,a,div')]
    .find((el) => visible(el) && /^(提交|交卷|完成)$/.test(norm(el.textContent)));

  /* 提交要确认成功：有些页面点了「提交」还要再点一次「确定」，有些点了没反应 */
  async function submitPage() {
    const cands = [...document.querySelectorAll('button,div,a')]
      .filter((el) => visible(el) && /^(提交|交卷|完成答题)$/.test(norm(el.textContent)))
      .sort((a, b) => norm(a.textContent).length - norm(b.textContent).length);
    const btn = cands.find((el) => /btn|submit|act/i.test(String(el.className))) || cands[0];
    if (!btn) throw new Error('找不到提交按钮');
    const startHref = location.href;
    btn.click();
    let confirmed = false, asked = false;
    for (let i = 0; i < 20; i++) {
      await wait(600);
      if (location.href !== startHref) { confirmed = true; break; } // 真提交后会跳回列表
      const txt = document.body.innerText || '';
      if (/提交成功|已提交|交卷成功|投票成功|完成答题/.test(txt)) { confirmed = true; break; }
      if (!asked) {
        const ok = [...document.querySelectorAll('button,div,a')].find((el) => visible(el) && /^(确定|确认|继续提交)$/.test(norm(el.textContent)));
        if (ok) { ok.click(); asked = true; }
      }
    }
    if (!confirmed) throw new Error('点了提交但页面没反应，未确认成功');
  }

  async function onQuiz(s) {
    try {
      if (!(await waitFor('.question-box .question-item'))) throw new Error('题目页未加载出来');
      if (!submitBtn()) return finish('skip', '这题已提交过（页面上没有提交按钮）');
      const qs0 = readQuiz();
      if (!qs0.length || qs0.some((q) => !q.stem)) throw new Error('题目还没加载完整，稍后重试');
      const bad = qs0.map((q) => HW.AIDetection?.incomplete?.(q.stem) || '').find(Boolean);
      if (bad) return finish('skip', '题干信息不全（' + bad + '），请补充材料或自己作答');
      await fillQuizPage();
      await submitPage();
      await finish('done');
    } catch (e) { await finish('fail', e.message || String(e)); }
  }

  /* ---------- 投票：正确/错误 ---------- */
  async function onVote(s) {
    try {
      if (!(await waitFor('.question-lists li.question-list a'))) throw new Error('投票页未加载出来');
      const stem = norm(document.querySelector('.vote-info .question-name, .vote-info p, .vote-info')?.textContent).slice(0, 2000);
      if (!stem) throw new Error('投票题目还没加载出来');
      const bad = HW.AIDetection?.incomplete?.(stem) || '';
      if (bad) return finish('skip', '题干信息不全（' + bad + '），请补充材料或自己作答');
      /* 选项是 li.question-list，选中态 = 该 li 带 active */
      const items = [...document.querySelectorAll('.question-lists li.question-list')].filter(visible);
      if (!items.length) throw new Error('未识别到投票选项');
      const labels = items.map((li) => norm(li.querySelector('a')?.textContent || li.textContent).replace(/^[A-H]\s*/, ''));
      const r = await ask({ type: 'judge', stem, options: labels.map((text, i) => ({ key: 'ABCDEFGH'[i], text })), blanks: 0 });
      const hit = /对|正确|是/.test(r) ? 0 : 1;
      const target = items[Math.min(hit, items.length - 1)];
      (target.querySelector('a') || target).click(); // 只有点 a 才会选中
      await wait(500);
      if (!target.classList.contains('active') && !target.querySelector('a.active')) throw new Error('投票选项没有选中');
      await submitPage();
      await finish('done');
    } catch (e) { await finish('fail', e.message || String(e)); }
  }

  /* ---------- 抢答：有题先答再抢，没题直接抢 ---------- */
  async function onGrab(s) {
    const cfg = (await chrome.storage.local.get('config')).config || {};
    if (cfg.taskGrab !== true) return finish('skip', '抢答题未开启（设置里可打开）');
    try {
      await waitFor('#quickAnswer', 12000);
      const text = document.body.innerText || '';
      if (/抢答已结束|很遗憾/.test(text)) throw new Error('抢答已结束');
      /* 先答后抢：题干在顶部 textarea，答案写在 #answerButton 的 textarea，再点「抢」 */
      const stemEl = document.querySelector('.list-info-operate textarea') || document.querySelector('.top-con textarea');
      const stem = (stemEl?.value || stemEl?.textContent || '').trim();
      const box = document.querySelector('#answerButton textarea');
      if (stem && box) {
        /* 取不到答案也要照样抢：有些老师只要求抢，不看答案 */
        try {
          const ans = await ask({ type: 'blank', stem, options: [], blanks: 0 });
          if (ans) {
            box.focus();
            box.value = ans.replace(/\s+/g, ' ').trim();
            box.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(400);
          }
        } catch { /* 答案失败不阻塞抢答 */ }
      }
      const btn = document.querySelector('#qiangdabutton.enable') ||
        [...document.querySelectorAll('.btn-quick')].find((el) => visible(el) && /^抢/.test(norm(el.textContent)) && !/已准备|上限/.test(norm(el.textContent)));
      if (!btn) throw new Error('抢答按钮不可用（可能未开启或人数已满）');
      btn.click();
      await wait(1500);
      const ok = /抢答成功|恭喜|已抢答/.test(document.body.innerText || '');
      await finish(ok ? 'done' : 'fail', ok ? '' : '已点「抢」但没看到成功提示，请在手机上确认');
    } catch (e) { await finish('fail', e.message || String(e)); }
  }

  /* ---------- 讨论：复用话题页回复 ---------- */
  async function onTopic(s) {
    try {
      /* 话题页是异步渲染：回复框先出现时题干可能还是空的，必须等题干有文字 */
      let title = '';
      for (let i = 0; i < 30; i++) {
        title = norm(document.querySelector('.topicDetail_detail .topicDetail_title')?.textContent || '').slice(0, 2000);
        if (title && document.querySelector('.topicDetail_editContainer textarea')) break;
        await wait(500);
      }
      if (!title) throw new Error('话题页未加载出来（题干为空）');
      const bad = HW.AIDetection?.incomplete?.(title) || '';
      if (bad) return finish('skip', '题干信息不全（' + bad + '），请补充材料或自己作答');
      const box = document.querySelector('.topicDetail_editContainer textarea');
      if (!title || !box) throw new Error('话题页结构不认识');
      /* 本机记录优先：悬停才出现的「编辑/删除」经常读不到，会导致反复回复同一话题 */
      const TOPICS = 'hwTaskTopics';
      const m = location.pathname.match(/\/([0-9a-f]{16,})_topicDiscuss/);
      const topicKey = m ? m[1] : location.pathname;
      const topics = (await chrome.storage.local.get(TOPICS))[TOPICS] || {};
      const own = topics[topicKey] || [...document.querySelectorAll('.topicDetail_replyList .topicDetail_replyItem')]
        .some((it) => /编辑|删除/.test(it.querySelector('.operate_con')?.textContent || ''));
      if (own) return finish('skip', '这个话题已经回复过');
      const ans = await ask({ type: 'discuss', stem: title, options: [], blanks: 0 });
      if (!ans) throw new Error('AI 未返回内容');
      box.focus();
      box.value = ans.slice(0, 200);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(600);
      const btn = [...document.querySelectorAll('.addReply')].find(visible);
      if (!btn) throw new Error('找不到回复按钮');
      btn.click();
      await wait(1500);
      const ok = (document.body.innerText || '').includes(ans.slice(0, 20));
      if (ok) {
        topics[topicKey] = Date.now();
        await chrome.storage.local.set({ [TOPICS]: topics });
      }
      await finish(ok ? 'done' : 'fail', ok ? '' : '回复后未在页面看到内容，请人工确认');
    } catch (e) { await finish('fail', e.message || String(e)); }
  }

  /* 界面显示已交给作业助手面板（蓝白），这里不再插入黑色浮层 */
  function renderBar() {}

  async function toggle(s) {
    if (s?.active) {
      s.active = false;
      await setState(s);
      renderBar(s);
      return;
    }
    const cfg = (await chrome.storage.local.get('config')).config || {};
    const end = Math.max(0, Number(cfg.taskHostEnd) || 0);
    const next = {
      active: true, onList: false, startedAt: Date.now(),
      endAt: end > 0 ? Date.now() + end * 60000 : 0,
      listUrl: location.href, queue: [], permanent: {}, round: 0, report: null,
    };
    await setState(next);
    location.reload();
  }

  /* ---------- 路由 ---------- */
  (async function main() {
    if (R.list.test(location.pathname)) return onList();
    const s = await getState();
    if (!s || !s.active) return;
    if (R.sign.test(location.pathname)) return finish('skip', '手势签到需要重绘老师的手势，留给人工');
    if (R.quiz.test(location.pathname)) return onQuiz(s);
    if (R.vote.test(location.pathname)) return onVote(s);
    if (R.grab.test(location.pathname)) return onGrab(s);
    /* 投票提交成功后平台会跳到详情页（studentQvote），这就算已完成，别再来回重试 */
    if (/\/page\/qvote\/stu\/studentQvote/.test(location.pathname)) return finish('done');
    if (R.topic.test(location.href)) return onTopic(s);
  })().catch((e) => {
    /* 出错不能静默：写进存储，面板会显示最后一条错误 */
    try { chrome.storage.local.set({ hwTaskLastError: String(e?.message || e) + ' @ ' + location.pathname }); } catch { /* 忽略 */ }
    console.error('[task-follow]', e);
  });

  HW.TaskFollow = { getState, setState, toggle };
})();
