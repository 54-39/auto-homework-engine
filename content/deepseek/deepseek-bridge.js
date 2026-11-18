/* DeepSeek 网页桥接：由后台 service-worker 调度，在本页面自动完成"提问 → 等回答 → 回传"。
   DOM 契约（2026-11-16 在 chat.deepseek.com 实测验证）：
   - 输入区原生 textarea[name="search"]（placeholder「给 DeepSeek 发送消息」）
   - 发送键 div[role="button"].ds-button--circle，禁用态靠 class ds-button--disabled（非 disabled 属性）
   - 消息节点 .ds-message；助手答案正文 .ds-assistant-message-main-content（思考过程是另一段 .ds-markdown，不混入）
   - 图片 input[type=file][multiple] 接受 png/jpg 等
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
  const messageNodes = () => [...document.querySelectorAll('.ds-message')].filter(vis);
  const isAssistant = (el) => !!el.querySelector('.ds-assistant-message-main-content');
  const sentText = (el) => {
    const copy = el.cloneNode(true);
    copy.querySelectorAll('button,[role="button"]').forEach(node => node.remove());
    return squash(copy.textContent);
  };

  /* 只点可见弹窗自身的关闭控件，不删除遮罩，也不替用户完成验证或同意条款。 */
  function checkPageNotices() {
    const challenges = document.querySelectorAll('iframe[src*="captcha"],iframe[src*="verify"],.captcha_verify_container,[class*="captcha"]');
    if ([...challenges].some(vis)) throw new Error('DeepSeek 需要安全验证，请在 DeepSeek 页面完成验证后继续');
    const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],.ds-modal,.ds-dialog')].filter(vis);
    for (const dialog of dialogs) {
      if (dialogs.some(other => other !== dialog && dialog.contains(other))) continue;
      const text = squash(dialog.innerText || dialog.textContent);
      if (/安全验证|人机验证|人脸验证|滑块验证|拖动.{0,12}(滑块|拼图)|访问异常|操作频繁|异常请求|完成验证/.test(text)
          || (/验证码/.test(text) && !/登录|注册|手机号|手机号码|短信/.test(text))) {
        throw new Error('DeepSeek 需要安全验证，请在 DeepSeek 页面完成验证后继续');
      }
      const close = [...dialog.querySelectorAll('button,[role="button"],[class*="close"]')].find(el => {
        if (!vis(el) || typeof el.click !== 'function' || el.getAttribute('aria-disabled') === 'true') return false;
        const label = squash(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent);
        return /^(关闭|关闭弹窗|取消|暂不|暂不登录|以后再说|稍后再说|我知道了|知道了|跳过|close(?:dialog|window)?|dismiss|×|✕|✖|x)$/i.test(label)
          || /close/i.test(el.className?.toString() || '');
      });
      if (close) close.click();
      else if (/登录|登入|log\s*in|sign\s*in/i.test(text)) {
        throw new Error('DeepSeek 需要登录，请在 DeepSeek 页面登录后继续');
      }
    }
  }

  function findEditor() {
    return [...document.querySelectorAll('textarea[name="search"]')].find(vis)
      || [...document.querySelectorAll('textarea')].find(el => vis(el) && /DeepSeek/i.test(el.getAttribute('placeholder') || ''))
      || null;
  }

  /* 填入问题（原生 textarea：用原型 value setter + input 事件，React 才会收到通知）。 */
  async function setInput(text) {
    let el = findEditor();
    if (!el) throw new Error('找不到 DeepSeek 输入框（页面可能未加载完或需要登录）');
    for (let i = 0; i < 2; i++) {
      el.focus();
      el = findEditor() || el;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      if (await waitUntil(() => squash(findEditor()?.value) === squash(text), 400)) return true;
    }
    throw new Error('问题未能写入 DeepSeek 输入框');
  }

  function sendButton() {
    return [...document.querySelectorAll('.ds-button--circle')].find(vis);
  }
  const sendEnabled = (btn) => !!btn && !btn.classList.contains('ds-button--disabled');

  async function waitSendReady(text) {
    const ready = () => {
      const btn = sendButton();
      const editor = findEditor();
      return sendEnabled(btn) && editor && squash(editor.value) === squash(text);
    };
    if (await waitUntil(ready, 3000)) return;
    const editor = findEditor();
    if (editor && squash(editor.value) === squash(text)) {
      /* React 偶尔漏掉一次 input 通知：补一个末尾字符再删掉，不改动题目内容。 */
      editor.focus();
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(editor, text + ' ');
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' ' }));
      set.call(editor, text);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      if (await waitUntil(ready, 3000)) return;
    }
    throw new Error('DeepSeek 发送按钮不可用，请检查页面或稍后重试');
  }

  function clickSend() {
    const btn = sendButton();
    if (!btn) throw new Error('找不到发送按钮');
    if (!sendEnabled(btn)) throw new Error('发送按钮不可用（输入未生效？）');
    btn.click();
  }

  /* 等 DOM 变化（事件驱动）：MutationObserver 实时唤醒 + 定时兜底。
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
        attributeFilter: ['disabled', 'contenteditable', 'aria-disabled', 'class'] });
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

  /* 上传题目图片：DeepSeek 的 file input 接受图片，先设 files 触发 change，
     失败再把图片作为粘贴数据交给输入框。返回是否确认上传成功。 */
  async function attachImages(editor, images) {
    if (!images.length) return true;
    const files = images.map((value, i) => {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/i.exec(value);
      if (!match) throw new Error('题目图片数据无效');
      const binary = atob(match[2]);
      const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      return new File([bytes], `question-${i + 1}.${match[1].split('/')[1]}`, { type: match[1] });
    });
    const previews = () => [...document.querySelectorAll('img[src^="blob:"],img[src^="data:image/"],[class*="attachment"] img,[class*="upload"] img')].filter(vis);
    const seen = new Set(previews());
    const added = n => () => previews().filter(img => !seen.has(img) && img.complete && img.naturalWidth > 0).length >= n;
    const makeTransfer = () => {
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(file);
      return transfer;
    };
    const input = [...document.querySelectorAll('input[type="file"]')].find(i => files.length === 1 || i.multiple);
    if (input) {
      input.files = makeTransfer().files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (await waitUntil(added(images.length), 12000)) return true;
    }
    editor.focus();
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: makeTransfer(), bubbles: true, cancelable: true }));
    return await waitUntil(added(images.length), 20000);
  }

  /* 回复里的公式渲染成 KaTeX 节点，直接读 textContent 会丢公式片段；
     按 DOM 顺序拼接，公式节点取 annotation 的 LaTeX 原文。只读助手答案正文，不含思考过程。 */
  function replyText(el) {
    const content = el?.querySelector('.ds-assistant-message-main-content') || el;
    if (!content) return '';
    const out = [];
    const walk = node => {
      if (node.nodeType === 3) { out.push(node.data); return; }
      if (node.nodeType !== 1) return;
      if (node.matches?.('.katex')) {
        const ann = node.querySelector('annotation[encoding="application/x-tex"]');
        out.push(ann ? ann.textContent : (node.textContent || ''));
        return;
      }
      for (const child of node.childNodes) walk(child);
    };
    walk(content);
    return out.join('').trim();
  }

  async function askOne(prompt, images = []) {
    checkPageNotices();
    const editor = findEditor();
    if (!editor) throw new Error('DeepSeek 输入框未就绪');

    const seenRecv = new Set(messageNodes().filter(isAssistant));
    // 用本次唯一编号定位发送气泡，避免整段文本比对误判和历史串题。
    const requestId = 'hw-' + crypto.randomUUID();
    const requestPrompt = `【请求编号：${requestId}，不要在答案中输出编号】\n\n${prompt}`;
    const findSent = () => messageNodes().find(el => !isAssistant(el) && sentText(el).includes(requestId));

    await setInput(requestPrompt);
    if (!await attachImages(findEditor(), images)) throw new Error('题目图片上传未确认，已停止发送；请检查 DeepSeek 附件后重试');
    await waitSendReady(requestPrompt);
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
    if (!sent) throw new Error('消息似乎未发出，已暂停；请在 DeepSeek 页面确认后重试');

    // 等回答：只认发送后"新出现"的助手消息，答案正文稳定 2 秒视为生成完成。
    const t0 = Date.now();
    let lastText = '';
    let stableSince = 0;
    let missingSince = 0;
    while (Date.now() - t0 < 150000) {
      checkPageNotices();
      const currentSent = findSent();
      if (!currentSent) {
        /* 长会话里旧发送气泡会被页面回收，但本题的新回复仍会出现：只认本次新出现的完整批量 JSON。 */
        const orphan = messageNodes().filter(el => isAssistant(el) && !seenRecv.has(el));
        if (orphan.length) {
          missingSince = 0;
          const txt = replyText(orphan[orphan.length - 1]);
          const done = /^\s*\{[\s\S]*"results"[\s\S]*\}\s*$/.test(txt);
          if (txt && done && txt === lastText) {
            if (!stableSince) stableSince = Date.now();
            if (Date.now() - stableSince > 2000) return txt;
          } else { lastText = done ? txt : ''; stableSince = 0; }
        } else {
          if (!missingSince) missingSince = Date.now();
          if (Date.now() - missingSince >= 2000) throw new Error('DeepSeek 对话已切换，已暂停本题；请确认当前对话后重新点击开始');
        }
        await waitForChange(250);
        continue;
      }
      sent = currentSent;
      missingSince = 0;
      const fresh = messageNodes().filter(
        (el) => isAssistant(el) && !seenRecv.has(el) && sent.isConnected && (sent.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING),
      );
      if (fresh.length) {
        const txt = replyText(fresh[fresh.length - 1]);
        /* 深度思考先出「已思考/思考中」气泡，正文节点还没挂上：那不是答案，继续等正文。 */
        const thinking = !txt || /^(?:已思考|思考中|正在思考|深度思考|正在搜索|搜索)/.test(txt);
        /* 生成中的 JSON 会先出现 `{"results":` 这类半截文本；必须等完整闭合。 */
        const incomplete = /^\s*\{/.test(txt) && !/\}\s*$/.test(txt);
        if (txt && !thinking && !incomplete && txt === lastText) {
          if (!stableSince) stableSince = Date.now();
          if (Date.now() - stableSince > 2000) return txt;
        } else { lastText = thinking || incomplete ? '' : txt; stableSince = 0; }
      }
      await waitForChange(1000);
    }
    throw new Error('等待 DeepSeek 回答超时（150 秒）');
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
        hasSend: !!sendButton(),
        url: location.href,
      });
      return;
    }
    if (msg?.type === 'BRIDGE_ASK') {
      const { prompt, images = [] } = msg.payload || {};
      askOne(String(prompt || ''), images)
        .then((text) => sendResponse({ ok: true, text }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true; // 异步回传
    }
  });
})();