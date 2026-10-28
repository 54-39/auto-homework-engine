/* 豆包页面桥接：由后台 service-worker 调度，在本页面自动完成"提问 → 等回答 → 回传"。
   DOM 契约（2026-09 在 www.doubao.com 实测验证）：
   - 输入区 [data-testid="chat_input_input"]，支持 .ProseMirror 与原生 textarea
   - 输入区兼容 ProseMirror 富文本与新版原生 textarea
   - 发送按钮 button[data-testid="chat_input_send_button"]（disabled 随输入状态变化）
   - 用户消息 [data-testid="send_message"] / AI 回答 [data-testid="receive_message"]，
     文本在其中的 [data-testid="message_text_content"]
   - 连续题目沿用当前会话，不自动新建对话 */
(function () {
  'use strict';
  if (window.__HW_BRIDGE__) return;
  window.__HW_BRIDGE__ = true;

  const vis = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const squash = (s) => (s || '').replace(/\s+/g, '');
  const editorText = (el) => el?.tagName === 'TEXTAREA' ? el.value : el?.textContent || '';
  const messageNodes = (type) => [...document.querySelectorAll(`[data-testid="${type}"]`)].filter(vis);
  const sentText = (el) => {
    const copy = el.cloneNode(true);
    copy.querySelectorAll('button,[role="button"]').forEach(node => node.remove());
    return squash(copy.textContent);
  };

  /* 只点可见弹窗自身的关闭控件，不删除遮罩，也不替用户完成验证或同意条款。 */
  function checkPageNotices() {
    const challenges = document.querySelectorAll('iframe[src*="captcha"],iframe[src*="verifycenter"],.captcha_verify_container,[data-testid="captcha"]');
    if ([...challenges].some(vis)) throw new Error('豆包需要安全验证，请在豆包页面完成验证后继续');
    const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],.semi-modal,.arco-modal,.ant-modal,.modal-content')].filter(vis);
    for (const dialog of dialogs) {
      if (dialogs.some(other => other !== dialog && dialog.contains(other))) continue;
      const text = squash(dialog.innerText || dialog.textContent);
      if (/安全验证|人机验证|人脸验证|滑块验证|拖动.{0,12}(滑块|拼图)|访问异常|操作频繁|异常请求|完成验证/.test(text)
          || (/验证码/.test(text) && !/登录|注册|手机号|手机号码|短信/.test(text))) {
        throw new Error('豆包需要安全验证，请在豆包页面完成验证后继续');
      }
      const close = [...dialog.querySelectorAll('button,[role="button"],[data-testid*="close"],[class*="modal-close"],[class*="dialog-close"]')].find(el => {
        if (!vis(el) || typeof el.click !== 'function' || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        const label = squash(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent);
        return /^(关闭|关闭弹窗|关闭弹出窗口|关闭对话框|取消|暂不|暂不登录|以后再说|稍后再说|我知道了|知道了|跳过|close(?:dialog|window)?|dismiss|×|✕|✖|x)$/i.test(label)
          || /(?:modal[-_]?close|dialog[-_]?close|close[-_]?button)/i.test(el.className?.toString() || '')
          || /close/i.test(el.getAttribute('data-testid') || '');
      });
      if (close) close.click();
      else if (/登录|登入|log\s*in|sign\s*in/i.test(text)) {
        throw new Error('豆包需要登录，请在豆包页面登录后继续');
      }
    }
  }

  /* 只使用当前可见输入区，避开页面保留的旧会话/响应式布局副本。 */
  function findEditor() {
    return [...document.querySelectorAll('.ProseMirror')].find(vis)
      || [...document.querySelectorAll('textarea[data-testid="chat_input_input"],[data-testid="chat_input_input"] textarea')].find(vis)
      || null;
  }

  /* 填入问题。返回 true 表示编辑器里确认出现了目标文本 */
  async function setInput(text) {
    let el = findEditor();
    if (!el) throw new Error('找不到豆包输入框（页面可能未加载完）');
    for (let i = 0; i < 2; i++) {
      el.focus();
      el = findEditor() || el;
      if (el.tagName === 'TEXTAREA') {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      } else {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, text);
      }
      if (await waitUntil(() => squash(editorText(findEditor())) === squash(text), 400)) return true;
    }
    throw new Error('问题未能写入豆包输入框');
  }

  function clickSend() {
    const btn = [...document.querySelectorAll('button[data-testid="chat_input_send_button"]')].find(vis);
    if (!btn) throw new Error('找不到发送按钮');
    if (btn.disabled) throw new Error('发送按钮不可用（输入未生效？）');
    btn.click();
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
      mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['disabled', 'contenteditable', 'aria-disabled'] });
    });
  }

  async function waitUntil(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      checkPageNotices();
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await waitForChange(Math.min(left, 250));
    }
    return true;
  }

  /* 沿用会话：确认本题的新消息发出后，只读其后的新回复，避免取到历史答案。 */
  async function askOne(prompt) {
    checkPageNotices();
    const editor = findEditor();
    if (!editor) throw new Error('豆包输入框未就绪');

    const seenRecv = new Set(messageNodes('receive_message'));
    // 网页会折叠、分段或格式化长消息；用本次唯一编号定位，避免整段文本比对误判和历史串题。
    const requestId = 'hw-' + crypto.randomUUID();
    const requestPrompt = `【请求编号：${requestId}，不要在答案中输出编号】\n\n${prompt}`;
    const findSent = () => messageNodes('send_message').find(el => sentText(el).includes(requestId));

    await setInput(requestPrompt);
    if (!(await waitUntil(() => {
      const btn = [...document.querySelectorAll('button[data-testid="chat_input_send_button"]')].find(vis);
      return btn && !btn.disabled;
    }, 3000))) throw new Error('豆包发送按钮不可用，请检查页面或稍后重试');
    checkPageNotices();
    clickSend();

    // 只发送一次，最多等 30 秒确认气泡；未发出时暂停交给用户处理，避免重复提问。
    const sentDeadline = Date.now() + 30000;
    let sent = null;
    while (Date.now() < sentDeadline) {
      checkPageNotices();
      sent = findSent();
      if (sent) break;
      await waitForChange(1000);
    }
    if (!sent) throw new Error('消息似乎未发出，已暂停；请在豆包页面确认后重试');

    // 等回答：只认发送后"新出现"的 receive_message（元素身份），文本稳定 2 秒视为生成完成
    const t0 = Date.now();
    let lastText = '';
    let stableSince = 0;
    let missingSince = 0;
    while (Date.now() - t0 < 150000) {
      checkPageNotices();
      const currentSent = findSent();
      if (!currentSent) {
        if (!missingSince) missingSince = Date.now();
        if (Date.now() - missingSince >= 2000) throw new Error('豆包对话已切换，已暂停本题；请确认当前对话后重新点击开始');
        await waitForChange(250);
        continue;
      }
      sent = currentSent;
      missingSince = 0;
      const fresh = messageNodes('receive_message').filter(
        (el) => !seenRecv.has(el) && sent.isConnected && (sent.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING),
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
      try { checkPageNotices(); }
      catch (e) {
        sendResponse({ ok: false, ready: false, attention: true, error: e.message, url: location.href });
        return;
      }
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
      const { prompt } = msg.payload || {};
      askOne(String(prompt || ''))
        .then((text) => sendResponse({ ok: true, text }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true; // 异步回传
    }
  });
})();
