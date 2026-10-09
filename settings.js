/* 工具设置页（settings.html）：侧边栏收纳 记忆 / 诊断 / 检测更新。
   由面板「设置」按钮打开（chrome.tabs.create），全部逻辑走后台消息或脚本注入。 */
(() => {
  const $ = (s) => document.querySelector(s);
  const send = (type, payload) =>
    chrome.runtime.sendMessage({ type, payload }).catch((e) => {
      const msg = String(e && e.message ? e.message : e);
      return { ok: false, error: msg };
    });
  const out = (el, text, cls) => {
    el.textContent = text;
    el.className = 'msg' + (cls ? ' ' + cls : '');
  };

  /* 侧边栏切换 */
  document.querySelectorAll('.side button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.side button').forEach((x) => x.classList.remove('cur'));
      b.classList.add('cur');
      document.querySelectorAll('.content section').forEach((s) => s.classList.add('hidden'));
      $('#sec-' + b.dataset.sec).classList.remove('hidden');
    });
  });

  /* 记忆：dryRun 取条数 → 未确认过显示确认框 → 清除并报告（clearAck 与面板原逻辑一致） */
  const memMsg = $('#memMsg');
  const memConfirm = $('#memConfirm');
  let memCount = 0;
  const clearMemory = async (ack) => {
    const res = await send('CACHE_CLEAR', {});
    if (res?.ok) {
      memCount = 0;
      out(memMsg, '已清除 ' + res.count + ' 条答题记忆，下次点「开始」所有题目会重新问 AI', 'ok');
      if (ack) await send('SET_CONFIG', { clearAck: true });
    } else out(memMsg, '清除失败：' + (res?.error || '未知错误'), 'err');
  };
  const showConfirm = () => {
    $('#memConfirmBody').textContent = memCount > 0 ? `当前共记住 ${memCount} 条 AI 答案。` : '当前没有已记住的答案（无需清除）。';
    memConfirm.classList.remove('hidden');
  };
  $('#memClear').addEventListener('click', async () => {
    memConfirm.classList.add('hidden');
    const cfg = (await send('GET_CONFIG'))?.config || {};
    if (cfg.clearAck || $('#memNever').checked) return clearMemory(true); // 已确认过：直接清除
    const dry = await send('CACHE_CLEAR', { dryRun: true });
    memCount = dry?.count ?? 0;
    showConfirm();
  });
  $('#memCancel').addEventListener('click', () => memConfirm.classList.add('hidden'));
  $('#memGo').addEventListener('click', () => {
    memConfirm.classList.add('hidden');
    clearMemory(false);
  });
  $('#memNever').addEventListener('change', async (e) => {
    if (!e.target.checked) await send('SET_CONFIG', { clearAck: false }); // 取消勾选=恢复确认框
  });
  (async () => {
    const cfg = (await send('GET_CONFIG'))?.config || {};
    $('#memNever').checked = !!cfg.clearAck;
  })();

  /* 诊断：把最近打开的网页（作业页）DOM 导出为 HTML 下载文件 */
  const diagMsg = $('#diagMsg');
  $('#diagExport').addEventListener('click', async () => {
    try {
      const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
      if (!tabs.length) return out(diagMsg, '没有找到已打开的网页（作业页），请先打开作业页面再试', 'err');
      const tab = tabs[tabs.length - 1];
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => '<!DOCTYPE html>\n' + document.documentElement.outerHTML,
      });
      const host = tab.url ? new URL(tab.url).hostname.replace(/[^a-z0-9.-]/gi, '_') : 'page';
      const blob = new Blob([res.result], { type: 'text/html' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `hw-debug-${host}-${Date.now()}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      out(diagMsg, '页面结构已导出为下载文件（发给开发者即可适配该站点）', 'ok');
    } catch (e) {
      out(diagMsg, '导出失败：' + (e.message || e), 'err');
    }
  });

  /* 检测更新：手动触发检查（force 绕过 1 小时缓存），有新版本给 GitHub 下载入口 */
  const updCurrent = $('#updCurrent');
  const updLatest = $('#updLatest');
  const updLink = $('#updLink');
  const updMsg = $('#updMsg');
  const renderUpdate = (r) => {
    if (!r?.ok) return out(updMsg, '检查失败：' + (r?.error || '未知错误'), 'err');
    updLatest.textContent = 'v' + r.latest;
    updLink.classList.toggle('hidden', !r.hasUpdate);
    if (r.hasUpdate) {
      updLink.href = r.url;
      out(updMsg, `发现新版本 v${r.latest}（当前 v${r.current}），点击链接前往 GitHub 下载`, 'ok');
    } else out(updMsg, '已是最新版本', 'ok');
  };
  $('#updCheck').addEventListener('click', async () => {
    updLatest.textContent = '检查中…';
    updLink.classList.add('hidden');
    out(updMsg, '');
    renderUpdate(await send('CHECK_UPDATE', { force: true }));
  });
  updCurrent.textContent = 'v' + chrome.runtime.getManifest().version;
})();
