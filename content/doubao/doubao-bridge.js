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

  function sendButton() {
    return [...document.querySelectorAll('button[data-testid="chat_input_send_button"]')].find(vis);
  }

  /* 新版豆包只在输入框有内容时才挂载发送按钮；空输入时按钮根本不在 DOM。
     写入问题后先等按钮出现，并顺手确认输入仍在本题文本上，避免上一轮残留状态。 */
  async function waitSendReady(text) {
    const ready = () => {
      const btn = sendButton();
      const editor = findEditor();
      return btn && !btn.disabled && editor && squash(editorText(editor)) === squash(text);
    };
    if (await waitUntil(ready, 3000)) return;
    const editor = findEditor();
    if (editor && squash(editorText(editor)) === squash(text)) {
      /* React 偶尔漏掉一次 input 通知：补一个末尾字符再删掉，不改动题目内容。 */
      editor.focus();
      if (editor.tagName === 'TEXTAREA') {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, text + ' ');
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' ' }));
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, text);
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      } else {
        document.execCommand('insertText', false, ' ');
        document.execCommand('delete', false, null);
      }
      if (await waitUntil(ready, 3000)) return;
    }
    throw new Error('豆包发送按钮不可用，请检查页面或稍后重试');
  }

  function clickSend() {
    const btn = sendButton();
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

  /* 上传题目图片：新版豆包不再把 file input 挂在输入框祖先链里，
     先全文档找可用的 file input，找不到就把图片作为粘贴数据交给编辑器
     （ProseMirror/Tiptap 都支持粘贴图片）。返回是否确认上传成功。 */
  async function attachImages(editor, images) {
    if (!images.length) return true;
    const files = images.map((value, i) => {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/i.exec(value);
      if (!match) throw new Error('题目图片数据无效');
      const binary = atob(match[2]);
      const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      return new File([bytes], `question-${i + 1}.${match[1].split('/')[1]}`, { type: match[1] });
    });
    const zone = editor.closest('[data-testid="chat_input_input"]')?.parentElement?.parentElement || editor.parentElement;
    const previews = () => [...document.querySelectorAll('img[src^="blob:"],img[src^="data:image/"],[data-testid*="attachment"] img,[data-testid*="upload"] img')].filter(vis);
    if ([...zone.querySelectorAll('img[src^="blob:"],img[src^="data:image/"]')].filter(vis).length) throw new Error('豆包输入区已有附件，请先处理后再继续');
    const seen = new Set(previews());
    const added = n => () => previews().filter(img => !seen.has(img) && img.complete && img.naturalWidth > 0).length >= n;
    const makeTransfer = () => {
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(file);
      return transfer;
    };
    const input = [...document.querySelectorAll('input[type="file"]')].filter(vis).find(i => files.length === 1 || i.multiple);
    if (input) {
      input.files = makeTransfer().files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (await waitUntil(added(images.length), 12000)) return true;
    }
    editor.focus();
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: makeTransfer(), bubbles: true, cancelable: true }));
    return await waitUntil(added(images.length), 20000);
  }

  /* 豆包把回复里的公式（P(X\leq3})渲染成 KaTeX 节点，直接读 textContent 会丢掉
     公式片段，JSON 里只剩 "B P(X"。按 DOM 顺序拼接，公式节点取 annotation 的 LaTeX 原文。 */
  function replyText(el) {
    const content = el?.querySelector('[data-testid="message_text_content"]') || el;
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
    if (!editor) throw new Error('豆包输入框未就绪');

    const seenRecv = new Set(messageNodes('receive_message'));
    // 网页会折叠、分段或格式化长消息；用本次唯一编号定位，避免整段文本比对误判和历史串题。
    const requestId = 'hw-' + crypto.randomUUID();
    const requestPrompt = `【请求编号：${requestId}，不要在答案中输出编号】\n\n${prompt}`;
    const findSent = () => messageNodes('send_message').find(el => sentText(el).includes(requestId));

    await setInput(requestPrompt);
    await attachImages(findEditor(), images);
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
    if (!sent) throw new Error('消息似乎未发出，已暂停；请在豆包页面确认后重试');
    /* 上传附件已在发送前确认（attachImages）；发送后的气泡不一定把图片渲染成 img
       （可能是背景图/缩略图），这里不再据此判失败，避免整轮停住。 */

    // 等回答：只认发送后"新出现"的 receive_message（元素身份），文本稳定 2 秒视为生成完成
    const t0 = Date.now();
    let lastText = '';
    let stableSince = 0;
    let missingSince = 0;
    while (Date.now() - t0 < 150000) {
      checkPageNotices();
      const currentSent = findSent();
      if (!currentSent) {
        /* 长会话里旧发送气泡会被页面回收，但本题的新回复仍会出现。
           只认本次新出现的完整批量 JSON；解析器会再校验题号与数量，不会串题。 */
        const orphan = messageNodes('receive_message').filter(el => !seenRecv.has(el));
        if (orphan.length) {
          missingSince = 0;
          const last = orphan[orphan.length - 1];
          const txt = replyText(last);
          const done = /^\s*\{[\s\S]*"results"[\s\S]*\}\s*$/.test(txt);
          if (txt && done && txt === lastText) {
            if (!stableSince) stableSince = Date.now();
            if (Date.now() - stableSince > 2000) return txt;
          } else {
            lastText = done ? txt : '';
            stableSince = 0;
          }
        } else {
          if (!missingSince) missingSince = Date.now();
          if (Date.now() - missingSince >= 2000) throw new Error('豆包对话已切换，已暂停本题；请确认当前对话后重新点击开始');
        }
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
        const content = last.querySelector('[data-testid="message_text_content"]');
        const txt = replyText(last);
        /* 豆包生成时先出「搜索 N 个关键词，参考 M 篇资料」气泡，正文节点还没挂上：
           那不是答案，继续等正文；稳定的空节点同理。 */
        const searching = !content
          ? (/^(?:搜索|正在搜索|参考|已阅读|深度思考|思考中)/.test(txt) || !txt)
          : /^(?:搜索\s*\d+\s*个关键词|正在搜索|参考\s*\d+\s*篇资料)$/.test(txt);
        /* 生成中的 JSON 会先出现 `{"results":` 这类半截文本；必须等完整闭合。 */
        const incomplete = /^\s*\{/.test(txt) && !/\}\s*$/.test(txt);
        if (txt && !searching && !incomplete && txt === lastText) {
          if (!stableSince) stableSince = Date.now();
          if (Date.now() - stableSince > 2000) return txt;
        } else {
          lastText = searching || incomplete ? '' : txt;
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
      const { prompt, images = [] } = msg.payload || {};
      askOne(String(prompt || ''), images)
        .then((text) => sendResponse({ ok: true, text }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true; // 异步回传
    }
  });
})();
