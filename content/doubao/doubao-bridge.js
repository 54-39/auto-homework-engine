/* 豆包页面桥接：由后台 service-worker 调度，在本页面自动完成"提问 → 等回答 → 回传"。
   DOM 契约（2026-09 在 www.doubao.com 实测验证）：
   - 输入区容器 [data-testid="chat_input_input"]，真实编辑器是 .ProseMirror (TipTap, contenteditable)
   - 初始状态页面上同时有 textarea 和 ProseMirror，合成输入只对 ProseMirror 生效（execCommand insertText）
   - 发送按钮 button[data-testid="chat_input_send_button"]（disabled 随输入状态变化）
   - 用户消息 [data-testid="send_message"] / AI 回答 [data-testid="receive_message"]，
     文本在其中的 [data-testid="message_text_content"]
   - 新对话按钮 [data-testid="create_conversation_button"] */
(function () {
  'use strict';
  if (window.__HW_BRIDGE__) return;
  window.__HW_BRIDGE__ = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const squash = (s) => (s || '').replace(/\s+/g, '');

  /* 编辑器定位：优先 ProseMirror；初始态可能只有 textarea（聚焦可唤醒编辑器） */
  function findEditor() {
    const zone = document.querySelector('[data-testid="chat_input_input"]');
    const pm =
      (zone && (zone.matches('.ProseMirror') ? zone : zone.querySelector('.ProseMirror'))) ||
      [...document.querySelectorAll('.ProseMirror')].find(vis);
    if (pm) return pm;
    const ta = zone && (zone.matches('textarea') ? zone : zone.querySelector('textarea'));
    return ta || null;
  }

  /* 填入问题。返回 true 表示编辑器里确认出现了目标文本 */
  async function setInput(text) {
    let el = findEditor();
    if (!el) throw new Error('找不到豆包输入框（页面可能未加载完）');
    if (!(el.classList && el.classList.contains('ProseMirror'))) {
      el.focus(); // 尝试唤醒富文本编辑器
      for (let i = 0; i < 10; i++) {
        await sleep(300);
        el = findEditor();
        if (el && el.classList && el.classList.contains('ProseMirror')) break;
      }
    }
    if (!(el.classList && el.classList.contains('ProseMirror'))) throw new Error('豆包编辑器未就绪');

    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    await sleep(400);
    if (squash(el.textContent).includes(squash(text))) return true;
    // 重试一次（个别情况下首次 insertText 被吞）
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    await sleep(400);
    if (squash(el.textContent).includes(squash(text))) return true;
    throw new Error('问题未能写入豆包输入框');
  }

  function clickSend() {
    const btn = document.querySelector('button[data-testid="chat_input_send_button"]');
    if (!btn) throw new Error('找不到发送按钮');
    if (btn.disabled) throw new Error('发送按钮不可用（输入未生效？）');
    btn.click();
  }

  async function newChat() {
    const btn = document.querySelector('[data-testid="create_conversation_button"]');
    if (btn) {
      btn.click();
      await sleep(1500);
    }
  }

  /* 等 DOM 变化（事件驱动）： MutationObserver 实时唤醒 + 定时兜底。
     后台标签页的 setTimeout 会被 Chrome 节流到 1 秒以上，事件监听不受影响。 */
  function waitForChange(timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        mo.disconnect();
        clearTimeout(timer);
        resolve();
      };
      const mo = new MutationObserver(finish);
      const timer = setTimeout(finish, timeoutMs);
      mo.observe(document.body, { subtree: true, childList: true, characterData: true });
    });
  }

  /* 完整问一次：新对话 → 填入 → 发送 → 等回答文本稳定 2 秒 → 返回。
     发出/回答的判定用"元素身份"而非数量：新对话会重建消息区，数量对比会误判
     （基线在旧 DOM 上数的，重置后新消息数小于基线）。 */
  async function askOne(prompt, useNewChat) {
    if (useNewChat) await newChat();
    const editor = findEditor();
    if (!editor) throw new Error('豆包输入框未就绪');
    await sleep(800); // 等新对话页面稳定，避免基线取到旧 DOM

    const seenRecv = new Set([...document.querySelectorAll('[data-testid="receive_message"]')]);
    const seenSent = new Set([...document.querySelectorAll('[data-testid="send_message"]')]);
    const promptKey = squash(prompt).slice(0, 80);
    const hasFreshSent = () =>
      [...document.querySelectorAll('[data-testid="send_message"]')].some((el) => !seenSent.has(el));
    const hasBubbleWithPrompt = () =>
      [...document.querySelectorAll('[data-testid="send_message"]')].some((el) =>
        squash(el.textContent).includes(promptKey),
      );

    await setInput(prompt);
    await sleep(200);
    clickSend();

    // 确认消息已发出：出现"新的"用户气泡（最多等 30 秒）；12 秒仍无气泡且页面也没有
    // 我们这条内容的任何气泡时，自动重发一次（输入/点击偶发被吞的自愈）
    const sentDeadline = Date.now() + 30000;
    let retried = false;
    let sent = false;
    while (Date.now() < sentDeadline) {
      if (hasFreshSent() || hasBubbleWithPrompt()) {
        sent = true;
        break;
      }
      if (!retried && Date.now() > sentDeadline - 18000) {
        retried = true;
        if (!hasBubbleWithPrompt()) {
          await setInput(prompt);
          await sleep(300);
          clickSend();
        }
      }
      await waitForChange(1000);
    }
    if (!sent) throw new Error('消息似乎未发出（可能遇到风控验证，请在豆包标签页手动确认一次）');

    // 等回答：只认发送后"新出现"的 receive_message（元素身份），文本稳定 2 秒视为生成完成
    const t0 = Date.now();
    let lastText = '';
    let stableSince = 0;
    while (Date.now() - t0 < 150000) {
      const fresh = [...document.querySelectorAll('[data-testid="receive_message"]')].filter(
        (el) => !seenRecv.has(el),
      );
      if (fresh.length) {
        const last = fresh[fresh.length - 1];
        const txt = ((last.querySelector('[data-testid="message_text_content"]') || last).textContent || '').trim();
        if (txt && txt === lastText) {
          if (!stableSince) stableSince = Date.now();
          if (Date.now() - stableSince > 2000) return txt;
        } else {
          lastText = txt;
          stableSince = 0;
        }
      }
      await waitForChange(1000);
    }
    throw new Error('等待豆包回答超时（150 秒）');
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'BRIDGE_PING') {
      sendResponse({
        ok: true,
        ready: !!findEditor(),
        hasEditor: !!findEditor(),
        hasSend: !!document.querySelector('button[data-testid="chat_input_send_button"]'),
        url: location.href,
      });
      return;
    }
    if (msg?.type === 'BRIDGE_ASK') {
      const { prompt, newChat: useNewChat } = msg.payload || {};
      askOne(String(prompt || ''), useNewChat !== false)
        .then((text) => sendResponse({ ok: true, text }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true; // 异步回传
    }
  });
})();
