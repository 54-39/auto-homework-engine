/* 学情调查／问卷：站点的「投票」任务点打开后是一个跨域问卷页
   （mobilelearn.chaoxing.com/page/questionnaire/answerQuestionChapter）。
   刷课脚本所在的顶层文档读不到那一帧，所以由这份脚本在问卷页自己的上下文里填写并提交。

   答题取向由用户定：问卷是主观题，按「爱国、阳光、开朗」的一贯立场作答——
   正向词加分、消极词减分，同分取靠前的选项（超星的选项顺序是正向 → 负向）。
   不认识的题型（自由填答）一律不代写，留给人；也不伪造答卷内容。

   只点站点自己的选项和「提交」：已实测 .optionRadio 整块点下去有时不认，
   必须点里面的原生 input，点完核对 checked。 */
(function () {
  'use strict';
  const HW = (window.HW = window.HW || {});
  if (HW.Survey) return;

  const isSurvey = () => /\/page\/questionnaire\/answerQuestionChapter/.test(location.href) &&
    !/[?&]readOnly=1/.test(location.href);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (el) => (el?.textContent || el?.value || '').replace(/\s+/g, ' ').trim();
  function visible(el) {
    if (!el || !el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  /* 用户 2026-10-21 定的取向：爱国、阳光、开朗。问卷没有标准答案，这里只做词面倾向判断：
     正向词（愿意、支持、经常、主动…）加分，消极/回避词（从不、不愿意、没必要、怀疑…）减分，
     同分取靠前选项——超星的选项一般是「正向 → 负向」排列，第一个通常就是最积极的那个。 */
  const POSITIVE = /经常|愿意|支持|赞同|拥护|积极|主动|充满|自信|自豪|骄傲|参与|宣传|维护|辦护|辩护|纠正|相信|认真|乐观|开朗|阳光|关心|重视|认同|坚决|努力|有比较大|很有|一定|正确|建设|奋斗|奉献|是/;
  const NEGATIVE = /从不|不愿意|不支持|不会|不是|没有必要|没必要|没有影响|怀疑|当作没有听到|无所谓|不关心|反感|反对|否定|放弃|漠不关心|随便|应付|拒绝|消极|错误|不认同|不赞同/;
  /* 消极词权重更高：「不会」里也含「会」，「不是」里也含「是」，
     只有让否定压过肯定，含否定字的选项才不会被算成正向。 */
  function score(option) {
    const label = (option.getAttribute('aria-label') || '') + ' ' + text(option);
    return (POSITIVE.test(label) ? 2 : 0) - (NEGATIVE.test(label) ? 3 : 0);
  }
  function best(options) {
    let bestOption = options[0];
    let bestScore = score(options[0]);
    for (const option of options.slice(1)) {
      const value = score(option);
      if (value > bestScore) { bestScore = value; bestOption = option; }
    }
    return bestOption;
  }

  let courseKey;
  async function queueRunning() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'HW_WATCH_QUEUE_GET' });
      const q = r?.ok && r.queue;
      if (!q || q.paused) return false;
      const key = q.courses?.[q.index]?.key;
      if (courseKey && courseKey !== key) return false;
      courseKey = key;
      return true;
    } catch { return false; }
  }

  const expired = () => /手动结束|已结束|已截止/.test(text(document.querySelector('.tip')));
  const accepted = () => [...document.querySelectorAll('.tip,.maskDiv,.submit-con')]
    .some(el => visible(el) && /提交成功|已提交|作答内容已自动提交/.test(text(el)));

  /* 点原生 input 才稳：站点把选项包在 .optionRadio 里，整块连点时常只认一次。
     点完核对 checked；不认再退回点外层区块。 */
  function pick(option) {
    const input = option.querySelector('input[type="radio"],input[type="checkbox"]');
    if (!input || input.disabled) return null;
    try { input.click(); } catch { /* 退到外层 */ }
    if (!input.checked) { try { option.click(); } catch { return null; } }
    return input.checked ? (input.value || text(option)).slice(0, 20) : null;
  }

  function answerOne(item) {
    const stem = text(item.querySelector('.topic-txt')).slice(0, 40);
    if (item.querySelector('input[type="radio"]:checked,input[type="checkbox"]:checked')) return null;
    /* 自由填答不代写：问卷里出现填空/简答，说明老师想看真实想法，留给人工。 */
    if (item.querySelector('textarea:not(#text_title),input[type="text"]')) return { blocked: stem };
    const options = [...item.querySelectorAll('.optionRadio,.optionCheckbox')].filter(visible);
    if (!options.length) return { blocked: stem };
    const value = pick(best(options));
    return value ? { stem, value } : { blocked: stem };
  }

  async function findSubmit() {
    for (let i = 0; i < 40; i++) {
      const btn = [...document.querySelectorAll('#submitSuccess,a.btn-submit,button,a,input[type="button"],input[type="submit"]')]
        .find((el) => visible(el) && /^提交(问卷|答卷)?$/.test(text(el)));
      if (btn) return btn;
      await wait(250);
    }
    return null;
  }

  /* 提交后可能弹两层：先把「你有 N 道题未作答，确定提交？」的「提交」点掉，
     再处理「提交成功」之类的「确定/知道了」。都在站点自己的浮层里，按文案找按钮。 */
  async function confirmPopups() {
    let confirmed = 0;
    for (let i = 0; i < 20; i++) {
      if (!(await queueRunning())) return;
      const btn = [...document.querySelectorAll('.maskDiv .popBottom a,.maskDiv .popBottom button,[role="dialog"] button')]
        .find((el) => visible(el) && /^(提交|确定|确认|知道了|好的)$/.test(text(el)) && el.getBoundingClientRect().width < 200);
      if (!btn) { await wait(300); continue; }
      try { btn.click(); } catch { /* 浮层刚被换掉 */ }
      confirmed++;
      await wait(700);
      if (confirmed >= 2) break;
    }
    return confirmed;
  }

  async function run() {
    if (!isSurvey() || !(await queueRunning())) return;
    if (expired()) { HW.Survey.last = { state: 'expired' }; return; }
    if (accepted()) { HW.Survey.last = { state: 'submitted' }; return; }
    HW.Survey.last = { state: 'running' };
    let items = [];
    for (let i = 0; i < 60; i++) {
      items = [...document.querySelectorAll('.question-item')];
      if (items.length) break;
      if (!(await queueRunning())) { HW.Survey.last = { state: 'idle' }; return; }
      await wait(500);
    }
    if (!items.length) { HW.Survey.last = { state: 'failed', reason: '问卷题目未加载' }; return; }
    const answered = [];
    const blocked = [];
    for (const item of items) {
      if (!(await queueRunning())) { HW.Survey.last = { state: 'idle' }; return; }
      if (expired()) { HW.Survey.last = { state: 'expired' }; return; }
      const r = answerOne(item);
      if (!r) continue;
      if (r.blocked) blocked.push(r.blocked);
      else answered.push(`${r.stem}→${r.value}`);
      await wait(180 + Math.random() * 220);
    }
    if (blocked.length) { HW.Survey.last = { state: 'blocked', reason: '问卷含无法自动填写的题型' }; return; }
    // 已有保存答案也要正常提交，不能因为本次没有新勾选就直接退出。
    const submit = await findSubmit();
    if (!submit) { HW.Survey.last = { state: 'failed', reason: '未找到问卷提交按钮' }; return; }
    await wait(600 + Math.random() * 600);
    if (!(await queueRunning())) { HW.Survey.last = { state: 'idle' }; return; }
    if (expired()) { HW.Survey.last = { state: 'expired' }; return; }
    HW.Survey.last = { state: 'submitting' };
    try { submit.click(); } catch { HW.Survey.last = { state: 'failed', reason: '问卷提交按钮失效' }; return; }
    await confirmPopups();
    HW.Survey.last = { state: accepted() ? 'submitted' : 'pending', at: Date.now(), answered: answered.length };
  }

  let running = null;
  function start() {
    if (!running) running = run().catch(() => { HW.Survey.last = { state: 'failed', reason: '问卷页面处理失败' }; })
      .finally(() => { running = null; });
    return running;
  }
  HW.Survey = { run: start, last: { state: 'idle' } };
  if (isSurvey()) {
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (message.type !== 'HW_WATCH_SURVEY') return;
      if (message.payload?.url && message.payload.url !== location.href) return;
      if (message.payload?.start) start();
      respond({ ok: true, ...HW.Survey.last });
    });
    start();
  }
})();
