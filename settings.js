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
  let onSection = () => {};
  const goto = (id, push) => {
    const key = secs[id] ? id : 'mem';
    navBtns.forEach((b) => b.setAttribute('aria-current', String(b.dataset.sec === key)));
    Object.entries(secs).forEach(([k, el]) => (el.hidden = k !== key));
    if (push) location.hash = key;
    else history.replaceState(null, '', '#' + key);
    onSection(key);
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
      // 取最近访问过的那个网页（＝打开设置页之前停留的作业页）：tabs.query 按标签栏顺序返回，最后一个未必是作业页
      const tab = tabs.reduce((a, b) => ((b.lastAccessed || 0) >= (a.lastAccessed || 0) ? b : a));
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

  /* 检测更新：打开「检测更新」分区自动检查一次（走 1 小时缓存），「立即检查」绕过缓存；
     发现新版出现「更新」按钮——用户点了才执行（后台经原生宿主拉起本机脚本同步 GitHub），
     更新永不强制——不点不装、不阻断使用 */
  const updCurrent = $('#updCurrent');
  const updLatest = $('#updLatest');
  const updLink = $('#updLink');
  const updMsg = $('#updMsg');
  const updBtn = $('#updCheck');
  const updRun = $('#updRun');
  const updateHost = `com.homeworkhelper.autoupdate.${chrome.runtime.id}`;
  const nativeUpdateRequest = (message, timeoutMs = 10000) => new Promise((resolve) => {
    let port;
    try { port = chrome.runtime.connectNative(updateHost); }
    catch (e) { return resolve({ ok: false, error: String(e.message || e) }); }
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port.disconnect(); } catch { /* already disconnected */ }
      resolve(value);
    };
    const timer = setTimeout(() => done({ ok: false, error: '宿主请求超时' }), timeoutMs);
    port.onMessage.addListener(done);
    port.onDisconnect.addListener(() => done({ ok: false, error: chrome.runtime.lastError?.message || '宿主提前退出' }));
    port.postMessage({ ...message, extensionId: chrome.runtime.id });
  });
  const transactionKey = `hw-update-transaction:${chrome.runtime.id}`;
  const phaseText = {
    checking: '正在锁定本轮更新提交…',
    downloading: '正在下载并校验固定提交…',
    replacing: '文件已校验，正在替换；旧版备份仍保留…',
    awaiting_reload: '正在请求浏览器重载…',
    awaiting_health: '新后台已启动，正在验证设置页和关键资源…',
    retrying: '本轮失败，正在从同一提交完整重拉一次…',
  };
  let transactionTimer = 0;
  const pollUpdate = async (transactionId, startedAt = Date.now()) => {
    if (transactionTimer) clearTimeout(transactionTimer);
    if (Date.now() - startedAt > 12 * 60 * 1000) {
      out(updMsg, '等待更新状态超时。请重新打开设置页检查更新状态。', 'err');
      updRun.disabled = false;
      updRun.textContent = '更新';
      return;
    }
    const response = await nativeUpdateRequest({ type: 'update_status', transactionId });
    const state = response?.state;
    if (!response?.ok || state?.transactionId !== transactionId) {
      out(updMsg, `更新进程正在启动或浏览器重载中…${response?.error ? `（${response.error}）` : ''}`, 'ok');
      transactionTimer = setTimeout(() => pollUpdate(transactionId, startedAt), 1200);
      return;
    }
    if (phaseText[state.phase]) {
      out(updMsg, phaseText[state.phase], 'ok');
      transactionTimer = setTimeout(() => pollUpdate(transactionId, startedAt), 1200);
      return;
    }
    localStorage.removeItem(transactionKey);
    updRun.disabled = false;
    updRun.textContent = '更新';
    if (state.phase === 'complete') {
      updRun.hidden = true;
      out(updMsg, state.updated
        ? `已更新并通过运行验证到 v${state.latest}；作业页面请刷新(F5)后使用新版`
        : `已是最新版本 v${state.latest}`, 'ok');
    } else if (state.phase === 'rolled_back') {
      out(updMsg, `新版连续两次未通过运行验证，已恢复 v${state.latest}。若插件未自动恢复，请到扩展管理页手动重载一次。${state.error ? ` 原因：${state.error}` : ''}`, 'err');
    } else if (state.phase === 'recovery_required') {
      out(updMsg, `恢复旧版时遇到错误：${state.error || '未知错误'}。请到扩展管理页手动重载一次。`, 'err');
    } else {
      out(updMsg, `更新失败：${state.error || '未知错误'}`, 'err');
    }
  };
  const renderUpdate = (r) => {
    if (!r?.ok) {
      updLatest.textContent = '未获取到';
      updRun.hidden = true;
      return out(updMsg, '检查失败：' + (r?.error || '未知错误') + '，请检查网络后重试', 'err');
    }
    updLatest.textContent = 'v' + r.latest;
    updLink.hidden = !r.hasUpdate;
    updRun.hidden = !r.hasUpdate; // 有新版才出现「更新」，点了才真正执行
    if (r.hasUpdate) {
      updLink.href = r.url;
      out(updMsg, `${r.major ? '发现功能更新' : '发现修复更新'} v${r.latest}（当前 v${r.current}）：点「更新」自动下载替换，或继续用当前版本`, 'ok');
    } else out(updMsg, '已是最新版本', 'ok');
  };
  const check = async (force) => {
    updLatest.textContent = '检查中…';
    updLink.hidden = true;
    updRun.hidden = true;
    if (force) {
      updBtn.disabled = true;
      updBtn.textContent = '检查中…';
      out(updMsg, '');
    }
    try {
      renderUpdate(await send('CHECK_UPDATE', { force }));
    } finally {
      if (force) {
        updBtn.disabled = false;
        updBtn.textContent = '立即检查';
      }
    }
  };
  const runUpdate = async () => {
    updRun.disabled = true;
    updRun.textContent = '更新中…';
    out(updMsg, '正在启动独立更新进程…', 'ok');
    try {
      const r = await send('HW_RUN_UPDATE');
      if (r?.ok && r.started && r.transactionId) {
        localStorage.setItem(transactionKey, r.transactionId);
        await pollUpdate(r.transactionId);
      } else {
        updRun.disabled = false;
        updRun.textContent = '更新';
        out(updMsg, '更新失败：' + (r?.error || '未知错误'), 'err');
      }
    } catch (error) {
      updRun.disabled = false;
      updRun.textContent = '更新';
      out(updMsg, '更新失败：' + String(error?.message || error), 'err');
    }
  };
  updBtn.addEventListener('click', () => check(true));
  updRun.addEventListener('click', () => runUpdate());
  /* 首次安装后由安装器打开自检页，自动 ping 宿主；日常更新不显示诊断入口。 */
  const updDiagMsg = $('#updDiagMsg');
  const verifyUpdateHost = async () => {
    updDiagMsg.hidden = false;
    out(updDiagMsg, '正在验证本机更新程序…');
    try {
      const r = await send('DIAG_UPDATE_HOST');
      if (r?.ok) {
        const matches = r.extensionId === chrome.runtime.id && r.manifestVersion === chrome.runtime.getManifest().version;
        out(updDiagMsg, `${matches ? '浏览器 ping 自检通过' : '宿主响应与当前扩展不匹配'}：node ${r.node}，扩展 ID ${r.extensionId}，插件目录 ${r.root}，目录内版本 v${r.manifestVersion}`, matches ? 'ok' : 'err');
      } else if (r?.stage === 'connect') {
        out(updDiagMsg, r.error || '连接不到本机更新程序，请在插件目录双击 install-updater.cmd 完成首次安装。', 'err');
      } else {
        out(updDiagMsg, '诊断失败：' + (r?.error || '未知错误'), 'err');
      }
    } catch (error) {
      out(updDiagMsg, '连接检查失败：' + String(error?.message || error), 'err');
    }
  };
  if (new URLSearchParams(location.search).get('setupCheck') === '1') verifyUpdateHost();
  let autoChecked = false;
  onSection = (key) => {
    if (key === 'upd' && !autoChecked) {
      autoChecked = true;
      check(false);
    }
  };
  if (!secs.upd.hidden) onSection('upd'); // 直接以 #upd 打开时也要自动检查
  updCurrent.textContent = 'v' + chrome.runtime.getManifest().version;
  const healthTransaction = new URLSearchParams(location.search).get('updateHealth');
  if (healthTransaction) {
    out(updMsg, '设置页已加载，正在等待后台确认本轮版本…', 'ok');
    const acknowledge = async () => {
      const result = await send('UPDATE_PAGE_READY', { transactionId: healthTransaction });
      if (!result?.accepted) setTimeout(acknowledge, 1000);
    };
    acknowledge();
  }
  const activeTransaction = localStorage.getItem(transactionKey);
  if (activeTransaction && !healthTransaction) {
    updRun.disabled = true;
    updRun.textContent = '更新中…';
    pollUpdate(activeTransaction);
  }
})();
