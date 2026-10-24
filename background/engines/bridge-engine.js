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

async function askOnce(prompt, cfg) {
  const target = await ensureBridge();
  const ready = await pingReady(target);
  if (!ready.ok) {
    const info = ready.info || {};
    const bits = [`地址 ${info.url || DOUBAO_URL}`];
    bits.push(`输入框${info.hasEditor ? '有' : '无'}`);
    bits.push(`发送按钮${info.hasSend ? '有' : '无'}`);
    throw new Error(`豆包页面未就绪（${bits.join('、')}）：点击暂停通知打开豆包，完成登录或验证后回插件继续`);
  }
  const send = target.send({
    type: 'BRIDGE_ASK',
    payload: { prompt, newChat: cfg?.newChat !== false },
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

export async function requestWithBridge(messages, cfg) {
  if (busy) throw new Error('豆包正在处理上一条请求，请等待完成后重试');
  busy = true;
  const prompt = messages.map((m) => m.content).join('\n\n');
  try {
    return await askOnce(prompt, cfg);
  } finally {
    busy = false;
  }
}

export async function answerWithBridge(q, cfg) {
  const result = await requestWithBridge(buildMessages(q), cfg);
  return { answer: parseAnswer(q, result.raw) };
}
