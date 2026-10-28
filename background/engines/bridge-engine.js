/* 豆包网页桥接引擎：自动打开/复用豆包标签页，把题目转发给页内桥接脚本，
   拿回回答文本后经 parseAnswer 归一化。使用豆包网页聊天额度，耗时取决于网页生成。 */
import { buildMessages, parseAnswer } from './engine.js';

const DOUBAO_URL = 'https://www.doubao.com/chat/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let preferredTabId = null;

export async function openBridgeSplit(sourceTabId) {
  if (typeof chrome.tabs.createSplit !== 'function') {
    throw new Error('当前浏览器不支持一键分屏，请用 Edge 工具栏的分屏按钮选择豆包页面');
  }
  const source = await chrome.tabs.get(sourceTabId);
  const tabs = await chrome.tabs.query({ url: '*://*.doubao.com/*' });
  const paired = tabs.find(t => source.splitViewId >= 0 && t.splitViewId === source.splitViewId);
  if (paired) {
    preferredTabId = paired.id;
    await chrome.tabs.update(source.id, { active: true });
    return { tabId: paired.id, reused: true };
  }
  if (source.splitViewId >= 0) throw new Error('当前页面已与其他网页分屏，请先退出该分屏，或在分屏中手动选择豆包');
  let target = tabs.find(t => t.windowId === source.windowId && !(t.splitViewId >= 0))
    || tabs.find(t => !(t.splitViewId >= 0))
    || await chrome.tabs.create({ url: DOUBAO_URL, windowId: source.windowId, index: source.index + 1, active: false, pinned: source.pinned });
  if (target.pinned !== source.pinned) await chrome.tabs.update(target.id, { pinned: source.pinned });
  if (target.windowId !== source.windowId) await chrome.tabs.move(target.id, { windowId: source.windowId, index: source.index + 1 });
  target = await chrome.tabs.get(target.id);
  if (source.groupId >= 0 && target.groupId !== source.groupId) await chrome.tabs.group({ tabIds: target.id, groupId: source.groupId });
  else if (!(source.groupId >= 0) && target.groupId >= 0) await chrome.tabs.ungroup(target.id);
  target = await chrome.tabs.get(target.id);
  const current = await chrome.tabs.get(source.id);
  const index = current.index + (target.windowId === current.windowId && target.index < current.index ? 0 : 1);
  await chrome.tabs.move(target.id, { windowId: current.windowId, index });
  await chrome.tabs.createSplit([source.id, target.id]);
  preferredTabId = target.id;
  await chrome.tabs.update(source.id, { active: true });
  return { tabId: target.id, reused: tabs.some(t => t.id === target.id) };
}

export async function openBridgeView(sourceTabId, cfg) {
  tidyDone = false; // 每轮开始重新允许一次「收侧栏」
  if (cfg?.viewMode !== 'window' && typeof chrome.tabs.createSplit === 'function') {
    return { ...await openBridgeSplit(sourceTabId), mode: 'split' };
  }
  const source = await chrome.tabs.get(sourceTabId);
  const tabs = await chrome.tabs.query({ url: '*://*.doubao.com/*' });
  const paired = tabs.find(t => source.splitViewId >= 0 && t.splitViewId === source.splitViewId);
  if (paired) {
    if (typeof chrome.tabs.unsplit !== 'function') throw new Error('请先退出当前豆包分屏，再开始使用新窗口模式');
    await chrome.tabs.unsplit(source.splitViewId);
  }
  const target = paired || tabs.find(t => t.id === preferredTabId && !(t.splitViewId >= 0))
    || tabs.find(t => !(t.splitViewId >= 0));
  let window;
  if (target && target.windowId !== source.windowId) {
    const existing = await chrome.windows.get(target.windowId, { populate: true });
    if (existing.tabs?.length === 1) window = existing;
  }
  window ||= await chrome.windows.create(target
    ? { tabId: target.id, type: 'normal', focused: false }
    : { url: DOUBAO_URL, type: 'normal', focused: false });
  preferredTabId = target?.id ?? window.tabs[0].id;
  return { tabId: preferredTabId, reused: !!target, mode: 'window' };
}

async function ensureBridge() {
  const tabs = await chrome.tabs.query({ url: '*://*.doubao.com/*' });
  const tab = tabs.find(t => t.id === preferredTabId) || tabs[0] || await chrome.tabs.create({ url: DOUBAO_URL, active: false });
  return { tabId: tab.id, send: message => chrome.tabs.sendMessage(tab.id, message, { frameId: 0 }) };
}

/* 探活桥接脚本；没注入（如扩展重载前的旧页面）就用 scripting API 补注入。
   返回 { ok, info }，info 带页面诊断（地址/有无输入框/发送按钮）便于定位问题。 */
async function pingReady(target) {
  let last = null;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await target.send({ type: 'BRIDGE_PING' });
      last = r;
      if (r?.attention) return { ok: false, info: r };
      if (r?.ok && r.ready) return { ok: true, info: r };
    } catch {
      last = { ok: false };
    }
    if (target.tabId != null && (i === 0 || i === 8 || i === 20)) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: target.tabId, frameIds: [0] }, files: ['content/doubao/doubao-bridge.js'] });
      } catch {
        /* 页面尚不可注入（加载中）时忽略 */
      }
    }
    await sleep(1000);
  }
  return { ok: false, info: last };
}

let busy = false;
/* 每轮开始后只收一次豆包侧栏：用户之后自己展开就不再去点，避免和人工操作抢。 */
let tidyDone = false;

/* 在豆包页面里执行：点它自己的「收起侧栏」按钮。
   必须自包含（会被序列化后注入），不引用外部变量。选择器来自 2026-10-28 实测：
   展开时 aria-label="收起侧栏"，收起后变成「显示侧栏」。找不到就返回 not-found。 */
function tidySidebarInPage() {
  const squash = (s) => (s || '').replace(/\s+/g, '');
  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  };
  const label = (el) => squash(el.getAttribute('aria-label') || el.getAttribute('title') || '');
  /* 豆包把一部分浮层挂在 shadow root 里，document.querySelectorAll 照不到；
     先把 document 扫一遍，找不到再补扫开放的 shadow root（不穿透 iframe）。 */
  const collect = () => {
    const out = [...document.querySelectorAll('button,[role="button"]')];
    if (out.some((el) => /^(收起侧栏|收起侧边栏|收起导航栏)$/.test(label(el)))) return out;
    const roots = [];
    for (const el of document.querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
    for (const root of roots) out.push(...root.querySelectorAll('button,[role="button"]'));
    return out;
  };
  const buttons = collect()
    .filter((el) => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
  const collapse = buttons.find((el) => /^(收起侧栏|收起侧边栏|收起导航栏)$/.test(label(el)));
  if (!collapse) {
    return buttons.some((el) => /^(显示侧栏|展开侧栏|展开侧边栏)$/.test(label(el))) ? 'already' : 'not-found';
  }
  collapse.click();
  return 'clicked';
}

/* 收侧栏一律走 scripting 一次性注入，不走页面里的消息：扩展重载后，已打开标签页里的
   旧内容脚本不会更新，靠消息会让这个功能在重载后的第一轮整个哑掉（2026-10-28 实测）。 */
async function collapseDoubaoSidebar(tabId) {
  if (tabId == null) return 'failed';
  for (let i = 0; i < 3; i++) {
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: tidySidebarInPage });
      if (r?.result === 'clicked' || r?.result === 'already') return r.result;
    } catch {
      /* 页面还在加载或不允许注入：稍后再试 */
    }
    await sleep(600);
  }
  return 'failed';
}

async function askOnce(prompt) {
  const target = await ensureBridge();
  const ready = await pingReady(target);
  if (!ready.ok) {
    const info = ready.info || {};
    if (info.attention) throw new Error(info.error);
    const bits = [`地址 ${info.url || DOUBAO_URL}`];
    bits.push(`输入框${info.hasEditor ? '有' : '无'}`);
    bits.push(`发送按钮${info.hasSend ? '有' : '无'}`);
    throw new Error(`豆包页面未就绪（${bits.join('、')}）：请检查页面是否加载完成后重试`);
  }
  try { await chrome.notifications?.clear('hw-doubao-attention'); } catch { /* 通知可能已关闭 */ }
  /* 页面已就绪（输入框可找到）再收侧栏：此时布局已成型，点一下就能收；
     侧栏挡不住作业页也不报错，纯优化。 */
  if (!tidyDone) {
    tidyDone = true;
    await collapseDoubaoSidebar(target.tabId);
  }
  const send = target.send({
    type: 'BRIDGE_ASK',
    payload: { prompt, newChat: false },
  });
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('豆包回答超时（150 秒）')), 150000);
  });
  let res;
  try {
    res = await Promise.race([send, timeout]);
  } finally {
    clearTimeout(timer);
    send.catch(() => {}); // 超时后迟到的响应不再触发未处理拒绝
  }
  if (!res?.ok) throw new Error(res?.error || '豆包桥接失败');
  return { raw: res.text };
}

export async function requestWithBridge(messages) {
  if (busy) throw new Error('豆包正在处理上一条请求，请等待完成后重试');
  busy = true;
  const prompt = messages.map((m) => m.content).join('\n\n');
  try {
    return await askOnce(prompt);
  } finally {
    busy = false;
  }
}

export async function answerWithBridge(q) {
  const messages = buildMessages(q);
  const result = await requestWithBridge(messages);
  try {
    const answer = parseAnswer(q, result.raw);
    if (!answer && q.type !== 'subjective') throw new Error('AI 未返回可用答案');
    return { answer };
  } catch (error) {
    if (!['choice', 'multi', 'judge', 'blank'].includes(q.type)) throw error;
    // 仅在已收到但无法采用的答案后复核一次；登录、验证和会话切换错误不走这里。
    const review = await requestWithBridge([...buildMessages(q, { bestEffort: true }), { role: 'user', content:
      '这是同一道题的唯一一次复核，上次的空答案不能照抄。请重新列式计算，把候选选项逐项代入验证；检查单位、题目精度、选项有效数字和合理近似。对于选择、判断题，必须从题面现有选项中给出最可能的有效答案，不要再次输出空数组。即使没有精确匹配，也选择最接近且有题意依据的一项；不要编造选项。只输出原要求的 JSON 和选项完整文字。' }]);
    try {
      const answer = parseAnswer(q, review.raw);
      if (!answer) throw new Error('AI 未返回可用答案');
      return { answer };
    } catch (error) {
      error.code = 'HW_ANSWER_UNAVAILABLE';
      error.answerPreview = String(review.raw || '').slice(0, 12000);
      error.message += '（已自动复核一次）';
      throw error;
    }
  }
}
