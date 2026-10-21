/* 豆包网页桥接引擎：自动打开/复用豆包标签页，把题目转发给页内桥接脚本，
   拿回回答文本后经 parseAnswer 归一化。免费（用豆包网页聊天额度），约 10~40 秒/题。 */
import { buildMessages, parseAnswer } from './engine.js';

const DOUBAO_URL = 'https://www.doubao.com/chat/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 找已有豆包标签页；没有就自动新开一个（后台标签，不抢焦点），等它加载完成 */
async function ensureDoubaoTab() {
  const tabs = await chrome.tabs.query({ url: '*://*.doubao.com/*' });
  if (tabs.length) return tabs[0].id;
  const tab = await chrome.tabs.create({ url: DOUBAO_URL, active: false });
  for (let i = 0; i < 60; i++) {
    const t = await chrome.tabs.get(tab.id).catch(() => null);
    if (t?.status === 'complete') break;
    await sleep(500);
  }
  await sleep(1500); // 等前端渲染出输入框
  return tab.id;
}

/* 探活桥接脚本；没注入（如扩展重载前的旧页面）就用 scripting API 补注入。
   返回 { ok, info }，info 带页面诊断（地址/有无输入框/发送按钮）便于定位问题。 */
async function pingReady(tabId) {
  let last = null;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'BRIDGE_PING' });
      last = r;
      if (r?.ok && r.ready) return { ok: true, info: r };
    } catch {
      last = { ok: false };
    }
    if (i === 0 || i === 8 || i === 20) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content/doubao/doubao-bridge.js'] });
      } catch {
        /* 页面尚不可注入（加载中）时忽略 */
      }
    }
    await sleep(1000);
  }
  return { ok: false, info: last };
}

/* 后台标签页里 execCommand 偶尔因无焦点失效：首次失败时激活豆包标签页并重试一次（自愈） */
let activatedOnce = false;
let busy = false;

async function askOnce(prompt, cfg) {
  const tabId = await ensureDoubaoTab();
  const ready = await pingReady(tabId);
  if (!ready.ok) {
    const info = ready.info || {};
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const bits = [`地址 ${info.url || tab?.url || '未知'}`];
    bits.push(`输入框${info.hasEditor ? '有' : '无'}`);
    bits.push(`发送按钮${info.hasSend ? '有' : '无'}`);
    throw new Error(`豆包页面未就绪（${bits.join('、')}）：请切到豆包标签页确认能看到输入框（可能需要登录或在豆包页通过一次验证）`);
  }
  const send = chrome.tabs.sendMessage(tabId, {
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
  } catch (e) {
    const msg = String(e.message || e);
    if (!activatedOnce && /未发出|发送按钮|编辑器|输入框/.test(msg)) {
      activatedOnce = true;
      try {
        const tabs = await chrome.tabs.query({ url: '*://*.doubao.com/*' });
        if (tabs.length) await chrome.tabs.update(tabs[0].id, { active: true });
      } catch {
        /* 标签页可能已被关闭 */
      }
      return await askOnce(prompt, cfg);
    }
    throw e;
  } finally {
    busy = false;
  }
}

export async function answerWithBridge(q, cfg) {
  const result = await requestWithBridge(buildMessages(q), cfg);
  return { answer: parseAnswer(q, result.raw) };
}
