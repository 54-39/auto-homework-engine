/* 工具设置页（settings.html）：侧边栏收纳 记忆 / 诊断 / 检测更新。
   由面板「设置」按钮打开（后台 OPEN_SETTINGS 消息），逻辑走后台消息或脚本注入。 */
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

  /* 侧边栏：切换分区，并把当前分区同步到 URL hash（刷新、前进后退都停在原分区） */
  const navBtns = [...document.querySelectorAll('.side button')];
  const secs = { mem: $('#sec-mem'), diag: $('#sec-diag'), upd: $('#sec-upd') };
  const goto = (id, push) => {
    const key = secs[id] ? id : 'mem';
    navBtns.forEach((b) => b.setAttribute('aria-current', String(b.dataset.sec === key)));
    Object.entries(secs).forEach(([k, el]) => (el.hidden = k !== key));
    if (push) location.hash = key;
    else history.replaceState(null, '', '#' + key);
  };
  navBtns.forEach((b) => b.addEventListener('click', () => goto(b.dataset.sec, true)));
  window.addEventListener('hashchange', () => goto(location.hash.slice(1), false));
  goto(location.hash.slice(1), false);

  /* 记忆：先读条数 → 已确认过直接清除，否则显示确认框 → 清除并报告（clearAck 与面板旧逻辑一致） */
  const memMsg = $('#memMsg');
  const memCountEl = $('#memCount');
  const memConfirm = $('#memConfirm');
  const memClearBtn = $('#memClear');
  const memGoBtn = $('#memGo');
  const memCancelBtn = $('#memCancel');
  let memCount = 0;
  const showCount = () => {
    memCountEl.textContent = memCount > 0 ? `当前已记住 ${memCount} 条答题记忆` : '当前没有答题记忆';
  };
  const clearMemory = async (ack) => {
    memClearBtn.disabled = true;
    const res = await send('CACHE_CLEAR', {});
    memClearBtn.disabled = false;
    if (res?.ok) {
      memCount = 0;
      showCount();
      out(memMsg, `已清除 ${res.count} 条答题记忆，下次点「开始」所有题目会重新问 AI`, 'ok');
      if (ack) await send('SET_CONFIG', { clearAck: true });
    } else out(memMsg, '清除失败：' + (res?.error || '未知错误') + '，请刷新页面后重试', 'err');
  };
  memClearBtn.addEventListener('click', async () => {
    memConfirm.hidden = true;
    const cfg = (await send('GET_CONFIG'))?.config || {};
    if (cfg.clearAck || $('#memNever').checked) return clearMemory(true); // 已确认过：直接清除
    memClearBtn.disabled = true;
    const dry = await send('CACHE_CLEAR', { dryRun: true });
    memClearBtn.disabled = false;
    memCount = dry?.count ?? 0;
    showCount();
    $('#memConfirmBody').textContent =
      memCount > 0 ? `将清除当前记住的 ${memCount} 条 AI 答案，之后所有题目重新问 AI。` : '当前没有已记住的答案，无需清除。';
    memConfirm.hidden = false;
    memCancelBtn.focus();
  });
  memCancelBtn.addEventListener('click', () => {
    memConfirm.hidden = true;
    memClearBtn.focus();
  });
  memGoBtn.addEventListener('click', () => {
    memConfirm.hidden = true;
    clearMemory(false);
  });
  $('#memNever').addEventListener('change', async (e) => {
    if (!e.target.checked) await send('SET_CONFIG', { clearAck: false }); // 取消勾选=恢复确认框
  });
  (async () => {
    const cfg = (await send('GET_CONFIG'))?.config || {};
    $('#memNever').checked = !!cfg.clearAck;
    const dry = await send('CACHE_CLEAR', { dryRun: true });
    if (dry?.ok) {
      memCount = dry.count;
      showCount();
    } else memCountEl.textContent = '记忆条数读取失败';
  })();

  /* 诊断：把最近打开的网页（作业页）DOM 导出为 HTML 下载文件 */
  const diagMsg = $('#diagMsg');
  const diagBtn = $('#diagExport');
  diagBtn.addEventListener('click', async () => {
    diagBtn.disabled = true;
    out(diagMsg, '正在导出页面结构…');
    try {
      const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
      if (!tabs.length) return out(diagMsg, '没有找到已打开的网页，请先打开作业页面，再回到这里导出', 'err');
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
      out(diagMsg, `已导出 ${host} 的页面结构（发给开发者即可适配该站点）`, 'ok');
    } catch (e) {
      out(diagMsg, '导出失败：' + (e.message || e) + '，请刷新作业页面后重试', 'err');
    } finally {
      diagBtn.disabled = false;
    }
  });

  /* 检测更新：手动检查（force 绕过 1 小时缓存），有新版本给 GitHub 下载入口 */
  const updCurrent = $('#updCurrent');
  const updLatest = $('#updLatest');
  const updLink = $('#updLink');
  const updMsg = $('#updMsg');
  const updBtn = $('#updCheck');
  const renderUpdate = (r) => {
    if (!r?.ok) {
      updLatest.textContent = '未获取到';
      return out(updMsg, '检查失败：' + (r?.error || '未知错误') + '，请检查网络后重试', 'err');
    }
    updLatest.textContent = 'v' + r.latest;
    updLink.hidden = !r.hasUpdate;
    if (r.hasUpdate) {
      updLink.href = r.url;
      out(updMsg, `发现新版本 v${r.latest}（当前 v${r.current}）`, 'ok');
    } else out(updMsg, '已是最新版本', 'ok');
  };
  updBtn.addEventListener('click', async () => {
    updBtn.disabled = true;
    updBtn.textContent = '检查中…';
    updLatest.textContent = '检查中…';
    updLink.hidden = true;
    out(updMsg, '');
    try {
      renderUpdate(await send('CHECK_UPDATE', { force: true }));
    } finally {
      updBtn.disabled = false;
      updBtn.textContent = '立即检查';
    }
  });
  updCurrent.textContent = 'v' + chrome.runtime.getManifest().version;
})();
