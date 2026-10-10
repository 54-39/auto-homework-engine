/* 答案填写器：把引擎返回的答案写回页面表单。
   关键点：文本类必须用原生 setter + 派发 input/change 事件，兼容 React/Vue 受控组件；
   选项类直接对真实 input 触发 click（各框架都能监听到）。 */
(function () {
  'use strict';
  const HW = (window.HW = window.HW || {});

  const JUDGE_TRUE = /^(对|正确|√|✔|✓|是|真|T|True|TRUE)$/;
  const JUDGE_FALSE = /^(错|错误|误|×|✘|✗|否|假|F|False|FALSE)$/;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const plainLabel = (t) => norm(t).replace(/^[A-Za-z]?[\s.、．:：)）]*/, '').trim();

  function fire(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  /* 选中状态识别：只信硬证据——input.checked 和自动学习的选中类。
     猜测性 CSS 类（cur/check/on 等）不再参与：超星未选中的选项上也可能出现这些词，
     误判会让空页面被当成"已填"，进而跳过所有题目。 */
  function learnedSelClass() {
    try {
      return sessionStorage.getItem('hwSelClass:' + location.host);
    } catch {
      return null;
    }
  }
  function classHit(n) {
    if (!n || !n.classList) return false;
    const learned = learnedSelClass();
    return !!learned && n.classList.contains(learned);
  }
  function looksSelected(el) {
    if (!el) return false;
    if (classHit(el)) return true;
    const li = el.closest && el.closest('li');
    return classHit(li);
  }
  function stateOf(l) {
    return !!(l.input && l.input.checked) || looksSelected(l.clickEl) || looksSelected(l.input && l.input.closest('label'));
  }
  /* 学习：对比点击前后选项 class，把"正确答案选项新出现的类"记为该站点的选中标记 */
  function learnSelClass(labels, els, before, wants) {
    try {
      const key = 'hwSelClass:' + location.host;
      const after = els.map((o) => (o ? o.className : ''));
      for (let i = 0; i < els.length; i++) {
        if (!wants.includes(labels[i].key)) continue;
        const added = after[i]
          .split(/\s+/)
          .filter((c) => c && !before[i].split(/\s+/).includes(c));
        if (added.length) {
          if (sessionStorage.getItem(key) !== added[0]) sessionStorage.setItem(key, added[0]);
          return;
        }
      }
    } catch {
      /* sessionStorage 不可用则跳过学习 */
    }
  }

  /* 防取消点击（用于状态不可读的选项）：点击后对比该元素 class 的前后变化。
     若点击导致目标"丢失"类（切换型 UI 把已选中的点掉了）→ 立即再点一次恢复选中。
     无论站点用什么选中机制，最终状态都是"选中"。 */
  function toggleSafeClick(clickEl) {
    const before = String(clickEl.className || '');
    clickEl.click();
    const after = String(clickEl.className || '');
    if (after === before) return; // 无类变化：已选中（非切换型）或无类反馈，结束
    const lost = before.split(/\s+/).filter((c) => c && !after.split(/\s+/).includes(c));
    const gained = after.split(/\s+/).filter((c) => c && !before.split(/\s+/).includes(c));
    if (lost.length && !gained.length) clickEl.click(); // 纯丢失 = 被切换掉了：再点一次恢复
  }

  /* 点选一个选项。l.input 可能不存在（纯 li 选项站点），或隐藏（超星类站点，点其可见 label）。
     选中状态类感知：已选中的不再点击（防止切换型 UI 把它点成取消）。 */
  function clickOption(l, wantChecked) {
    const input = l.input;
    const hiddenLabel = input && !isVisible(input) && input.closest('label') && isVisible(input.closest('label'))
      ? input.closest('label')
      : null;
    const clickEl = l.clickEl || hiddenLabel || input;
    const isSel = stateOf(l);
    clickEl.scrollIntoView({ block: 'center' });
    if (wantChecked !== isSel) {
      if (input && clickEl === input) {
        input.click(); // 原生 input：radio 重复点击不会取消、checkbox 由 wantChecked 精确控制
      } else {
        toggleSafeClick(clickEl);
      }
    }
    if (input && wantChecked && !input.checked) {
      input.checked = true; // 兜底：个别框架拦截了 click 事件
      fire(input);
    }
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    fire(el);
  }

  /* 选中真相（2026-09-26 导出页实测）：aria-checked="true" 第一依据（单选/多选/判断通用）；
     无 aria 时看类：多选选中标记是 check_answer_dx（check_answer 只是基础样式），单选是 check_answer；
     再兜底 input.checked。 */
  function labelSelClass(labels) {
    const spans = labels.map((l) => (l.clickEl && l.clickEl.querySelector('[class*="num_option"]')) || null).filter(Boolean);
    return spans.some((sp) => sp.classList.contains('check_answer_dx')) ? 'check_answer_dx' : 'check_answer';
  }
  function isLabelSelected(l, selClass) {
    if (l.clickEl && l.clickEl.hasAttribute && l.clickEl.hasAttribute('aria-checked')) {
      return l.clickEl.getAttribute('aria-checked') === 'true';
    }
    const sp = l.clickEl && l.clickEl.querySelector('[class*="num_option"]');
    if (sp && sp.classList.contains(selClass)) return true;
    return !!(l.input && l.input.checked);
  }

  const lettersOf = (ans) => [...new Set(String(ans).toUpperCase().match(/[A-H]/g) || [])];

  async function fill(q, answer) {
    const type = q.meta.type;
    /* 主观题（含写作题）保留换行与行首空格——分段与标题近似居中全靠它们；
       只统一 CRLF，不做 norm()（那会把作文压成一行，0.4.6 及以前的第二个压平点）。
       Markdown 已由引擎 parseAnswer 清掉；这里不重复处理，保证所见即所写。 */
    const ans =
      type === 'subjective' ? String(answer ?? '').replace(/\r\n?/g, '\n') : norm(String(answer ?? ''));
    if (!ans.trim()) throw new Error('答案为空');

    // 超星：以"可见标记"为准做"点击 → 等待 → 复查"纠偏循环（最多 3 轮）。
    // 超星点击后可能异步重绘覆盖我们此前的直写，同步比对会误判；循环结束后
    // 仍不符则最终直写状态载体 + 标记做保证（兜底处理器损坏场景）。
    if (q.el.stateInput && q.el.labels.length) {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const spanOf = (l) => (l.clickEl && l.clickEl.querySelector('[class*="num_option"]')) || null;
      // 选中真相（2026-09-26 导出页实测）：行 aria-checked="true" 为第一依据（单选/多选/判断通用）；
      // 无 aria 时：多选看 check_answer_dx（check_answer 是基础样式不算选中），单选看 check_answer。
      const selClass = labelSelClass(q.el.labels);
      const markedSet = () => new Set(q.el.labels.filter((l) => isLabelSelected(l, selClass)).map((l) => l.key));
      const valLetters = () => new Set((String(q.el.stateInput.value || '').toUpperCase().match(/[A-H]/g) || []));
      const useMarked = q.el.labels.some((l) => spanOf(l));
      const readSet = () => (useMarked ? markedSet() : valLetters());
      const sameAs = (set, want) => set.size === want.size && [...want].every((k) => set.has(k));

      if (type === 'judge') {
        const wantKey = /^(对|正确|√|✔|✓|是|T|True|TRUE)$/i.test(ans) ? 'T' : /^(错|错误|误|×|✘|✗|否|假|F|False|FALSE)$/i.test(ans) ? 'F' : null;
        if (!wantKey) throw new Error('判断题答案无法解析: ' + ans.slice(0, 20));
        const target = q.el.labels.find((l) => l.key === wantKey);
        if (target && !readSet().has(wantKey)) {
          if (target.clickEl) target.clickEl.click();
          await sleep(350);
          if (!readSet().has(wantKey) && !String(q.el.stateInput.value || '').trim()) {
            q.el.stateInput.value = wantKey === 'T' ? '对' : '错';
          }
        }
        return;
      }

      const wantSet = new Set(lettersOf(ans));
      if (!wantSet.size) throw new Error('未能从回答中解析出选项字母: ' + ans.slice(0, 30));
      // 关键：一次只点一个选项，等超星处理完（异步重算状态）再点下一个。
      // 批量同帧点击会让超星处理器基于旧状态互相覆盖（导出页实测：value=ACD 但 UI 只有 B）。
      for (let step = 0; step < 14; step++) {
        const has = readSet();
        if (sameAs(has, wantSet)) return; // 已一致：幂等，绝不重复点击
        const missing = [...wantSet].find((k) => !has.has(k));
        const extra = [...has].find((k) => !wantSet.has(k));
        const key = missing || extra;
        const target = q.el.labels.find((l) => l.key === key);
        if (!target || !target.clickEl) break;
        target.clickEl.click();
        await sleep(400);
        if (sameAs(readSet(), has)) break; // 点击无效（处理器损坏）→ 走兜底
      }
      // 最终兜底：直写隐藏载体（提交读表单字段）；视觉类仅在超星处理器损坏时补同步
      const sorted = [...wantSet].sort();
      const sep = String(q.el.stateInput.value || '').includes(',') ? ',' : '';
      q.el.stateInput.value = sorted.join(sep);
      for (const l of q.el.labels) {
        const sp = spanOf(l);
        if (sp) sp.classList.toggle(selClass, wantSet.has(l.key));
      }
      for (const l of q.el.labels) {
        if (l.clickEl && l.clickEl.hasAttribute('aria-checked')) l.clickEl.setAttribute('aria-checked', String(wantSet.has(l.key)));
      }
      return;
    }

    if (type === 'choice' || type === 'multi') {
      const wants = lettersOf(ans);
      if (!wants.length) throw new Error('未能从回答中解析出选项字母: ' + ans.slice(0, 30));
      const els = q.el.labels.map((l) => l.clickEl || l.input);
      const before = els.map((o) => (o ? o.className : ''));
      let hit = 0;
      q.el.labels.forEach((l) => {
        const should = wants.includes(l.key);
        if (should) hit++;
        clickOption(l, should);
      });
      learnSelClass(q.el.labels, els, before, wants);
      if (!hit) throw new Error('选项字母 ' + wants.join('') + ' 在题目中不存在');
      return;
    }

    if (type === 'judge') {
      const looksFalse = /错|误|×|✘|false/i.test(ans);
      const looksTrue = /对|正确|√|✓|true|是/i.test(ans);
      if (!looksFalse && !looksTrue) throw new Error('判断题答案无法解析: ' + ans.slice(0, 20));
      const want = !looksFalse;
      const target = q.el.labels.find((l) => (want ? JUDGE_TRUE : JUDGE_FALSE).test(plainLabel(l.text)));
      if (!target) throw new Error('未找到对应的 对/错 选项');
      const els = q.el.labels.map((l) => l.clickEl || l.input);
      const before = els.map((o) => (o ? o.className : ''));
      clickOption(target, true);
      learnSelClass(q.el.labels, els, before, [target.key]);
      return;
    }

    if (type === 'blank') {
      const inputs = q.el.inputs;
      let parts = ans.split(/[;；\n]+/).map(norm).filter(Boolean);
      if (parts.length === 1 && inputs.length > 1) {
        const alt = parts[0].split(/[,，、]+/).map(norm).filter(Boolean);
        if (alt.length === inputs.length) parts = alt;
      }
      if (!parts.length) throw new Error('填空答案为空');
      while (parts.length > inputs.length && parts.length > 1) {
        const tail = parts.splice(parts.length - 2, 2).join('；');
        parts.push(tail);
      }
      inputs.forEach((inp, i) => setNativeValue(inp, parts[Math.min(i, parts.length - 1)]));
      return;
    }

    if (type === 'subjective') {
      if (q.el.iframe) {
        fillRichEditor(q.el.iframe, ans);
        return;
      }
      setNativeValue(q.el.inputs[0], ans);
      return;
    }

    throw new Error('未知题型: ' + type);
  }

  /* 往 iframe 富文本编辑器（UEditor 类）写入答案：优先 execCommand 键入，失败退回 innerHTML */
  function fillRichEditor(iframeEl, text) {
    let doc;
    try {
      doc = iframeEl.contentDocument;
    } catch {
      throw new Error('富文本编辑器跨域不可写入');
    }
    if (!doc || !doc.body) throw new Error('富文本编辑器不可访问');
    const body = doc.body;
    body.focus();
    let ok = false;
    try {
      doc.execCommand('selectAll', false, null);
      ok = doc.execCommand('insertText', false, text);
    } catch {
      ok = false;
    }
    if (!ok || !squash(body.textContent).includes(squash(text))) {
      const esc = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      body.innerHTML = text
        .split(/\n+/)
        .filter(Boolean)
        .map((l) => `<p>${esc}</p>`)
        .join('');
    }
    body.dispatchEvent(new Event('input', { bubbles: true }));
    body.dispatchEvent(new Event('change', { bubbles: true }));
    if (!squash(body.textContent).includes(squash(text))) throw new Error('答案未写入富文本编辑器');
  }

  const squash = (s) => (s || '').replace(/\s+/g, '');

  /* 回读校验：确认答案真的进了页面。
     返回 true（信号确认）| 'unknown'（页面完全不暴露选中状态，无法证伪，信任点击）| false（信号矛盾）。
     一旦页面状态可读（学习到选中类或有 input），即使全是"未选中"也严格判定——用户清空答案后必须能重新填写。 */
  function verify(q, answer) {
    const type = q.meta.type;
    const ans = norm(String(answer ?? ''));
    if (!ans) return false;
    try {
      // 超星：可见选中标记（字母圈 check_answer 类）为真相；无标记元素时回退隐藏 input
      if (q.el.stateInput && (type === 'choice' || type === 'multi' || type === 'judge')) {
        const rowsWithSpan = q.el.labels.filter((l) => l.clickEl && l.clickEl.querySelector('[class*="num_option"]'));
        if (rowsWithSpan.length === q.el.labels.length && q.el.labels.length) {
          const selClass = labelSelClass(q.el.labels);
          const marked = q.el.labels.filter((l) => isLabelSelected(l, selClass)).map((l) => l.key);
          let wantKeys;
          if (type === 'judge') {
            const wantT = /^(对|正确|√|✔|✓|是|T|True|TRUE)$/i.test(ans);
            const t = q.el.labels.find((l) => (wantT ? JUDGE_TRUE : JUDGE_FALSE).test(plainLabel(l.text)));
            wantKeys = t ? [t.key] : [];
          } else {
            wantKeys = lettersOf(ans);
          }
          const ms = marked.sort().join('');
          const ws = wantKeys.slice().sort().join('');
          return ms === ws;
        }
        const cur = String(q.el.stateInput.value || '').trim();
        if (type === 'judge') {
          if (/^(对|正确|√|✔|✓|是|T|True|TRUE)$/i.test(ans)) return /^T$/i.test(cur) || cur === '对' || cur === '正确';
          if (/^(错|错误|误|×|✘|✗|否|假|F|False|FALSE)$/i.test(ans)) return /^F$/i.test(cur) || cur === '错' || cur === '错误';
          return false;
        }
        const wantSet = new Set(lettersOf(ans));
        const curSet = new Set((cur.toUpperCase().match(/[A-H]/g) || []));
        return curSet.size === wantSet.size && [...wantSet].every((k) => curSet.has(k));
      }
      if (type === 'choice' || type === 'multi') {
        const wants = lettersOf(ans);
        const states = q.el.labels.map((l) => stateOf(l));
        const canRead = !!learnedSelClass() || q.el.labels.some((l) => l.input);
        if (!canRead && !states.some(Boolean)) return 'unknown';
        return q.el.labels.every((l, i) => states[i] === wants.includes(l.key));
      }
      if (type === 'judge') {
        const looksFalse = /错|误|×|✘|false/i.test(ans);
        const target = q.el.labels.find((l) => (looksFalse ? JUDGE_FALSE : JUDGE_TRUE).test(plainLabel(l.text)));
        if (!target) return 'unknown';
        const canRead = !!learnedSelClass() || q.el.labels.some((l) => l.input);
        const anySel = q.el.labels.some((l) => stateOf(l));
        if (!canRead && !anySel) return 'unknown';
        return stateOf(target);
      }
      if (type === 'blank') return q.el.inputs.every((i) => norm(i.value));
      if (type === 'subjective') {
        if (q.el.iframe) {
          const body = q.el.iframe.contentDocument?.body;
          return !!body && squash(body.textContent).length > 0;
        }
        return !!norm(q.el.inputs[0]?.value);
      }
    } catch {
      return false;
    }
    return false;
  }

  HW.Filler = { fill, verify };
})();
