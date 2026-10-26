/* 讨论任务点：站点卡片（ananas/insertbbs）点开后是一个跨域话题页
   （groupweb.chaoxing.com/course/topic/...），由这份脚本在话题页里回帖。
   页面结构（2026-10-22 实测）：可见 <textarea> 是回帖框，div.addReply 是「回复」按钮。
   回帖后站点自己走 opType=completeTopic 的消息链把任务点记完成。
   只在同一个窗口的刷课队列正在跑时动手；发完自动关掉这个标签页。 */
(function () {
  'use strict';
  const HW = (window.HW = window.HW || {});
  if (HW.Bbs) return;

  const KEY = 'hwBbsReplied';
  const isTopic = () => /groupweb\.chaoxing\.com\/course\/topic\//.test(location.href);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  function visible(el) {
    if (!el || !el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  async function queueRunning() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'HW_WATCH_QUEUE_GET' });
      return !!(r && r.ok && r.queue && !r.queue.paused);
    } catch { return false; }
  }
  const replied = () => {
    try { return sessionStorage.getItem(KEY) === location.href; } catch { return false; }
  };
  const markReplied = () => {
    try { sessionStorage.setItem(KEY, location.href); } catch { /* 存不了就只靠本次运行 */ }
  };

  async function run() {
    if (!isTopic() || replied()) return;
    if (!(await queueRunning())) return;
    let box = [...document.querySelectorAll('textarea')].find(visible);
    if (!box) {
      const open = [...document.querySelectorAll('div,a,button')]
        .find(el => visible(el) && /^回复$/.test((el.textContent || '').trim()));
      if (open) open.click();
    }
    for (let i = 0; i < 30; i++) {
      box = [...document.querySelectorAll('textarea')].find(visible);
      if (box) break;
      await wait(500);
    }
    if (!box || !(await queueRunning())) return;
    /* 感想从话题题面里取关键词拼一句切题的话：不抄题面原文，也不发无关内容 */
    const prompt = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 160);
    const reply = /openGauss|openEuler|DataKit|数据库|部署|录屏/i.test(prompt)
      ? '数据库部署与操作应先核对运行环境和依赖，再检查网络、用户权限与服务状态。遇到问题可结合日志逐项定位，操作后用连接测试和查询结果验证，保留关键步骤便于复盘。'
      : '学习这份材料时，可以先梳理关键概念，再结合实例逐步实践，并通过结果验证理解。遇到问题时记录现象和解决过程，便于后续复习与交流。';
    box.focus();
    box.value = reply.slice(0, 200);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(600 + Math.random() * 600);
    const btn = [...document.querySelectorAll('.addReply')].find(visible) ||
      [...document.querySelectorAll('div,a,button')].reverse()
        .find((el) => visible(el) && /^回复$/.test((el.textContent || '').trim()));
    if (!btn) return;
    await wait(400 + Math.random() * 400);
    if (!(await queueRunning())) return;
    // 页面可能已有另一条相同回复；只有发送后新增的正文才算本次回帖成功。
    const replyCount = () => (document.body?.innerText || '').split(reply).length - 1;
    const before = replyCount();
    try { btn.click(); } catch { return; }
    let confirmed = false;
    for (let i = 0; i < 20; i++) {
      await wait(500);
      if (!(await queueRunning())) return;
      if (replyCount() > before) { confirmed = true; break; }
    }
    if (!confirmed) return;
    markReplied();
    HW.Bbs.last = { at: Date.now() };
    /* 正常链路里话题页会把 opType=completeTopic postMessage 给 opener，
       但这个标签页是扩展开的、没有 opener——让后台把信号转回学习页补发。 */
    try { await chrome.runtime.sendMessage({ type: 'HW_BBS_REPLIED' }); } catch { /* 后台不在就算了 */ }
    await wait(2500);
    try { window.close(); } catch { /* 标签页关不掉就留着 */ }
  }

  HW.Bbs = { run, last: null };
  run().catch(() => { /* 结构不认识就什么都不做，由刷课日志如实记录 */ });
})();
