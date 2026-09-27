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

/* 探活桥接脚本；没注入（如扩展重载前的旧页面）就用 scripting API 补注入 */
async function pingReady(tabId) {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'BRIDGE_PING' });
      if (r?.ok) return true;
    } catch {
      if (i === 0 || i === 8) {
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['content/doubao/doubao-bridge.js'] });
        } catch {
          /* 页面尚不可注入（加载中）时忽略 */
        }
      }
    }
    await sleep(1000);
  }
  return false;
}

function flattenPrompt(q) {
  const [sys, user] = buildMessages(q);
  return `${sys.content}\n\n${user.content}`;
}

/* 后台标签页里 execCommand 偶尔因无焦点失效：首次失败时激活豆包标签页并重试一次（自愈） */
let activatedOnce = false;

async function askOnce(q, cfg) {
  const tabId = await ensureDoubaoTab();
  const ready = await pingReady(tabId);
  if (!ready) {
    throw new Error('豆包页面未就绪：请切到豆包标签页确认能正常显示输入框（如遇登录墙/验证请手动通过一次）');
  }
  let send = chrome.tabs
    .sendMessage(tabId, { type: 'BRIDGE_ASK', payload: { prompt: flattenPrompt(q), newChat: cfg?.newChat !== false } })
    .then((r) => r);
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
  return { answer: parseAnswer(q, res.text) };
}

export async function answerWithBridge(q, cfg) {
  try {
    return await askOnce(q, cfg);
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
      return askOnce(q, cfg);
    }
    throw e;
  }
}
