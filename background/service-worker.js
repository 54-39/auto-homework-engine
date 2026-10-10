/* 后台 Service Worker：引擎路由、题目队列、答案缓存、与作业页消息中转、热重载、自动更新检查 */
import { answerWithAPI, testAPI, sanitizeKey, detectEndpoint } from './engines/api-engine.js';
import { answerWithBridge } from './engines/bridge-engine.js';
import { hashKey, compareVersions, isMajorUpdate } from './engines/engine.js';

const DEFAULT_CONFIG = {
  engine: 'api', // api | bridge
  mode: 'semi', // semi 只填写不提交 | auto 填完自动提交
  api: { iface: 'auto', baseURL: '', model: '', apiKey: '' },
  bridge: { newChat: true, delayMin: 3000, delayMax: 8000 },
  subjMode: 'ask', // 简答题策略：ask=每次弹窗询问 | keep=保留跳过 | rewrite=清空重写
};

let run = null; // { tabId, cancelled, fails, items: [{ q, status, answer, error }] }

/* 暂停当前队列（风控/多次失败共用），发通知 + 面板红字 */
function pauseRun(tabId, reason) {
  if (run) run.cancelled = true;
  notify('已暂停：' + reason.slice(0, 90));
  return sendTab(tabId, { type: 'HW_DONE', payload: { paused: reason } });
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
const RISKY_RE = /风控|验证|未就绪|登录墙|未发出/;
const AUTH_RE = /HTTP 40[13]|authentication|invalid[_ ]?api[_ ]?key|认证|鉴权/i;
let lastNotifyAt = 0;
function notify(message) {
  const now = Date.now();
  if (now - lastNotifyAt < 5000) return; // 5 秒内不重复轰炸
  lastNotifyAt = now;
  try {
    chrome.notifications.create(
      { type: 'basic', iconUrl: 'icons/icon128.png', title: '作业助手', message },
      () => void chrome.runtime.lastError,
    );
  } catch {
    /* 通知权限异常时静默 */
  }
}
chrome.notifications?.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: '*://*.doubao.com/*' });
  if (!tabs.length) return;
  await chrome.tabs.update(tabs[0].id, { active: true });
  try {
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } catch {
    /* 窗口可能已关闭 */
  }
});

/* —— 更新检查：拉取仓库 manifest 版本号与本地比较；结果缓存 1 小时（c: 前缀键）——
   更新源优先 jsDelivr CDN 镜像（大陆网络可直达），失败再回退 GitHub raw（海外保底）；每个源只试一次、不重试；
   自动检查只发生在设置页「检测更新」分区；面板用 cacheOnly 只读上次结果、不联网（只提示功能更新）；
   失败静默返回 ok:false；force=true 绕过缓存（设置页「立即检查」）；任何情况下都不自动安装、不阻断使用 */
const UPDATE_SOURCES = [
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
      latest = String((await res.json()).version || '');
      if (latest) break;
    } catch (e) {
      lastErr = String(e.message || e); // 两个源都失败时返回最后一个源的错误
    }
  }
  if (!latest) return { ok: false, error: lastErr || '更新源未返回版本号' };
  await chrome.storage.local.set({ 'c:upd': { latest, at: Date.now() } });
  return updResult(current, latest, false);
}

async function askEngine(cfg, q) {
  if (cfg.engine === 'bridge') return answerWithBridge(q, cfg.bridge);
  return answerWithAPI(q, cfg.api);
}

function cacheKeyOf(q) {
  return hashKey(JSON.stringify({ t: q.type, s: q.stem, o: (q.options || []).map((x) => x.text) }));
}
async function cached(key) {
  const o = await chrome.storage.local.get('c:' + key);
  return o['c:' + key] || null;
}
function cacheSet(key, val) {
  return chrome.storage.local.set({ ['c:' + key]: val });
}

async function startRun(questions, tabId) {
  const cfg = await getConfig();
  if (run) run.cancelled = true;
  run = { tabId, cancelled: false, items: questions.map((q) => ({ q, status: 'queued', answer: null, error: null })) };
  (async () => {
    for (let i = 0; i < run.items.length; i++) {
      if (run.cancelled) return sendTab(tabId, { type: 'HW_STOPPED' });
      const item = run.items[i];
      // 面板逐题决策：skip=已写且正确（跳过） / rewrite=写错（用参考答案改写） / ask=问引擎
      if (item.q._decision === 'skip') {
        item.status = 'skipped';
        const sn = item.q._skipNote || `已写且正确（页面: ${item.q._pageAnswer || '空'}），跳过`;
        sendTab(tabId, { type: 'HW_STATUS', payload: { index: i, status: 'skipped', note: sn } });
        continue;
      }
      if (item.q._decision === 'rewrite') {
        item.status = 'answered';
        item.answer = { answer: item.q._refAnswer, note: '改写' };
        sendTab(tabId, { type: 'HW_ANSWER', payload: { index: i, answer: item.q._refAnswer, kind: 'rewrite', note: `写错了已改写（页面原答案: ${item.q._pageAnswer || '空'}）` } });
        continue;
      }
      item.status = 'asking';
      sendTab(tabId, { type: 'HW_STATUS', payload: { index: i, status: 'asking' } });
      try {
        const key = await cacheKeyOf(item.q);
        let ans = await cached(key);
        const fromCache = !!ans;
        if (!ans) {
          const r = await askEngine(cfg, item.q);
          ans = { answer: r.answer, note: r.note || null };
          await cacheSet(key, ans);
        }
        item.status = 'answered';
        item.answer = ans;
        sendTab(tabId, { type: 'HW_ANSWER', payload: { index: i, answer: ans.answer, fromCache, note: ans.note } });
        run.fails = 0;
      } catch (e) {
        run.fails++;
        item.status = 'failed';
        item.error = String(e.message || e);
        sendTab(tabId, { type: 'HW_STATUS', payload: { index: i, status: 'failed', error: item.error } });
        // 风控/验证类错误：第一次就暂停队列，不去撞验证码
        if (RISKY_RE.test(item.error)) {
          return pauseRun(tabId, '豆包需要人工确认，队列已暂停：' + item.error);
        }
        // 鉴权失败：Key 无效/不匹配，继续跑只会全部失败，立即暂停
        if (AUTH_RE.test(item.error)) {
          return pauseRun(tabId, 'API 鉴权失败（Key 无效或与接口地址不匹配）。包月套餐（如火山 Coding Plan）必须选对应供应商预设、用 /api/coding 专用地址：' + item.error.slice(0, 110));
        }
        // 任何失败立即暂停（用户要求：不重试不硬扛）
        return pauseRun(tabId, item.error.slice(0, 140));
      }
      if (cfg.engine === 'bridge') {
        // 模拟人工节奏：每题之间随机延迟，降低风控风险
        const { delayMin = 3000, delayMax = 8000 } = cfg.bridge || {};
        const wait = delayMin + Math.random() * Math.max(0, delayMax - delayMin);
        await new Promise((r) => setTimeout(r, wait));
      } else {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    const filled = run.items.filter((it) => it.status === 'filled').length;
    const failed = run.items.filter((it) => it.status === 'failed').length;
    const skipped = run.items.filter((it) => it.status === 'skipped').length;
    const conflict = run.items.filter((it) => it.status === 'conflict').length;
    notify(failed ? `答题完成：填写 ${filled}、跳过 ${skipped}、冲突 ${conflict}、失败 ${failed} 题` : `处理完成：填写 ${filled}、跳过 ${skipped}${conflict ? '、冲突 ' + conflict : ''}，请检查后手动提交`);
    sendTab(tabId, { type: 'HW_DONE', payload: { total: run.items.length, filled, failed, skipped, conflict } });
  })();
  return { ok: true, count: questions.length, engine: cfg.engine };
}

async function rerunOne(index, tabId) {
  const cfg = await getConfig();
  const item = run?.items[index];
  if (!item) return { ok: false, error: '题目不存在，请重新检测' };
  item.status = 'asking';
  item.error = null;
  sendTab(tabId, { type: 'HW_STATUS', payload: { index, status: 'asking' } });
  try {
    const r = await askEngine(cfg, item.q);
    item.status = 'answered';
    item.answer = r.answer;
    // 手动重答视为最新权威答案：覆盖旧缓存（包括之前的错误答案）
    if (r.answer) {
      const key = await cacheKeyOf(item.q);
      await cacheSet(key, { answer: r.answer, note: r.note || null });
    }
    sendTab(tabId, { type: 'HW_ANSWER', payload: { index, answer: r.answer, kind: 'rewrite', note: r.note } });
    return { ok: true };
  } catch (e) {
    item.status = 'failed';
    item.error = String(e.message || e);
    sendTab(tabId, { type: 'HW_STATUS', payload: { index, status: 'failed', error: item.error } });
    return { ok: false, error: item.error };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const type = msg?.type;
    const payload = msg?.payload || {};
    const tabId = sender?.tab?.id;
    try {
      if (type === 'GET_CONFIG') {
        sendResponse({ ok: true, config: await getConfig() });
      } else if (type === 'SET_CONFIG') {
        const next = deepMerge(await getConfig(), payload);
        await chrome.storage.local.set({ config: next });
        sendResponse({ ok: true, config: next });
      } else if (type === 'CHECK_UPDATE') {
        sendResponse(await checkUpdate(payload.force, payload.cacheOnly));
      } else if (type === 'OPEN_SETTINGS') {
        // 面板是 content script，没有 chrome.tabs 权限，由后台代开设置页
        await chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
        sendResponse({ ok: true });
      } else if (type === 'HW_START') {
        sendResponse(await startRun(payload.questions || [], tabId));
      } else if (type === 'HW_FILLED') {
        const it = run?.items[payload.index];
        if (!it) return sendResponse({ ok: true });
        if (payload.ok) {
          it.status = 'filled';
          if (run) run.fails = 0;
          return sendResponse({ ok: true });
        }
        // 填写失败：立即暂停（用户要求不重试）
        it.status = 'failed';
        it.error = '填写失败：' + (payload.error || '页面未接受答案');
        if (run && !run.cancelled) {
          sendTab(run.tabId, { type: 'HW_STATUS', payload: { index: payload.index, status: 'failed', error: it.error } });
          pauseRun(run.tabId, '填写失败，队列已暂停：' + it.error);
        }
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
        if (run) run.cancelled = true;
        sendResponse({ ok: true });
      } else if (type === 'HW_RERUN') {
        sendResponse(await rerunOne(payload.index, tabId));
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
