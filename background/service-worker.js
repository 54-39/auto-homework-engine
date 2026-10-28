/* 后台 Service Worker：引擎路由、题目队列、答案缓存、与作业页消息中转、热重载、自动更新检查 */
import { answerWithAPI, testAPI, sanitizeKey, detectEndpoint, requestWithAPI } from './engines/api-engine.js';
import { answerWithBridge, requestWithBridge, openBridgeView } from './engines/bridge-engine.js';
import { detectQuestions } from './engines/detection-engine.js';
import { hashKey, compareVersions, isMajorUpdate } from './engines/engine.js';
import { appendIssue, readIssuePage, clearIssueHistory } from './issue-history.js';

const DEFAULT_CONFIG = {
  engine: 'api', // api | bridge
  api: { iface: 'auto', baseURL: '', model: '', apiKey: '' },
  bridge: { newChat: false, delayMin: 3000, delayMax: 8000, viewMode: 'split' },
  subjMode: 'ask', // 简答题策略：ask=每次弹窗询问 | keep=保留跳过 | rewrite=清空重写
  verify2: true, // 多选/判断题二次复核开关（API 引擎）：关掉每题少一次 AI 调用
  watchRate: 'auto', // 刷课倍速：'auto' 跟播放器菜单最高档 | '1'/'1.25'/'1.5'/'2' 固定档
  watchSections: 0, // 每门课从第一节起连续处理几节（0 = 整门课程）；设置页可改，面板不再写死 4
  watchMuted: true, // 保持原有刷课默认静音；面板可取消
  autoUpdate: true, // 后台定时检查，空闲时自动装新版（刷课中不打断）；设置页可关
  panelMode: 'homework', // API 面板：写题 / 刷课
  diagnosticsEnabled: false, // 用户打开诊断记录开关后才采集和写入新异常
};

let run = null; // { tabId, cancelled, items: [{ q, status, answer, error }] }
const detectingTabs = new Map();

/* —— 多课程刷课队列 ——
   刷课脚本每跳一次页面就重新加载一遍，内存全丢，所以队列只能存在这里。
   内容脚本到新页面先问一句「我该干什么」，后台指着当前这门课；一门走完报一次，
   后台把标签页导航到下一门的课程目录页。 */
/*　MV3 的后台空闲 30 秒就被回收，整门课要刷几小时，队列只放内存必然丢，
    所以每次都顺手落一份到 storage.local；新页面来问时再读回来。 */
const WQ_KEY = 'watchQueue';
let quizRetryClaims = Promise.resolve();
let fontIndex;
let watchQueue = null; // { courses:[{key,scUrl,name}], index, tabId, rate, autoRate }
let watchNavigationEpoch = 0;
let issueWrites = Promise.resolve();
function recordIssue(entry, sender = {}) {
  const storedPromise = chrome.storage.local.get(['config', 'savedKeys']);
  // 开关确认后立即采集，不等前一条写入；关闭时连采集请求也不发送。
  const scenePromise = storedPromise.then(async stored => {
    if (stored.config?.diagnosticsEnabled !== true) return null;
    if (entry.scene) return entry.scene;
    if (!sender.tab?.id) return { status: 'unavailable', reason: '没有可读取的页面上下文' };
    let timer;
    try {
      return await Promise.race([
        chrome.tabs.sendMessage(sender.tab.id, { type: 'HW_DIAGNOSTIC_CAPTURE' }, { frameId: sender.frameId ?? 0 }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('现场采集超时')), 1500); }),
      ]) || { status: 'unavailable', reason: '页面未返回现场' };
    } catch (e) { return { status: 'unavailable', reason: String(e.message || e) }; }
    finally { clearTimeout(timer); }
  }).catch(e => ({ status: 'unavailable', reason: String(e.message || e) }));
  const write = issueWrites.then(async () => {
    const stored = await storedPromise;
    if (stored.config?.diagnosticsEnabled !== true) return { ok: true, skipped: true };
    const secrets = [stored.config?.api?.apiKey, ...(stored.savedKeys || []).map(row => row.key)].filter(Boolean);
    const clean = value => {
      let text = String(value || '');
      for (const secret of secrets) text = text.split(secret).join('[已隐藏]');
      return text.replace(/Bearer\s+[^\s]+/gi, 'Bearer [已隐藏]')
        .replace(/https?:\/\/[^\s"<>]+/g, value => { try { const u = new URL(value); return u.origin + u.pathname; } catch { return '[网址]'; } });
    };
    let url = '';
    try { const u = new URL(sender.url || sender.tab?.url || entry.url); url = u.origin + u.pathname; } catch { /* 无页面上下文 */ }
    const rawScene = await scenePromise;
    const latest = await chrome.storage.local.get('config');
    if (latest.config?.diagnosticsEnabled !== true) return { ok: true, skipped: true };
    const cleanScene = (value, depth = 0) => {
      if (depth > 12) return '[层级已截断]';
      if (typeof value === 'string') return clean(value);
      if (Array.isArray(value)) return value.slice(0, 100).map(row => cleanScene(row, depth + 1));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, v]) => [clean(key), cleanScene(v, depth + 1)]));
      return value;
    };
    const scene = JSON.stringify(rawScene).length <= 600000 ? cleanScene(rawScene) : { status: 'unavailable', reason: '现场数据超出单条大小限制' };
    const item = { at: new Date().toISOString(), version: chrome.runtime.getManifest().version,
      stage: clean(entry.stage || '异常'), message: clean(entry.message), url,
      course: clean(entry.course), task: clean(entry.task), action: clean(entry.action),
      stack: clean(entry.stack), details: clean(entry.details),
      chapter: clean(entry.chapter), question: clean(entry.question), answer: clean(entry.answer),
      score: typeof entry.score === 'number' ? entry.score : null, count: 1, scene };
    if (!item.message) return;
    await appendIssue(item);
  });
  issueWrites = write.catch(() => {});
  return write;
}

async function saveQueue(q) {
  watchQueue = q;
  if (q) await chrome.storage.local.set({ [WQ_KEY]: q }).catch(() => {});
  else await chrome.storage.local.remove(WQ_KEY).catch(() => {});
}

async function loadQueue() {
  /* storage 是队列的唯一事实来源：早期版本在这里做了内存缓存，浏览器重启/换标签页后
     内存里还留着旧 tabId，导致 HW_WATCH_QUEUE_GET 回 null、整轮接不上（2026-10-21 实测）。
     每次读取都回 storage，代价只是一次异步读，换来的是不会读到过期属主。 */
  const got = await chrome.storage.local.get(WQ_KEY).catch(() => ({}));
  watchQueue = got?.[WQ_KEY] || null;
  return watchQueue;
}

const WATCH_HOST_ACCESS_ERROR = '缺少超星持续站点访问权限：请先点击「刷新课程」按提示授权超星站点，再开始刷课；仅在点击时的临时访问无法保证跨域读取和自动换节。';
async function ensureWatchHostAccess() {
  if (await chrome.permissions.contains({ origins: ['https://*.chaoxing.com/*'] })) return true;
  const q = await loadQueue();
  if (q && !q.paused) {
    q.paused = WATCH_HOST_ACCESS_ERROR;
    await saveQueue(q);
    sendTab(q.tabId, { type: 'HW_WATCH_FINISHED', payload: { cancelled: true, reason: q.paused } });
  }
  return false;
}

async function pauseWatchForInterruptedPage(tab) {
  if (!tab) return false;
  const accountNotice = /^https?:\/\/detect\.chaoxing\.com\/api\/monitor_temp(?:[?#]|$)/.test(tab.url || '');
  const leftCourse = /^https?:\/\/i\.(?:mooc\.)?chaoxing\.com\/space(?:[/?#]|$)/.test(tab.url || '');
  if (!accountNotice && !leftCourse) return false;
  const q = await loadQueue();
  if (!q || q.tabId !== tab.id) return false;
  if (!q.paused) {
    watchNavigationEpoch++;
    q.paused = accountNotice
      ? '平台显示账号登录检测提示，已暂停并保留队列；请先处理网页提示，再手动继续。'
      : '已退出课程学习页，队列已暂停；点「开始刷课」继续。';
    await saveQueue(q);
    sendTab(q.tabId, { type: 'HW_WATCH_FINISHED', payload: { cancelled: true, reason: q.paused } });
  }
  return true;
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) pauseWatchForInterruptedPage({ ...tab, id: tabId, url: changeInfo.url }).catch(() => {});
});

async function watchGo(index) {
  const epoch = watchNavigationEpoch;
  const current = () => epoch === watchNavigationEpoch;
  let q = await loadQueue();
  if (!current() || !q || q.paused) return;
  if (!(await ensureWatchHostAccess())) return;
  if (!current()) return;
  q = await loadQueue();
  if (!current() || !q || q.paused) return;
  q.index = index;
  const cur = q.courses[index];
  if (!cur) {
    if (Number(q.targetRun) >= 1) {
      const size = Math.max(1, Math.min(10, Number(q.targetRun) || 4)); // 设置页选的节数
      const report = { at: new Date().toISOString(), courses: q.courses.map(c => ({
        key: c.key, name: c.name, status: c.outcome?.status || 'incomplete',
        chapterIds: c.outcome?.chapterIds || [], exceptions: c.outcome?.exceptions || [], gaps: c.gaps || [] })) };
      await chrome.storage.local.set({ watchFourReport: report });
      if (!current()) return;
      const done = report.courses.filter(c => c.status === 'complete' || c.status === 'complete_with_exceptions').length;
      /* 用户 2026-10-21：不达目标不罢休。这一轮没收尾的课自动再排一轮，
         最多 3 轮（每轮都从目录重新核验，已完成的小节会被跳过，只重做欠账的那几个点）。
         不无限重试：一门课真做不完（字体还原不了、题面读不出）不该占着队列转一晚上。 */
      const failed = q.courses.filter(c => !['complete', 'complete_with_exceptions'].includes(c.outcome?.status || 'incomplete'));
      const round = Number(q.round) || 1;
      /* 上限从 3 放宽到 5：传统文化/大学英语的测验补丁是第 2 轮中途才上线的，
         它们第 3 轮的欠账要再给机会（用户：不达目标不罢休）。 */
      if (failed.length && round < 5) {
        const next = {
          courses: failed.map(c => ({ key: c.key, scUrl: c.scUrl, name: c.name,
            ...(Number.isFinite(c.done) && Number.isFinite(c.total) ? { done: c.done, total: c.total } : {}) })),
          index: 0,
          tabId: q.tabId,
          rate: q.rate || 2,
          autoRate: !!q.autoRate,
          targetRun: size,
          round: round + 1,
        };
        await saveQueue(next);
        if (!current()) return;
        notify(`第 ${round} 轮：${done}/${q.courses.length} 门达标，剩 ${failed.length} 门，开始第 ${round + 1} 轮`);
        await chrome.tabs.update(q.tabId, { url: next.courses[0].scUrl }).catch(() => {});
        return;
      }
      await saveQueue(null);
      if (!current()) return;
      notify(`开头 ${size} 节核验：${done}/${report.courses.length} 门达标（口语例外单列）；其余详见插件日志`);
      sendTab(q.tabId, { type: 'HW_WATCH_FINISHED', payload: { count: done, total: report.courses.length, targetRun: size, limited: true } });
      return;
    }
    await saveQueue(null);
    if (!current()) return;
    const limited = q.courses.some(course => course.chapterIds?.length);
    /* 补刷后仍未完成、被跳过的节（多是阅读/文档类任务点，站点不计完成）——一起报出来，
       否则用户只会看到「都走完了」，实际还有几节要人工看。 */
    const gaps = (await chrome.storage.local.get('watchGaps').catch(() => ({}))).watchGaps || [];
    if (!current()) return;
    const gapCount = gaps.reduce((sum, g) => sum + (g.sections?.length || 0), 0);
    const tail = gapCount ? `；另有 ${gapCount} 个小节需人工完成（详见插件日志）` : '';
    notify(limited ? `刷课结束：${q.courses.length} 门课的本次限定小节已完成${tail}` : `刷课结束：${q.courses.length} 门课都走完了${tail}`);
    sendTab(q.tabId, { type: 'HW_WATCH_FINISHED', payload: { count: q.courses.length, limited } });
    return;
  }
  await saveQueue(q);
  if (!current()) return;
  await chrome.tabs.update(q.tabId, { url: cur.scUrl }).catch(() => {});
}

async function detectPage(payload, sender) {
  const tabId = sender.tab?.id;
  const host = new URL(sender.url || sender.tab?.url || 'about:blank').hostname;
  if (tabId == null || !(host === 'chaoxing.com' || host.endsWith('.chaoxing.com'))) throw new Error('只支持在超星页面检测题目');
  if (detectingTabs.has(tabId)) throw new Error('正在识别题目，请等待本次检测完成');
  const operation = { cancelled: false };
  detectingTabs.set(tabId, operation);
  try {
    const cfg = await getConfig();
    const request = cfg.engine === 'bridge'
      ? (messages) => requestWithBridge(messages, cfg.bridge)
      : (messages) => requestWithAPI(messages, cfg.api);
    const questions = await detectQuestions(payload.batches, async (messages) => {
      if (operation.cancelled) throw new Error('已取消识别，请重新检测');
      let result;
      try { result = await request(messages); }
      catch (error) {
        if (cfg.engine === 'bridge' && !operation.cancelled) notify('豆包识题已暂停：' + String(error.message || error).slice(0, 90), true);
        throw error;
      }
      if (operation.cancelled) throw new Error('已取消识别，请重新检测');
      return result;
    }, (current, total) => {
      sendTab(tabId, { type: 'HW_DETECT_PROGRESS', payload: { requestId: payload.requestId, current, total } });
    });
    return { ok: true, questions };
  } finally {
    detectingTabs.delete(tabId);
  }
}

/* 暂停当前队列（风控/多次失败共用），发通知 + 面板红字 */
function pauseRun(tabId, reason) {
  if (run) run.cancelled = true;
  const item = run?.items.find(i => i.status === 'failed');
  const question = item?.q && [item.q.stem, ...(item.q.options || []).map(option => `${option.key}. ${option.text}`)].join('\n');
  recordIssue({ stage: '答题失败', message: item?.error || reason, question, answer: item?.raw || item?.answer?.answer, url: run?.sourceUrl }, { tab: { id: tabId } })
    .catch(e => {
      sendTab(tabId, { type: 'HW_ISSUE_WRITE_FAILED', payload: { error: String(e.message || e) } });
      notify('异常记录写入失败，已停止答题：' + String(e.message || e).slice(0, 100));
    });
  notify('已暂停：' + reason.slice(0, 90), run?.engine === 'bridge');
  return sendTab(tabId, { type: 'HW_DONE', payload: { paused: reason, requestId: run?.requestId } });
}

function deepMerge(base, patch) {
  for (const k in patch) {
    base[k] = patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k]) ? deepMerge(base[k] ?? {}, patch[k]) : patch[k];
  }
  return base;
}

async function getConfig() {
  const { config } = await chrome.storage.local.get('config');
  return deepMerge(structuredClone(DEFAULT_CONFIG), config || {});
}

function sendTab(tabId, msg) {
  if (tabId == null) return Promise.resolve();
  return chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

/* —— 系统通知：风控验证/队列暂停/完成提醒。点击通知跳转到豆包标签页 —— */
const RISKY_RE = /风控|安全验证|人机验证|验证码|人脸验证|需要登录|登录墙/;
const AUTH_RE = /HTTP 40[13]|authentication|invalid[_ ]?api[_ ]?key|认证|鉴权/i;
let lastNotifyAt = 0;
function notify(message, openDoubao = false) {
  const now = Date.now();
  if (now - lastNotifyAt < 5000 && !openDoubao) return; // 需要处理登录/验证的通知不被普通状态通知挡住。
  lastNotifyAt = now;
  try {
    chrome.notifications.create(
      openDoubao ? 'hw-doubao-attention' : 'hw-status',
      { type: 'basic', iconUrl: 'icons/icon128.png', title: '作业助手', message },
      () => void chrome.runtime.lastError,
    );
  } catch {
    /* 通知权限异常时静默 */
  }
}
chrome.notifications?.onClicked.addListener(async id => {
  if (id !== 'hw-doubao-attention') return;
  const tabs = await chrome.tabs.query({ url: '*://*.doubao.com/*' });
  const tab = tabs.length ? await chrome.tabs.update(tabs[0].id, { active: true })
    : await chrome.tabs.create({ url: 'https://www.doubao.com/chat/', active: true });
  try {
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    /* 窗口可能已关闭 */
  }
});

/* —— 更新检查：拉取仓库 manifest 版本号与本地比较；结果缓存 1 小时（c: 前缀键）——
   更新源按序尝试：① GitHub API（实时、无 CDN 缓存，刚发的版立刻能看到；匿名配额 60 次/小时/IP，
   超了会 403）② jsDelivr CDN 镜像（大陆可达，但 @master 最长缓存 12h，发版当天可能读到旧号）
   ③ GitHub raw（海外保底）；每个源只试一次、不重试；GitHub API 返回的是 base64 内容，只取其中 version；
   自动检查只发生在设置页「检测更新」分区；面板用 cacheOnly 只读上次结果、不联网（只提示功能更新）；
   失败静默返回 ok:false；force=true 绕过缓存（设置页「立即检查」）；任何情况下都不自动安装、不阻断使用 */
const UPDATE_SOURCES = [
  'https://api.github.com/repos/54-39/auto-homework-engine/contents/manifest.json?ref=master',
  'https://cdn.jsdelivr.net/gh/54-39/auto-homework-engine@master/manifest.json',
  'https://raw.githubusercontent.com/54-39/auto-homework-engine/master/manifest.json',
];
const UPDATE_PAGE = 'https://github.com/54-39/auto-homework-engine';
const UPDATE_TTL = 3600e3;
function updResult(current, latest, cached) {
  const hasUpdate = compareVersions(latest, current) > 0;
  return { ok: true, current, latest, hasUpdate, major: hasUpdate && isMajorUpdate(latest, current), url: UPDATE_PAGE, cached };
}
async function checkUpdate(force, cacheOnly) {
  const current = chrome.runtime.getManifest().version;
  const o = await chrome.storage.local.get('c:upd');
  const prev = o['c:upd'] || null;
  if (cacheOnly) return prev ? updResult(current, prev.latest, true) : { ok: false, error: '尚未检查过更新' };
  if (!force && prev && Date.now() - prev.at < UPDATE_TTL) return updResult(current, prev.latest, true);
  let latest = '';
  let lastErr = '';
  for (const src of UPDATE_SOURCES) {
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const text = data.content ? atob(String(data.content).replace(/\s/g, '')) : ''; // GitHub API 给的是 base64 内容
      latest = String((text ? JSON.parse(text) : data).version || '');
      if (latest) break;
    } catch (e) {
      lastErr = String(e.message || e); // 所有源都失败时返回最后一个源的错误
    }
  }
  if (!latest) return { ok: false, error: lastErr || '更新源未返回版本号' };
  await chrome.storage.local.set({ 'c:upd': { latest, at: Date.now() } });
  return updResult(current, latest, false);
}

async function askEngine(cfg, q, auto = false) {
  if (cfg.engine === 'bridge') return answerWithBridge(q, cfg.bridge);
  return answerWithAPI(q, cfg.api, { verify2: cfg.verify2 !== false, auto });
}

const UPDATE_HOST = `com.homeworkhelper.autoupdate.${chrome.runtime.id}`;
function nativeRequest(message, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(UPDATE_HOST);
    } catch (e) {
      return resolve({ ok: false, error: '原生宿主未安装：' + String(e.message || e) });
    }
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port.disconnect(); } catch { /* 已断开 */ }
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, error: '宿主请求超时' }), timeoutMs);
    port.onMessage.addListener((m) => { clearTimeout(timer); done(m || { ok: false, error: '宿主返回空结果' }); });
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message || '';
      if (/native messaging host/i.test(err)) {
        return done({ ok: false, error: '更新宿主未安装或已失效。请双击插件目录中的 install-updater.cmd，然后重试' });
      }
      done({ ok: false, error: '宿主提前退出' + (err ? '：' + err : '') });
    });
    port.postMessage({ ...message, extensionId: chrome.runtime.id });
  });
}

function runUpdateViaHost() {
  const transactionId = crypto.randomUUID();
  return chrome.storage.local.set({ updateTransactionId: transactionId })
    .then(() => nativeRequest({ type: 'run_update', transactionId }, 15000))
    .then(async (result) => {
      if (!result?.started) await chrome.storage.local.remove(['updateTransactionId']);
      return { ...result, transactionId };
    });
}

function updateStatus(transactionId) {
  return nativeRequest({ type: 'update_status', transactionId }, 10000);
}

async function confirmUpdatePage(transactionId, sender) {
  if (!sender?.url?.startsWith(chrome.runtime.getURL('settings.html'))) return { ok: false, error: '健康页来源不匹配' };
  let pageTransaction = '';
  try { pageTransaction = new URL(sender.url).searchParams.get('updateHealth') || ''; } catch { /* invalid URL */ }
  if (!transactionId || pageTransaction !== transactionId) return { ok: false, error: '健康页事务 ID 不匹配' };
  const result = await updateStatus(transactionId);
  const state = result?.state;
  if (!result?.ok || state?.phase !== 'awaiting_health' || state?.latest !== chrome.runtime.getManifest().version) {
    return { ok: false, error: '后台或设置页尚未通过本轮版本检查' };
  }
  const ack = await nativeRequest({
    type: 'confirm_update', transactionId, targetVersion: state.latest,
    revision: state.revision, settingsReady: true,
  }, 10000);
  if (ack?.accepted) {
    await chrome.storage.local.remove(['updateTransactionId']);
    return { ok: true, accepted: true };
  }
  return ack;
}

let healthPageCheck = false;
async function openUpdateHealthPage() {
  if (healthPageCheck) return;
  healthPageCheck = true;
  try {
    const { updateTransactionId } = await chrome.storage.local.get('updateTransactionId');
    if (!updateTransactionId) return;
    const result = await updateStatus(updateTransactionId);
    const state = result?.state;
    if (!result?.ok || state?.phase !== 'awaiting_health' || state.latest !== chrome.runtime.getManifest().version) return;
    const url = chrome.runtime.getURL(`settings.html?updateHealth=${encodeURIComponent(updateTransactionId)}#upd`);
    const existing = await chrome.tabs.query({ url: chrome.runtime.getURL('settings.html') + '*' });
    if (existing.some((tab) => {
      try { return new URL(tab.url).searchParams.get('updateHealth') === updateTransactionId; }
      catch { return false; }
    })) return;
    await chrome.tabs.create({ url, active: false });
  } catch { /* 后续轮询或设置页重试 */ }
  finally { healthPageCheck = false; }
}

/* —— 半自动更新：后台定时检查，刷课空闲时自动装上新版 ——
   目的：GitHub 通道装一次之后不用再去网页手动更新。刷课队列在跑时一律不动文件，
   避免正在刷的页面被换掉；失败全部静默，只在设置页留状态。 */
const AUTO_UPDATE_INTERVAL = 3600e3;
let autoUpdateBusy = false;
async function autoUpdateTick() {
  if (autoUpdateBusy) return;
  autoUpdateBusy = true;
  try {
    const cfg = await getConfig();
    if (cfg.autoUpdate === false) return;
    const r = await checkUpdate(false);
    if (!r?.ok || !r.hasUpdate) return;
    const q = await loadQueue().catch(() => null);
    if (q) return; // 有刷课队列：等它跑完再装
    await chrome.storage.local.set({ pendingAutoUpdate: r.latest });
    const started = await runUpdateViaHost();
    if (!started?.started) await chrome.storage.local.remove(['pendingAutoUpdate']);
  } catch { /* 静默：设置页能看到具体状态 */ }
  finally { autoUpdateBusy = false; }
}
setTimeout(autoUpdateTick, 45000);
setInterval(autoUpdateTick, AUTO_UPDATE_INTERVAL);

/* 重载后的新后台：版本已经追上去就通知一次，并清掉标记。 */
(async () => {
  const { pendingAutoUpdate } = await chrome.storage.local.get('pendingAutoUpdate');
  if (!pendingAutoUpdate) return;
  const cur = chrome.runtime.getManifest().version;
  if (compareVersions(cur, String(pendingAutoUpdate)) < 0) return;
  await chrome.storage.local.remove(['pendingAutoUpdate']);
  lastNotifyAt = 0;
  notify(`已更新到 v${cur}：作业页面刷新(F5)后使用新版`);
})();

/* 安装入口打开设置页时执行一次宿主自检；只 ping，不执行更新。 */
function diagUpdateHost() {
  return nativeRequest({ type: 'ping' }, 10000).then((r) => r?.pong
    ? { ok: true, node: r.node, root: r.root, manifestVersion: r.manifestVersion, extensionId: r.extensionId }
    : { ok: false, stage: 'connect', error: r?.error || '宿主返回异常' });
}

function cacheKeyOf(q) {
  return hashKey(JSON.stringify({ v: 2, t: q.type, s: q.stem, o: (q.options || []).map((x) => x.text), b: q.blanks || 0, d: q.slotOptions || [] }));
}
async function cached(key) {
  const o = await chrome.storage.local.get('c:' + key);
  return o['c:' + key] || null;
}
function cacheSet(key, val) {
  return chrome.storage.local.set({ ['c:' + key]: val });
}

async function fillAnswer(activeRun, index, payload) {
  const item = activeRun.items[index];
  item.fillToken = crypto.randomUUID();
  item.status = 'answered';
  sendTab(activeRun.tabId, { type: 'HW_ANSWER', payload: { ...payload, index, fillToken: item.fillToken, requestId: activeRun.requestId } });
  const deadline = Date.now() + 30000;
  while (item.status === 'answered' && !activeRun.cancelled && run === activeRun && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (activeRun.cancelled || run !== activeRun) return false;
  if (item.status === 'answered') {
    item.status = 'failed';
    item.error = '页面填写回执超时，已停止；请刷新页面（F5）后核对';
    sendTab(activeRun.tabId, { type: 'HW_STATUS', payload: { index, status: 'failed', error: item.error, requestId: activeRun.requestId } });
    await pauseRun(activeRun.tabId, item.error);
  }
  return item.status === 'filled' || (activeRun.auto && item.status === 'failed' && !activeRun.cancelled);
}

async function startRun(questions, tabId, sourceUrl, auto = false, requestId) {
  if (run) run.cancelled = true;
  const activeRun = { tabId, sourceUrl, requestId, engine: null, auto: false, cancelled: false,
    items: questions.map((q) => ({ q, status: 'queued', answer: null, error: null })) };
  run = activeRun;
  const cfg = await getConfig();
  if (activeRun.cancelled || run !== activeRun) return { ok: false, error: '本次答题已取消' };
  activeRun.engine = cfg.engine;
  activeRun.auto = auto && cfg.engine === 'api';
  if (cfg.engine === 'bridge') {
    try { await openBridgeView(tabId, cfg.bridge); }
    catch (e) {
      activeRun.cancelled = true;
      return { ok: false, error: String(e.message || e) };
    }
    if (activeRun.cancelled || run !== activeRun) return { ok: false, error: '本次答题已取消' };
  }
  (async () => {
    for (let i = 0; i < activeRun.items.length; i++) {
      if (activeRun.cancelled || run !== activeRun) return;
      const item = activeRun.items[i];
      // 面板逐题决策：skip=已写且正确（跳过） / rewrite=写错（用参考答案改写） / ask=问引擎
      if (item.q._decision === 'skip') {
        item.status = 'skipped';
        const sn = item.q._skipNote || `已写且正确（页面: ${item.q._pageAnswer || '空'}），跳过`;
        sendTab(tabId, { type: 'HW_STATUS', payload: { index: i, status: 'skipped', note: sn, requestId: activeRun.requestId } });
        continue;
      }
      if (item.q._decision === 'rewrite') {
        item.answer = { answer: item.q._refAnswer, note: '改写' };
        if (!(await fillAnswer(activeRun, i, { answer: item.q._refAnswer, kind: 'rewrite', note: `写错了已改写（页面原答案: ${item.q._pageAnswer || '空'}）` }))) return;
        continue;
      }
      item.status = 'asking';
      sendTab(tabId, { type: 'HW_STATUS', payload: { index: i, status: 'asking', requestId: activeRun.requestId } });
      try {
        const key = await cacheKeyOf(item.q);
        let ans = item.q._refresh || (activeRun.auto && item.q._retry) ? null : await cached(key);
        if (ans && /采用初答|先刷完|复核不一致|复核失败/.test(ans.note || '')) ans = null;
        if (activeRun.cancelled || run !== activeRun) return;
        const fromCache = !!ans;
        if (!ans) {
          const r = await askEngine(cfg, item.q, activeRun.auto);
          if (activeRun.cancelled || run !== activeRun) return;
          ans = { answer: r.answer, note: r.note || null };
          await cacheSet(key, ans);
        }
        if (activeRun.cancelled || run !== activeRun) return;
        item.answer = ans;
        if (!(await fillAnswer(activeRun, i, { answer: ans.answer, fromCache, note: ans.note }))) return;
      } catch (e) {
        if (activeRun.cancelled || run !== activeRun) return;
        item.status = 'failed';
        item.error = String(e.message || e);
        item.raw = e.answerPreview;
        sendTab(tabId, { type: 'HW_STATUS', payload: { index: i, status: 'failed', error: item.error, answerPreview: item.raw, requestId: activeRun.requestId } });
        // 风控/验证类错误：第一次就暂停队列，不去撞验证码
        if (cfg.engine === 'bridge' && RISKY_RE.test(item.error)) {
          return pauseRun(tabId, '豆包需要人工确认，队列已暂停：' + item.error);
        }
        // 鉴权失败：Key 无效/不匹配，继续跑只会全部失败，立即暂停
        if (AUTH_RE.test(item.error)) {
          return pauseRun(tabId, 'API 鉴权失败（Key 无效或与接口地址不匹配）。包月套餐（如火山 Coding Plan）必须选对应供应商预设、用 /api/coding 专用地址：' + item.error.slice(0, 110));
        }
        if ((activeRun.auto || cfg.engine === 'bridge') && e.code === 'HW_ANSWER_UNAVAILABLE') {
          const options = (item.q.options || []).map(option => option.key).filter(key => /^[A-H]$/.test(key));
          const slots = item.q.slotOptions || [];
          const pick = values => values[Math.floor(Math.random() * values.length)];
          const guess = e.candidateAnswer || (item.q.type === 'judge' ? (Math.random() < .5 ? '对' : '错')
            : ['choice', 'multi'].includes(item.q.type) && options.length ? pick(options)
            : item.q.type === 'blank' && slots.length === item.q.blanks && slots.length && slots.every(values => values.length)
              ? JSON.stringify(slots.map(pick)) : '');
          if (guess) {
            const note = e.candidateAnswer ? '复核未确认，采用初答继续' : 'AI 无法作答，猜选兜底（未确认）';
            item.answer = { answer: guess, note };
            item.guessed = !e.candidateAnswer;
            if (cfg.engine === 'bridge') {
              await recordIssue({ stage: '猜选兜底', message: note,
                question: [item.q.stem, ...(item.q.options || []).map(option => `${option.key}. ${option.text}`)].join('\n'),
                answer: guess, details: item.error + '\n复核返回：' + (item.raw || ''), url: activeRun.sourceUrl }, { tab: { id: tabId } })
                .catch(error => sendTab(tabId, { type: 'HW_ISSUE_WRITE_FAILED', payload: { error: String(error.message || error) } }));
            }
            // 用户授权的刷课/豆包兜底均不写入可信答案缓存。
            if (!(await fillAnswer(activeRun, i, { answer: guess, note, fallback: true, answerPreview: item.raw }))) return;
          }
        } else {
          // 非内容错误仍暂停，避免在页面或桥接异常时继续操作。
          return pauseRun(tabId, item.error.slice(0, 140));
        }
      }
      if (cfg.engine === 'bridge') {
        // 按用户配置的间隔等待，控制连续请求频率
        const { delayMin = 3000, delayMax = 8000 } = cfg.bridge || {};
        const wait = delayMin + Math.random() * Math.max(0, delayMax - delayMin);
        await new Promise((r) => setTimeout(r, wait));
      } else {
        await new Promise((r) => setTimeout(r, activeRun.auto ? 100 : 300));
      }
    }
    if (activeRun.cancelled || run !== activeRun) return;
    const filled = activeRun.items.filter((it) => it.status === 'filled').length;
    const failed = activeRun.items.filter((it) => it.status === 'failed').length;
    const skipped = activeRun.items.filter((it) => it.status === 'skipped').length;
    const guessedIndexes = activeRun.items.flatMap((it, index) => it.guessed && it.status === 'filled' ? [index] : []);
    notify(failed ? `答题完成：填写 ${filled}、跳过 ${skipped}、失败 ${failed} 题` : `处理完成：填写 ${filled}、跳过 ${skipped}，请检查后手动提交`);
    sendTab(tabId, { type: 'HW_DONE', payload: { total: activeRun.items.length, filled, failed, skipped, guessedIndexes, requestId: activeRun.requestId } });
  })();
  return { ok: true, count: questions.length, engine: cfg.engine };
}

async function rerunOne(index, tabId, requestId) {
  const activeRun = run;
  const item = activeRun?.tabId === tabId ? activeRun.items[index] : null;
  if (!item || activeRun.cancelled) return { ok: false, error: '题目不存在或已停止，请重新检测' };
  const token = item.fillToken = crypto.randomUUID();
  const current = () => run === activeRun && !activeRun.cancelled && item.fillToken === token;
  const stale = () => ({ ok: false, error: '页面题目已失效，请重新检测' });
  const cfg = await getConfig();
  if (!current()) return stale();
  item.status = 'asking';
  item.error = null;
  sendTab(tabId, { type: 'HW_STATUS', payload: { index, status: 'asking', requestId } });
  try {
    const r = await askEngine(cfg, item.q);
    if (!current()) return stale();
    item.answer = r.answer;
    // 手动重答视为最新权威答案：覆盖旧缓存（包括之前的错误答案）
    if (r.answer) {
      const key = await cacheKeyOf(item.q);
      if (!current()) return stale();
      await cacheSet(key, { answer: r.answer, note: r.note || null });
    }
    if (!current()) return stale();
    item.status = 'answered';
    sendTab(tabId, { type: 'HW_ANSWER', payload: { index, fillToken: item.fillToken, requestId, answer: r.answer, kind: 'rewrite', note: r.note } });
    return { ok: true };
  } catch (e) {
    if (!current()) return stale();
    item.status = 'failed';
    item.error = String(e.message || e);
    sendTab(tabId, { type: 'HW_STATUS', payload: { index, status: 'failed', error: item.error, requestId } });
    return { ok: false, error: item.error };
  }
}

let settingsNavigation = Promise.resolve();
function openSettings(section) {
  const next = settingsNavigation.then(async () => {
    const base = chrome.runtime.getURL('settings.html');
    const tabs = await chrome.tabs.query({ url: base + '*' });
    const existing = tabs[0];
    if (existing) {
      const url = new URL(existing.url || base);
      url.hash = section;
      await chrome.tabs.update(existing.id, { active: true, ...(url.href !== existing.url ? { url: url.href } : {}) });
      if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true });
    } else await chrome.tabs.create({ url: base + '#' + section });
  });
  settingsNavigation = next.catch(() => {});
  return next;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const type = msg?.type;
    const payload = msg?.payload || {};
    const tabId = sender?.tab?.id;
    try {
      if (type === 'HW_FONT_MAP') {
        const here = new URL(sender.url || 'about:blank');
        if (!/(^|\.)chaoxing\.com$/.test(here.hostname) || !Array.isArray(payload.hashes) ||
            payload.hashes.length > 65535 || payload.hashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))) throw new Error('无效的页面字体请求');
        fontIndex ||= fetch(chrome.runtime.getURL('content/homework/fonts/glyph-map.json')).then(async response => {
          if (!response.ok) throw new Error('本地字体索引缺失，请重新安装完整插件');
          return (await response.json()).map;
        });
        const index = await fontIndex;
        sendResponse({ ok: true, map: Object.fromEntries(payload.hashes.map(hash => [hash, index[hash] || null])) });
      } else if (type === 'HW_ISSUE_ADD') {
        const result = await recordIssue(payload, sender);
        sendResponse(result || { ok: true });
      } else if (type === 'HW_ISSUE_LIST') {
        await issueWrites;
        sendResponse({ ok: true, ...await readIssuePage(payload.offset, payload.limit) });
      } else if (type === 'HW_ISSUE_CLEAR') {
        const clear = issueWrites.then(clearIssueHistory);
        issueWrites = clear.catch(() => {});
        await clear;
        sendResponse({ ok: true });
      } else if (type === 'HW_DETECT_QUESTIONS') {
        sendResponse(await detectPage(payload, sender));
      } else if (type === 'GET_CONFIG') {
        sendResponse({ ok: true, config: await getConfig() });
      } else if (type === 'SET_CONFIG') {
        const next = deepMerge(await getConfig(), payload);
        await chrome.storage.local.set({ config: next });
        if (payload.watchRate != null) {
          const q = await loadQueue();
          if (q && q.tabId === tabId) {
            q.autoRate = next.watchRate === 'auto';
            q.rate = q.autoRate ? 2 : Number(next.watchRate) || 2;
            await saveQueue(q);
          }
        }
        if (typeof payload.watchMuted === 'boolean' && tabId != null) {
          await chrome.tabs.update(tabId, { muted: payload.watchMuted });
        }
        sendResponse({ ok: true, config: next });
      } else if (type === 'CHECK_UPDATE') {
        sendResponse(await checkUpdate(payload.force, payload.cacheOnly));
      } else if (type === 'HW_RUN_UPDATE') {
        sendResponse(await runUpdateViaHost());
      } else if (type === 'DIAG_UPDATE_HOST') {
        /* 安装完成自检：只 ping 宿主，不启动更新 */
        sendResponse(await diagUpdateHost());
      } else if (type === 'UPDATE_PAGE_READY') {
        sendResponse(await confirmUpdatePage(payload.transactionId, sender));
      } else if (type === 'OPEN_SETTINGS') {
        // 面板是 content script，没有 chrome.tabs 权限，由后台代开设置页
        const section = ['app', 'mem', 'watch', 'diag', 'upd'].includes(payload.section) ? payload.section : 'app';
        await openSettings(section);
        sendResponse({ ok: true });
      } else if (type === 'HW_START') {
        sendResponse(await startRun(payload.questions || [], tabId, sender.url || sender.tab?.url, payload.auto === true, payload.requestId));
      } else if (type === 'HW_FILLED') {
        const it = run?.items[payload.index];
        if (!it || it.status !== 'answered' || run.tabId !== tabId || (it.fillToken && payload.fillToken !== it.fillToken) || run.cancelled) return sendResponse({ ok: true });
        if (payload.ok) {
          it.status = 'filled';
          return sendResponse({ ok: true });
        }
        // 填写失败：立即暂停（用户要求不重试）
        it.status = 'failed';
        it.error = '填写失败：' + (payload.error || '页面未接受答案');
        if (run && !run.cancelled) {
          sendTab(run.tabId, { type: 'HW_STATUS', payload: { index: payload.index, status: 'failed', error: it.error, requestId: run.requestId } });
          if (!run.auto) pauseRun(run.tabId, '填写失败，队列已暂停：' + it.error);
        }
        sendResponse({ ok: true });
      } else if (type === 'HW_WATCH_ACCESS_REQUEST') {
        const here = new URL(sender.url || sender.tab?.url || 'about:blank');
        if (tabId == null || !/(^|\.)chaoxing\.com$/.test(here.hostname)) throw new Error('请在超星页面申请课程访问权限');
        try {
          // 直接承接刷新按钮的用户操作；不先等待扫描或其他异步任务，以保留授权手势。
          const granted = await chrome.permissions.request({ origins: ['https://*.chaoxing.com/*'] });
          sendResponse(granted ? { ok: true } : { ok: false, needsPermission: true, error: '未获得超星站点访问权限，无法读取课程；可再次点击「刷新课程」申请授权。' });
        } catch (e) {
          sendResponse({ ok: false, needsPermission: true, error: '无法完成超星授权，请在扩展的站点访问设置中允许超星站点后重试：' + String(e.message || e) });
        }
      } else if (type === 'HW_WATCH_COURSES') {
        const here = new URL(sender.url || sender.tab?.url || 'about:blank');
        if (tabId == null || !/(^|\.)chaoxing\.com$/.test(here.hostname)) throw new Error('只能读取当前超星页面的课程清单');
        if (!(await chrome.permissions.contains({ origins: ['https://*.chaoxing.com/*'] })))
          return sendResponse({ ok: false, needsPermission: true, error: '读取跨域课程框架需要超星站点访问权限，请点击「刷新课程」申请授权。' });
        // 个人中心把课程列表放在跨域 iframe 中；在各自隔离上下文读取 DOM，不请求站点接口。
        const readFrames = () => chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => globalThis.HW?.Watch?.courseLinks?.() || [] });
        let frames = await readFrames();
        if (payload.refresh && !frames.some(frame => frame.result?.length)) {
          // 扩展更新前已打开的内层页面可能没有读取器；仅查旧对象永远为空，需像 F5 一样补加载。
          await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content/course/watch.js'] });
          frames = await readFrames();
        }
        const courses = new Map();
        for (const frame of frames) for (const course of frame.result || []) {
          const old = courses.get(course.key);
          if (!old || (old.total == null && course.total != null)) courses.set(course.key, course);
        }
        sendResponse({ ok: true, courses: [...courses.values()] });
      } else if (type === 'HW_WATCH_START') {
        watchNavigationEpoch++;
        if (!(await ensureWatchHostAccess())) return sendResponse({ ok: false, error: WATCH_HOST_ACCESS_ERROR });
        /* 开始刷一门或几门课：courses 是内容脚本在列表页扫出来的，后台只负责排队与翻页 */
        const courses = (payload.courses || []).filter((c) => c && c.key && c.scUrl);
        if (!courses.length) return sendResponse({ ok: false, error: '没有选中课程' });
        /* targetRun = 每门课处理几节（设置页决定）；0/缺省 = 整门课程 */
        const targetRun = Math.max(0, Math.min(10, Math.floor(Number(payload.targetRun) || 0)));
        if (targetRun >= 1 && courses.some(c => !Number.isFinite(c.done) || !Number.isFinite(c.total) || c.total <= 0 || c.done / c.total >= .35))
          return sendResponse({ ok: false, error: `连续 ${targetRun} 节模式只接受进度已知且低于 35% 的课程` });
        const existing = await loadQueue();
        if (existing && existing.tabId !== tabId) {
          /* 浏览器重启后 tabId 必变：旧属主标签页还在才拒绝，不在了就收养，
             否则孤儿队列既接不上又挡住新队列，只能人工清 storage。 */
          const alive = existing.tabId != null && await chrome.tabs.get(existing.tabId).then(() => true, () => false);
          if (alive) return sendResponse({ ok: false, error: '另一课程窗口已有队列，请先在原窗口停止后再开始' });
        }
        watchQueue = {
          courses: courses.map((c) => ({ key: c.key, scUrl: c.scUrl, name: c.name || '',
            /* 记下列表页读到的进度：换到课程页后面板仍能估「这门还要多久」（用户 2026-10-23 要求） */
            ...(Number.isFinite(c.done) && Number.isFinite(c.total) ? { done: c.done, total: c.total } : {}),
            ...(Array.isArray(c.chapterIds) && c.chapterIds.length
              ? { chapterIds: [...new Set(c.chapterIds.map(String))].slice(0, 10) } : {}) })),
          index: 0,
          tabId: tabId ?? null,
          rate: Number(payload.rate) || 2,
          autoRate: !!payload.autoRate,
          ...(targetRun >= 1 ? { targetRun } : {}),
        };
        await saveQueue(watchQueue);
        const here = new URL(sender.url || sender.tab?.url || 'about:blank');
        const inPlace = /(^|\.)chaoxing\.com$/.test(here.hostname) &&
          /\/mycourse\/(studentstudy|studentcourse)$/.test(here.pathname) &&
          `${here.searchParams.get('courseId') || here.searchParams.get('courseid')}|${here.searchParams.get('clazzid')}` === courses[0].key;
        if (!inPlace) await watchGo(0);
        sendResponse({ ok: true, count: courses.length, inPlace });
      } else if (type === 'HW_WATCH_OPEN_CATALOG') {
        const q = await loadQueue();
        const course = q?.courses[q.index];
        const url = new URL(payload.url);
        if (!course || q.paused || q.tabId !== tabId || !/(^|\.)chaoxing\.com$/.test(url.hostname) || url.protocol !== 'https:' ||
            url.username || url.password || !/\/mycourse\/studentcourse$/.test(url.pathname) ||
            `${url.searchParams.get('courseid')}|${url.searchParams.get('clazzid')}` !== course.key) throw new Error('课程目录与当前队列不一致');
        // 沿用原生章节 iframe 的完整地址（含 stuenc），不自行拼接鉴权参数。
        await chrome.tabs.update(tabId, { url: url.href });
        sendResponse({ ok: true });
      } else if (type === 'HW_WATCH_REOPEN') {
        const q = await loadQueue(), course = q?.courses[q.index];
        if (!q || q.paused || q.tabId !== tabId || course?.key !== payload.key) throw new Error('不是当前运行队列的课程');
        if (!(await ensureWatchHostAccess())) return sendResponse({ ok: false, error: WATCH_HOST_ACCESS_ERROR });
        const current = await loadQueue();
        if (!current || current.paused || current.tabId !== tabId || current.courses[current.index]?.key !== payload.key) throw new Error('队列状态已变化，未重新打开课程');
        const url = new URL(current.courses[current.index].scUrl);
        if (url.protocol !== 'https:' || !/(^|\.)chaoxing\.com$/.test(url.hostname) || url.username || url.password ||
            `${url.searchParams.get('courseid') || url.searchParams.get('courseId')}|${url.searchParams.get('clazzid')}` !== course.key)
          throw new Error('队列课程地址无效，未重新打开');
        await chrome.tabs.update(tabId, { url: url.href });
        sendResponse({ ok: true });
      } else if (type === 'HW_WATCH_SURVEY') {
        const q = await loadQueue();
        if (!q || q.paused || q.tabId !== tabId || sender.frameId !== 0) return sendResponse({ ok: false });
        const result = await chrome.tabs.sendMessage(tabId, { type, payload: { start: !!payload.start, url: payload.url } }).catch(() => null);
        sendResponse(result || { ok: false });
      } else if (type === 'HW_WATCH_READ_DOC') {
        const q = await loadQueue();
        if (!q || q.paused || q.tabId !== tabId) return sendResponse({ ok: false });
        await chrome.tabs.sendMessage(tabId, { type: 'HW_WATCH_READ_DOC' }).catch(() => {});
        sendResponse({ ok: true });
      } else if (type === 'HW_WATCH_QUEUE_GET') {
        /* 只把队列发给属主标签页——否则用户随手开一个超星页面，
           那个页面也会来接力，把用户的浏览器抢去刷课（真机踩过：新开标签页直接被带去 5.3 播视频）。
           例外：讨论任务点开出来的 groupweb 话题页（bbs.js 要在里头回帖），
           凭 URL 识别，不算「别人的页面」。 */
        const q = await loadQueue();
        const helper = q?.topic?.tabId === tabId && q.topic.url === sender.url && (() => {
          try {
            const u = new URL(sender.url || '');
            return u.hostname === 'groupweb.chaoxing.com' && u.pathname.startsWith('/course/topic/');
          } catch { return false; }
        })();
        if (q && tabId != null && q.tabId != null && q.tabId !== tabId && !helper) {
          sendResponse({ ok: true, queue: null });
        } else {
          sendResponse({ ok: true, queue: q });
        }
      } else if (type === 'HW_WATCH_COURSE_DONE') {
        const q = await loadQueue();
        if (q && q.tabId === tabId && q.courses[q.index]?.key === payload.key && !q.paused) {
          if (Number(q.targetRun) >= 1) {
            const size = Math.max(1, Math.min(10, Number(q.targetRun) || 4));
            q.courses[q.index].outcome = {
              status: ['complete', 'complete_with_exceptions'].includes(payload.status) ? payload.status : 'incomplete',
              chapterIds: Array.isArray(payload.chapterIds) ? payload.chapterIds.slice(0, size) : [],
              exceptions: Array.isArray(payload.exceptions) ? payload.exceptions.slice(0, size) : [] };
            await saveQueue(q);
          }
          await watchGo(q.index + 1);
        }
        sendResponse({ ok: true });
      } else if (type === 'HW_WATCH_SCOPE_SET') {
        const q = await loadQueue();
        const course = q?.courses[q.index];
        const ids = payload.chapterIds;
        const size = Math.max(1, Math.min(10, Number(q?.targetRun) || 4));
        if (!q || !(Number(q.targetRun) >= 1) || q.tabId !== tabId || q.paused || course?.key !== payload.key ||
            !Array.isArray(ids) || ids.length !== size || ids.some(id => !/^\d+$/.test(String(id))))
          return sendResponse({ ok: false, error: '连续小节范围与当前队列不一致' });
        course.chapterIds = ids.map(String);
        course.attempted ||= [];
        if (!course.attempted.some(start => start === payload.start)) course.attempted.push(payload.start);
        await saveQueue(q);
        sendResponse({ ok: true });
      } else if (type === 'HW_WATCH_QUIZ_RETRY') {
        const claim = quizRetryClaims.then(async () => {
          const q = await loadQueue(), course = q?.courses[q.index];
          if (!q || q.paused || q.tabId !== tabId || course?.key !== payload.key || !/^\d+$/.test(String(payload.chapterId)) ||
              payload.quizId != null && !/^[\w:-]{1,160}$/.test(String(payload.quizId)))
            return { ok: false, error: '重做测验与当前刷课队列不一致' };
          course.quizRetries ||= [];
          const chapterId = String(payload.chapterId);
          const retryId = payload.quizId ? chapterId + ':' + payload.quizId : chapterId;
          if (course.quizRetries.includes(chapterId) || course.quizRetries.includes(retryId)) return { ok: true, first: false };
          course.quizRetries.push(retryId);
          await chrome.storage.local.set({ [WQ_KEY]: q });
          return { ok: true, first: true };
        });
        quizRetryClaims = claim.catch(() => {});
        sendResponse(await claim);
      } else if (type === 'HW_WATCH_RETRY_ONCE') {
        /* 每门课只补跑一次：跑完仍缺就如实记未达标，不在目录页和课程页之间来回拉锯。 */
        const q = await loadQueue();
        const course = q?.courses[q.index];
        if (!q || !(Number(q.targetRun) >= 1) || q.tabId !== tabId || q.paused || course?.key !== payload.key)
          return sendResponse({ ok: false, error: '队列与当前课程不一致' });
        if (course.retried) return sendResponse({ ok: true, first: false });
        course.retried = true;
        await saveQueue(q);
        sendResponse({ ok: true, first: true });
      } else if (type === 'HW_WATCH_FOUR_GAP') {
        const q = await loadQueue();
        const course = q?.courses[q.index];
        if (Number(q?.targetRun) >= 1 && q.tabId === tabId && course?.key === payload.key) {
          course.gaps ||= [];
          course.gaps.push({ chapterIds: course.chapterIds || [], sections: payload.sections || [] });
          await saveQueue(q);
        }
        sendResponse({ ok: true });
      } else if (type === 'HW_WATCH_FOREGROUND') {
        // 兼容未刷新页面的旧脚本：明确拒绝自动唤起，防止旧请求继续抢焦点。
        sendResponse({ ok: false, error: '已关闭自动切换前台，请手动打开课程窗口' });
      } else if (type === 'HW_WATCH_OPEN_TOPIC') {
        /* 讨论卡的话题页在 groupweb 域，由内容脚本 bbs.js 在那个标签页里回帖；
           这里只负责开一个不抢焦点的标签页，两分钟后兜底关闭（bbs.js 正常会自己关）。 */
        const q = await loadQueue();
        if (!q || q.paused || q.tabId !== tabId) return sendResponse({ ok: false, error: '不是运行中的队列属主页面' });
        let u;
        try { u = new URL(payload.url); } catch { return sendResponse({ ok: false, error: '话题地址不合法' }); }
        if (u.protocol !== 'https:' || !/(^|\.)chaoxing\.com$/.test(u.hostname)) return sendResponse({ ok: false, error: '话题地址不在超星域' });
        const topic = await chrome.tabs.create({ url: u.href, active: false });
        q.topic = { tabId: topic.id, url: u.href };
        await saveQueue(q);
        setTimeout(() => { chrome.tabs.remove(topic.id).catch(() => {}); }, 120000);
        sendResponse({ ok: true, tabId: topic.id });
      } else if (type === 'HW_BBS_REPLIED') {
        /* 话题页回帖成功（但没有 opener 可收 completeTopic 消息）——转发给学习页补发。 */
        const q = await loadQueue();
        if (q && !q.paused && q.topic?.tabId === tabId && q.topic.url === sender.url) {
          const topicUrl = new URL(q.topic.url);
          sendTab(q.tabId, { type: 'HW_BBS_NOTIFY', payload: {
            jobId: topicUrl.searchParams.get('jobid') || '',
            knowledgeId: topicUrl.searchParams.get('knowledgeid') || '' } });
          delete q.topic;
          await saveQueue(q);
        }
        sendResponse({ ok: true });
      } else if (type === 'HW_WATCH_PAUSE') {
        watchNavigationEpoch++;
        const q = await loadQueue();
        if (q && q.tabId === tabId) {
          q.paused = String(payload.reason || '请核对页面后继续').slice(0, 160);
          await saveQueue(q);
        }
        sendResponse({ ok: true });
      } else if (type === 'HW_WATCH_RESUME') {
        if (!(await ensureWatchHostAccess())) return sendResponse({ ok: false, error: WATCH_HOST_ACCESS_ERROR });
        const q = await loadQueue();
        if (!q || q.tabId !== tabId) return sendResponse({ ok: false, error: '当前页面没有可接续的队列' });
        delete q.paused;
        await saveQueue(q);
        sendResponse({ ok: true });
      } else if (type === 'HW_WATCH_STOP') {
        watchNavigationEpoch++;
        const q = await loadQueue();
        await saveQueue(null);
        if (q) sendTab(q.tabId, { type: 'HW_WATCH_FINISHED', payload: { cancelled: true, reason: '用户取消刷课队列' } });
        sendResponse({ ok: true });
      } else if (type === 'KEY_SAVE') {
        // 保存 Key 并记住：自动探测接口类型（并行尝试已知接口）→ 去重入库 → 设为当前使用
        const key = sanitizeKey(payload.key || '');
        if (!key) return sendResponse({ ok: false, error: 'Key 清理后为空' });
        let detected;
        try {
          detected = await detectEndpoint(key, payload.iface === 'auto' ? undefined : payload.iface);
        } catch (e) {
          return sendResponse({ ok: false, error: '接口自动识别失败：' + String(e.message || e).slice(0, 100) });
        }
        const o = await chrome.storage.local.get('savedKeys');
        let list = (o.savedKeys || []).filter((r) => r.key !== key);
        list.unshift({ id: 'k' + Date.now(), key, iface: detected.iface, baseURL: detected.baseURL, model: detected.model, savedAt: Date.now() });
        list = list.slice(0, 10);
        const next = deepMerge(await getConfig(), { api: { apiKey: key, iface: detected.iface, baseURL: detected.baseURL, model: detected.model } });
        await chrome.storage.local.set({ savedKeys: list, config: next });
        sendResponse({ ok: true, list, detected: { iface: detected.iface, baseURL: detected.baseURL, model: detected.model } });
      } else if (type === 'KEY_LIST') {
        const o = await chrome.storage.local.get('savedKeys');
        sendResponse({ ok: true, list: o.savedKeys || [] });
      } else if (type === 'KEY_USE') {
        const o = await chrome.storage.local.get('savedKeys');
        const rec = (o.savedKeys || []).find((r) => r.id === payload.id);
        if (!rec) return sendResponse({ ok: false, error: '该记录已被删除' });
        const next = deepMerge(await getConfig(), { api: { apiKey: rec.key, iface: rec.iface || 'openai', baseURL: rec.baseURL, model: rec.model } });
        await chrome.storage.local.set({ config: next });
        sendResponse({ ok: true });
      } else if (type === 'KEY_REMOVE') {
        const o = await chrome.storage.local.get(['savedKeys']);
        const list = (o.savedKeys || []).filter((r) => r.id !== payload.id);
        await chrome.storage.local.set({ savedKeys: list });
        const cfg = await getConfig();
        if (payload.key && cfg.api?.apiKey === payload.key) {
          // 删除的是正在使用的 Key：一并停用
          await chrome.storage.local.set({ config: deepMerge(cfg, { api: { apiKey: '' } }) });
        }
        sendResponse({ ok: true, list });
      } else if (type === 'HW_STOP') {
        if (run?.tabId === tabId) run.cancelled = true;
        const detection = detectingTabs.get(tabId);
        if (detection) detection.cancelled = true;
        sendResponse({ ok: true });
      } else if (type === 'HW_RERUN') {
        sendResponse(await rerunOne(payload.index, tabId, payload.requestId));
      } else if (type === 'TEST_API') {
        sendResponse({ ok: true, reply: await testAPI(payload.api) });
      } else if (type === 'CACHE_CLEAR') {
        // 清除答题记忆（AI 历史答案缓存，c: 前缀键）；dryRun 只计数不删除。
        // 不触碰：config（引擎/Key/提示标志）、savedKeys、apiEndpoint、面板位置。
        const all = await chrome.storage.local.get(null);
        // c:upd 是更新检查缓存（非答题记忆），不计入条数也不删
        const keys = Object.keys(all).filter((k) => k.startsWith('c:') && k !== 'c:upd');
        if (!payload.dryRun && keys.length) await chrome.storage.local.remove(keys);
        sendResponse({ ok: true, count: keys.length });
      } else {
        sendResponse({ ok: false, error: 'unknown type: ' + type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true;
});

/* 新装／更新时，已打开的页面不会自动重放声明式内容脚本，补上悬浮入口。 */
const pendingPanelTabs = new Set();
const panelInjections = new Map();
async function injectOpenHomeworkTabs(loadedTab) {
  const script = chrome.runtime.getManifest().content_scripts?.find(s => s.matches.includes('*://*.chaoxing.com/*'));
  if (!script) return;
  const tabs = loadedTab ? [loadedTab] : await chrome.tabs.query({ url: script.matches });
  for (const tab of tabs) {
    if (tab.id == null || !/^https?:\/\/(?:[a-z0-9-]+\.)*chaoxing\.com\//i.test(tab.url || '')) continue;
    if (tab.status === 'loading') { pendingPanelTabs.add(tab.id); continue; }
    if (!panelInjections.has(tab.id)) {
      const task = (async () => {
        try {
          if (!(await chrome.permissions.contains({ origins: [new URL(tab.url).origin + '/*'] }))) throw new Error(WATCH_HOST_ACCESS_ERROR);
          const [{ result: ready } = {}] = await chrome.scripting.executeScript({ target: { tabId: tab.id },
            func: () => !!globalThis.HW?.Panel && !!document.getElementById('hw-panel-host') });
          if (!ready) await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: script.js });
        } catch (e) {
          const raw = String(e.message || e);
          const message = /Cannot access|permission to access/i.test(raw)
            ? '面板加载被浏览器拒绝：请检查扩展的超星站点访问权限，允许访问后刷新页面（F5）' : raw;
          await recordIssue({ stage: '加载面板', message, details: raw, url: tab.url }).catch(() => {});
        }
      })();
      panelInjections.set(tab.id, task);
    }
    try { await panelInjections.get(tab.id); }
    finally { panelInjections.delete(tab.id); }
  }
}
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && pendingPanelTabs.delete(tabId)) return injectOpenHomeworkTabs({ ...tab, id: tabId }).catch(() => {});
});
chrome.runtime.onInstalled?.addListener(() => injectOpenHomeworkTabs().catch(() => {}));
chrome.runtime.onStartup?.addListener(() => injectOpenHomeworkTabs().catch(() => {}));

/* 保存当前版本供其他诊断使用；更新成功提示由设置页等到事务健康确认后显示。 */
(async () => {
  const cur = chrome.runtime.getManifest().version;
  await chrome.storage.local.set({ v: cur });
  await ensureWatchHostAccess();
  const q = await loadQueue();
  if (q?.tabId != null) await pauseWatchForInterruptedPage(await chrome.tabs.get(q.tabId).catch(() => null));
})();

openUpdateHealthPage();
setInterval(openUpdateHealthPage, 1500);

/* —— 热重载：tools/watch.mjs 检测到文件变化会更新 hot-reload.json 时间戳，这里轮询到变化即自动重载 —— */
let lastStamp = null;
async function pollHotReload() {
  try {
    await chrome.storage.local.get('__keepalive'); // 扩展 API 调用，顺带维持 SW 存活
    const res = await fetch(chrome.runtime.getURL('hot-reload.json') + '?t=' + Date.now());
    const j = await res.json();
    if (lastStamp !== null && j.t !== lastStamp) chrome.runtime.reload();
    lastStamp = j.t;
  } catch {
    /* hot-reload.json 不存在或不可读时忽略 */
  }
}
pollHotReload();
setInterval(pollHotReload, 2000);
