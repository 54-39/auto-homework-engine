import { isUpdaterHostReady } from './tools/updater-setup-core.mjs';
import { exportIssueHistory, ISSUE_PREFIX } from './background/issue-history.js';
import './options/settings-controls.js';
import './options/options.js';

/* 工具设置页（settings.html）：侧边栏收纳 应用设置 / 记忆 / 刷课 / 诊断 / 检测更新。
   由面板「设置」按钮打开（后台 OPEN_SETTINGS 消息），逻辑走后台消息或脚本注入。 */
(() => {
  const $ = (s) => document.querySelector(s);
  // 更新收尾时扩展会整体重载，本页随之变成「僵尸页」：旧上下文里进度条再也收不掉 → 检测到上下文失效就刷新本页。
  const contextAlive = () => !!(chrome.runtime && chrome.runtime.id);
  let pageReviving = false;
  const revivePage = () => {
    if (pageReviving) return;
    const last = Number(sessionStorage.getItem('hw-revive-at') || 0); // 扩展被停用/卸载时别无限刷新
    if (Date.now() - last < 10000) return;
    pageReviving = true;
    sessionStorage.setItem('hw-revive-at', String(Date.now()));
    location.reload();
  };
  const send = (type, payload) => {
    if (!contextAlive()) {
      revivePage();
      return Promise.resolve({ ok: false, error: '扩展刚刚更新，设置页正在重载' });
    }
    try {
      return chrome.runtime.sendMessage({ type, payload }).catch((e) => {
        const msg = String(e && e.message ? e.message : e);
        if (!contextAlive()) revivePage();
        return { ok: false, error: msg };
      });
    } catch (e) {
      if (!contextAlive()) revivePage();
      return Promise.resolve({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  };
  const out = (el, text, cls) => {
    el.textContent = text;
    el.className = 'msg' + (cls ? ' ' + cls : '');
  };

  /* 侧边栏：切换分区，并把当前分区同步到 URL hash（刷新、前进后退都停在原分区） */
  const navBtns = [...document.querySelectorAll('.side button')];
  const secs = { app: $('#sec-app'), mem: $('#sec-mem'), watch: $('#sec-watch'), diag: $('#sec-diag'), upd: $('#sec-upd') };
  let onSection = () => {};
  const goto = (id, push) => {
    const key = secs[id] ? id : 'app';
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

  /* 刷课：每门课从第一节起连续处理几节。
     以前这个 4 节写死在面板上（勾选框），用户 2026-10-23 要求挪到设置里自选。 */
  const watchMsg = $('#watchMsg');
  const watchSel = $('#watchSections');
  const loadWatchSections = async () => {
    const cfg = (await send('GET_CONFIG'))?.config || {};
    watchSel.value = String(Math.min(10, Math.max(0, Number(cfg.watchSections) || 0)));
  };
  watchSel.addEventListener('change', async () => {
    const n = Math.min(10, Math.max(0, Number(watchSel.value) || 0));
    const res = await send('SET_CONFIG', { watchSections: n });
    if (res?.ok) out(watchMsg, n ? `已保存：每门课从第一节起连续完成 ${n} 节（只处理进度低于 35% 的课程）` : '已保存：整门课程从头刷到最后一节', 'ok');
    else out(watchMsg, '保存失败：' + (res?.error || '未知错误') + '，请刷新页面后重试', 'err');
  });
  loadWatchSections();

  /* 诊断：把最近打开的网页（作业页）DOM 导出为 HTML 下载文件 */
  const diagMsg = $('#diagMsg');
  let issues = [];
  let issueOffset = 0;
  const issuePageSize = 50;
  const issueMsg = $('#issueMsg');
  async function loadIssues() {
    const result = await send('HW_ISSUE_LIST', { offset: issueOffset, limit: issuePageSize });
    if (!result?.ok) return out(issueMsg, '读取失败：' + (result?.error || '请刷新重试'), 'err');
    issues = result.issues;
    $('#issueCount').textContent = result.total ? `共 ${result.total} 条异常记录 · 当前显示 ${result.offset + 1}–${result.offset + issues.length} 条` : '暂时没有异常记录，正常运行不会产生记录';
    $('#issueExport').disabled = !result.total;
    $('#issueClear').disabled = !result.total;
    $('#issuePages').hidden = result.total <= issuePageSize;
    $('#issuePrev').disabled = issueOffset === 0;
    $('#issueNext').disabled = issueOffset + issues.length >= result.total;
    $('#issuePageLabel').textContent = `${Math.floor(issueOffset / issuePageSize) + 1} / ${Math.max(1, Math.ceil(result.total / issuePageSize))}`;
    const list = $('#issueList');
    list.replaceChildren();
    for (const issue of issues) {
      const li = document.createElement('li');
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = issue.stage + ' · ' + issue.message;
      const meta = document.createElement('small');
      meta.textContent = new Date(issue.firstAt || issue.at).toLocaleString() + ' · v' + issue.version + (issue.count > 1 ? ` · 旧版合并记录 ${issue.count} 次` : '');
      const body = document.createElement('pre');
      body.textContent = [['课程', issue.course], ['章节', issue.chapter], ['任务', issue.task], ['处理结果', issue.action], ['错误堆栈', issue.stack], ['详细上下文', issue.details], ['页面', issue.url], ['题目', issue.question], ['答案 / 回执', issue.answer]]
        .filter(([, value]) => value).map(([label, value]) => `${label}：${value}`).join('\n\n') || '没有附加内容';
      details.append(summary, meta, body); li.append(details); list.append(li);
    }
  }
  $('#issueRefresh').addEventListener('click', () => { issueOffset = 0; loadIssues(); });
  $('#issuePrev').addEventListener('click', () => { issueOffset = Math.max(0, issueOffset - issuePageSize); loadIssues(); });
  $('#issueNext').addEventListener('click', () => { issueOffset += issuePageSize; loadIssues(); });
  $('#issueExport').addEventListener('click', async () => {
    $('#issueExport').disabled = true;
    out(issueMsg, '正在导出全部异常记录…');
    try {
      const { blob, count } = await exportIssueHistory(chrome.runtime.getManifest().version);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `作业助手-异常记录-${new Date().toISOString().slice(0, 10)}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      out(issueMsg, `已导出全部 ${count} 条异常记录`, 'ok');
    } catch (e) { out(issueMsg, '导出失败：' + (e.message || e), 'err'); }
    finally { $('#issueExport').disabled = false; }
  });
  $('#issueClear').addEventListener('click', async () => {
    const result = await send('HW_ISSUE_CLEAR');
    if (!result?.ok) return out(issueMsg, '清空失败：' + (result?.error || '请重试'), 'err');
    issueOffset = 0;
    await loadIssues(); out(issueMsg, '异常记录已清空', 'ok');
  });
  let issueRefreshTimer;
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some(key => key.startsWith(ISSUE_PREFIX)) && !secs.diag.hidden && issueOffset === 0) {
      clearTimeout(issueRefreshTimer); issueRefreshTimer = setTimeout(loadIssues, 200);
    }
  });
  loadIssues();
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
        // 章节题在 #iframe 里，只导顶层文档会丢掉真正的题目 DOM；同源 iframe 就地展开
        func: () => {
          const copy = document.documentElement.cloneNode(true);
          // 动态字体规则可能只在CSSOM里，outerHTML不会保存insertRule的内容。
          const fontInfo = (doc, target) => {
            const rules = [];
            const unreadable = [];
            const read = list => {
              for (const rule of list) {
                if (rule.type === CSSRule.FONT_FACE_RULE || /font-cxsecret/.test(rule.selectorText || '')) rules.push(rule.cssText);
                else if (rule.cssRules) read(rule.cssRules);
              }
            };
            for (const sheet of doc.styleSheets) {
              try { read(sheet.cssRules); } catch { if (sheet.href) unreadable.push(sheet.href); }
            }
            const data = doc.createElement('script');
            data.type = 'application/json';
            data.setAttribute('data-hw-font-diagnostic', '');
            data.textContent = JSON.stringify({ baseURI: doc.baseURI, rules, unreadable,
              fonts: [...doc.fonts].map(font => ({ family: font.family, status: font.status })) }).replace(/</g, '\\u003c');
            target.appendChild(data);
          };
          const fill = (live, clone) => {
            const lc = [...live.children];
            [...clone.children].forEach((c, i) => {
              const l = lc[i];
              if (!l) return;
              if (l.tagName === 'IFRAME') {
                let doc = null;
                try { doc = l.contentDocument; } catch { /* 跨域读不到，保留 <iframe> */ }
                if (!doc?.body) return;
                const box = document.createElement('div');
                box.setAttribute('data-iframe', l.src || 'about:blank');
                [...doc.body.childNodes].forEach((n) => box.appendChild(n.cloneNode(true)));
                c.replaceWith(box);
                fill(doc.body, box);
                // 内嵌测验的字体定义在head，正文展开后也要保留诊断所需的头部。
                const head = document.createElement('template');
                head.setAttribute('data-hw-frame-head', '');
                if (doc.head) head.content.appendChild(doc.head.cloneNode(true));
                fontInfo(doc, head.content);
                box.prepend(head);
                return;
              }
              fill(l, c);
            });
          };
          fill(document.documentElement, copy);
          fontInfo(document, copy.querySelector('head') || copy);
          return '<!DOCTYPE html>\n' + copy.outerHTML;
        },
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
  const updSetup = $('#updSetup');
  const updSetupMsg = $('#updSetupMsg');
  const updRun = $('#updRun');
  const isUpdaterHostMissing = (error) => /更新宿主未安装|原生宿主未安装|specified native messaging host|native messaging host.*(?:not found|does not exist|forbidden)/i.test(error);
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
  let setupPollTimer = 0;
  let setupPollBusy = false;
  let setupWatchActive = false;
  const updGuide = $('#updGuide');
  const updGuidePath = $('#updGuidePath');
  const updGuideClose = $('#updGuideClose');
  /* 教程面板要显示插件目录；宿主已连接时由它上报 */
  let setupHostRoot = '';
  const showSetupStatus = (response, installed = false) => {
    const currentId = chrome.runtime.id;
    const currentVersion = chrome.runtime.getManifest().version;
    const sameId = Boolean(response?.ok && response.extensionId === currentId);
    const ready = isUpdaterHostReady(response, currentId, currentVersion);
    if (response?.root) setupHostRoot = String(response.root);
    updSetup.hidden = ready;
    updSetup.disabled = sameId && !ready;
    updSetup.textContent = sameId && !ready ? '刷新扩展后重查' : '运行';
    if (ready) {
      if (installed) {
        updSetupMsg.hidden = false;
        out(updSetupMsg, '更新组件已安装并连接到当前插件。', 'ok');
      } else updSetupMsg.hidden = true;
      updGuide.hidden = true;
      setupWatchActive = false;
      if (setupPollTimer) clearTimeout(setupPollTimer);
      setupPollTimer = 0;
      return true;
    }
    updSetupMsg.hidden = false;
    const message = sameId
      ? `宿主已连接，但报告版本 ${response.manifestVersion || '未知'}，当前页面版本是 ${currentVersion}。请先到 Edge 扩展管理页刷新“作业助手”，再回到这里检查。`
      : response?.ok
        ? '宿主连接到了其他插件目录。请点“运行”按提示在正确的插件目录里重新安装一次。'
        : setupWatchActive
          ? '请在插件目录里双击“install-updater.cmd”，按窗口提示完成。返回此页后会自动重新检查；失败时可再点“运行”重看步骤。'
          : `更新宿主尚未连接${response?.error ? '：' + response.error : ''}。点“运行”查看安装步骤。`;
    out(updSetupMsg, message, 'err');
    return false;
  };
  const checkSetupHost = async (installed = false) => {
    if (setupPollBusy) return false;
    setupPollBusy = true;
    try { return showSetupStatus(await send('DIAG_UPDATE_HOST'), installed); }
    finally { setupPollBusy = false; }
  };
  const scheduleSetupPoll = () => {
    if (!setupWatchActive || setupPollTimer) return;
    setupPollTimer = setTimeout(async () => {
      setupPollTimer = 0;
      const ready = await checkSetupHost(true);
      if (!ready) scheduleSetupPoll();
    }, 3000);
  };
  /* 安装指引：不再下载安装器，改为告诉用户去插件目录双击 install-updater.cmd。
     插件目录只能由宿主上报（未打包扩展的磁盘路径无法从扩展内部取到）。 */
  const showSetupGuide = () => {
    updGuidePath.textContent = setupHostRoot
      ? '插件目录：' + setupHostRoot
      : '插件目录：到 Edge 扩展管理页（edge://extensions）找到“作业助手”，页面上会显示它的文件夹路径';
    updGuide.hidden = false;
    updSetupMsg.hidden = true;
    updGuideClose.focus();
    setupWatchActive = true;
    scheduleSetupPoll();
  };
  const transactionKey = `hw-update-transaction:${chrome.runtime.id}`;
  const updProgressWrap = $('#updProgressWrap');
  const updProgress = $('#updProgress');
  const updProgressText = $('#updProgressText');
  const phaseText = {
    checking: '正在锁定本轮更新提交…',
    downloading: '正在下载并校验固定提交…',
    replacing: '文件已校验，正在替换；旧版备份仍保留…',
    awaiting_reload: '正在请求浏览器重载…',
    awaiting_health: '新后台已启动，正在验证设置页和关键资源…',
    retrying: '本轮失败，正在从同一提交完整重拉一次…',
  };
  let transactionTimer = 0;
  const setProgressLabel = (value, accessibleText = value) => {
    if (updProgressText.textContent !== value) updProgressText.textContent = value;
    if (updProgress.getAttribute('aria-valuetext') !== accessibleText) updProgress.setAttribute('aria-valuetext', accessibleText);
  };
  const renderProgress = (state) => {
    const { phase } = state || {};
    if (phase === 'downloading') {
      updProgressWrap.hidden = false;
      const total = Math.max(0, Number(state.totalFiles) || 0);
      const completed = Math.max(0, Math.min(total, Number(state.downloadedFiles) || 0));
      if (total) {
        const percent = Math.floor(completed * 100 / total);
        updProgress.value = percent;
        setProgressLabel(`${percent}%（${completed}/${total}）`, `已下载并校验 ${completed} 个，共 ${total} 个文件`);
      } else {
        updProgress.value = 0;
        setProgressLabel('准备中', '正在准备更新文件');
      }
      return;
    }
    if (['checking', 'retrying', 'replacing', 'awaiting_reload', 'awaiting_health'].includes(phase)) {
      updProgressWrap.hidden = false;
      if (phase === 'replacing' || phase === 'awaiting_reload' || phase === 'awaiting_health') {
        updProgress.value = 100;
        const label = phase === 'replacing' ? '文件已校验' : phase === 'awaiting_reload' ? '等待重载' : '运行验证';
        setProgressLabel(label, label);
      } else {
        updProgress.value = 0;
        const label = phase === 'retrying' ? `重试 ${state.attempt || 2}/2` : '准备中';
        setProgressLabel(label, label);
      }
      return;
    }
    updProgressWrap.hidden = true;
  };
  const prepareProgress = () => {
    updProgressWrap.hidden = false;
    updProgress.value = 0;
    setProgressLabel('准备中', '正在准备更新');
  };
  const pollUpdate = async (transactionId, startedAt = Date.now()) => {
    if (transactionTimer) clearTimeout(transactionTimer);
    if (Date.now() - startedAt > 12 * 60 * 1000) {
      out(updMsg, '等待更新状态超时。请重新打开设置页检查更新状态。', 'err');
      updProgressWrap.hidden = true;
      updRun.disabled = false;
      updRun.textContent = '更新';
      return;
    }
    const response = await nativeUpdateRequest({ type: 'update_status', transactionId });
    const state = response?.state;
    if (!response?.ok || state?.transactionId !== transactionId) {
      const message = `更新进程正在启动或浏览器重载中…${response?.error ? `（${response.error}）` : ''}`;
      if (updMsg.textContent !== message) out(updMsg, message, 'ok');
      transactionTimer = setTimeout(() => pollUpdate(transactionId, startedAt), 1200);
      return;
    }
    if (phaseText[state.phase]) {
      renderProgress(state);
      const message = state.phase === 'downloading' && Number(state.attempt) > 1
        ? `正在重试下载并校验（第 ${state.attempt} 次）…`
        : phaseText[state.phase];
      if (updMsg.textContent !== message) out(updMsg, message, 'ok');
      transactionTimer = setTimeout(() => pollUpdate(transactionId, startedAt), 1200);
      return;
    }
    localStorage.removeItem(transactionKey);
    renderProgress(state);
    updRun.disabled = false;
    updRun.textContent = '更新';
    if (state.phase === 'complete' || state.phase === 'confirmed') {
      // confirmed＝宿主已收到「设置页就绪」的确认（本轮真正收尾），与 complete 同样算成功
      updRun.hidden = true;
      out(updMsg, state.phase === 'confirmed' || state.updated
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
    prepareProgress();
    out(updMsg, '正在启动独立更新进程…', 'ok');
    try {
      const r = await send('HW_RUN_UPDATE');
      if (r?.ok && r.started && r.transactionId) {
        localStorage.setItem(transactionKey, r.transactionId);
        await pollUpdate(r.transactionId);
      } else {
        updRun.disabled = false;
        updRun.textContent = '更新';
        updProgressWrap.hidden = true;
        const error = String(r?.error || '未知错误');
        if (isUpdaterHostMissing(error)) {
          updSetup.hidden = false;
          out(updSetupMsg, '更新组件尚未连接。点“运行”看安装步骤：在插件目录里双击 install-updater.cmd，完成后回来重试。', 'err');
          updSetupMsg.hidden = false;
          out(updMsg, '请先按“运行”里的步骤完成一次安装，然后重试更新。', 'err');
        } else out(updMsg, '更新失败：' + error, 'err');
      }
    } catch (error) {
      updRun.disabled = false;
      updRun.textContent = '更新';
      updProgressWrap.hidden = true;
      out(updMsg, '更新失败：' + String(error?.message || error), 'err');
    }
  };
  updBtn.addEventListener('click', () => check(true));
  updSetup.addEventListener('click', () => showSetupGuide());
  updGuideClose.addEventListener('click', () => {
    updGuide.hidden = true;
    if (!updSetup.hidden) updSetup.focus();
  });
  updRun.addEventListener('click', () => runUpdate());
  let autoChecked = false;
  onSection = (key) => {
    if (key === 'watch') loadWatchSections(); // 每次进来重读，别的页面改过也能对上
    if (key === 'diag') loadIssues();
    if (key === 'upd') {
      if (!autoChecked) {
        autoChecked = true;
        check(false);
      }
      loadAutoUpdate();
      checkSetupHost();
    }
  };
  /* 半自动更新开关：默认开；关掉后只在用户点「更新」时升级。 */
  const updAuto = $('#updAuto');
  const loadAutoUpdate = async () => {
    try {
      const cfg = (await send('GET_CONFIG'))?.config || {};
      updAuto.checked = cfg.autoUpdate !== false;
    } catch { updAuto.checked = true; }
  };
  updAuto.addEventListener('change', async () => {
    const res = await send('SET_CONFIG', { autoUpdate: updAuto.checked });
    if (res?.ok) out(updMsg, updAuto.checked ? '已开启：后台定时检查，刷课空闲时自动升级' : '已关闭：只在点「更新」时升级', 'ok');
    else out(updMsg, '保存失败' + (res?.error ? '：' + res.error : ''), 'err');
  });
  const refreshSetupHost = () => { if (!secs.upd.hidden) checkSetupHost(); };  window.addEventListener('focus', refreshSetupHost);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshSetupHost();
  });
  if (!secs.upd.hidden) onSection('upd'); // 直接以 #upd 打开时也要自动检查
  updCurrent.textContent = 'v' + chrome.runtime.getManifest().version;
  const healthTransaction = new URLSearchParams(location.search).get('updateHealth');
  if (healthTransaction) {
    updProgressWrap.hidden = false;
    updProgress.value = 100;
    setProgressLabel('运行验证', '新版后台正在进行运行验证');
    out(updMsg, '设置页已加载，正在等待后台确认本轮版本…', 'ok');
    let healthTries = 0;
    const acknowledge = async () => {
      const result = await send('UPDATE_PAGE_READY', { transactionId: healthTransaction });
      if (result?.accepted) {
        localStorage.removeItem(transactionKey); // 本轮已确认：清掉事务标记，重开设置页不会再拉起进度条
        updProgressWrap.hidden = true; // 进度条只在更新进行中出现，确认后收起
        out(updMsg, '已更新并通过运行验证；作业页面请刷新(F5)后使用新版', 'ok');
        return;
      }
      if (++healthTries >= 60) {
        updProgressWrap.hidden = true;
        out(updMsg, '运行验证未收到确认。到扩展管理页手动重载一次，或重新打开设置页检查更新状态。', 'err');
        return;
      }
      setTimeout(acknowledge, 1000);
    };
    acknowledge();
  }
  const activeTransaction = localStorage.getItem(transactionKey);
  if (activeTransaction && !healthTransaction) {
    updRun.disabled = true;
    updRun.textContent = '更新中…';
    prepareProgress();
    pollUpdate(activeTransaction);
  }
})();
