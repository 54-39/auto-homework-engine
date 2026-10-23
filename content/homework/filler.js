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
    const EventType = el.ownerDocument.defaultView.Event;
    el.dispatchEvent(new EventType('input', { bubbles: true }));
    el.dispatchEvent(new EventType('change', { bubbles: true }));
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
    if (l.clickEl?.hasAttribute('aria-checked')) return l.clickEl.getAttribute('aria-checked') === 'true';
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
    if (el.isContentEditable) {
      fillRichEditor(null, value, el);
      return;
    }
    const view = el.ownerDocument.defaultView;
    const proto = el.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
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

  const blankFields = (q) => q.el.fields?.length ? q.el.fields : q.el.iframes?.length ? q.el.iframes : q.el.inputs;
  function blankParts(answer, count) {
    const source = String(answer);
    const encoded = /^\[\s*"/.test(source);
    let parts;
    if (encoded) {
      const values = JSON.parse(source);
      if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) throw new Error('填空答案格式不正确');
      parts = values.map(norm);
    } else parts = source.split(/[;；\n]/).map(norm);
    if (!encoded && parts.length === 1 && count > 1) {
      const alt = parts[0].split(/[,，、]/).map(norm);
      if (alt.length === count) parts = alt;
    }
    if (parts.length !== count || parts.some((p) => !p)) throw new Error(`填空答案数量与页面的 ${count} 个空不一致`);
    return parts;
  }

  function selectOption(el, answer) {
    const shared = HW.AIDetection?.sharedOptions(el);
    if (shared) {
      const matches = shared.filter((o) => o.text === norm(answer));
      if (matches.length !== 1) throw new Error('共用选项答案与页面文字无法唯一匹配');
      return matches[0];
    }
    const matches = [...el.options].filter((o) => !o.disabled && o.value !== '' && norm(o.textContent) === norm(answer));
    if (el.multiple || matches.length !== 1) throw new Error('下拉答案与可选文字无法唯一匹配');
    return matches[0];
  }

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
        const wantKey = JUDGE_TRUE.test(ans) ? 'T' : JUDGE_FALSE.test(ans) ? 'F' : null;
        if (!wantKey) throw new Error('判断题答案无法解析: ' + ans.slice(0, 20));
        // 适配器新版式给 T/F 键；旧版式/不认得的版式按选项文字（对/错）兜底匹配
        const target =
          q.el.labels.find((l) => l.key === wantKey) ||
          q.el.labels.find((l) => (wantKey === 'T' ? JUDGE_TRUE : JUDGE_FALSE).test(plainLabel(l.text)));
        if (!target) throw new Error('未找到对应的 对/错 选项');
        if (!readSet().has(target.key)) {
          if (target.clickEl) target.clickEl.click();
          await sleep(350);
        }
        if (!readSet().has(target.key)) {
          // 兜底直写：载体值按现场格式——新版式判断题是字母圈 span 的 data（true/false），旧版式是 对/错
          const sp = spanOf(target);
          const dv = sp && sp.getAttribute('data');
          q.el.stateInput.value = dv || (wantKey === 'T' ? '对' : '错');
          for (const l of q.el.labels) {
            const s = spanOf(l);
            if (s) s.classList.toggle(selClass, l === target);
            if (l.clickEl && l.clickEl.hasAttribute('aria-checked')) l.clickEl.setAttribute('aria-checked', String(l === target));
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
      const fields = blankFields(q);
      const parts = blankParts(ans, fields.length);
      // 先验证全部下拉值，再按页面顺序填写混合控件，避免错位或补写重复答案。
      const choices = fields.map((el, i) => el.tagName === 'SELECT' || HW.AIDetection?.sharedOptions(el) ? selectOption(el, parts[i]) : null);
      for (let i = 0; i < fields.length; i++) {
        const el = fields[i];
        if (choices[i]?.clickEl) {
          const target = choices[i].clickEl;
          if (!target.classList.contains('check_answer')) {
            target.scrollIntoView({ block: 'center' });
            /* 站点偶尔要点两次才把选中态挂上：450ms 的回读太急就报
               「共用选项点击后回读不一致」（2026-10-22 大学英语 Further exploration 实测）。
               最多点三次、间隔递增，仍不行才把这道题交给上层「留空随卷提交」。 */
            for (let t = 0; t < 3 && !target.classList.contains('check_answer'); t++) {
              target.click();
              await new Promise((resolve) => setTimeout(resolve, 450 + t * 350));
            }
          }
          if (el.querySelectorAll('.num_option.check_answer').length !== 1 || !target.classList.contains('check_answer')) throw new Error('共用选项点击后回读不一致');
        } else if (choices[i]) {
          Object.getOwnPropertyDescriptor(el.ownerDocument.defaultView.HTMLSelectElement.prototype, 'value').set.call(el, choices[i].value);
          fire(el);
          el.blur();
        } else if (el.tagName === 'IFRAME') fillRichEditor(el, parts[i]);
        else { setNativeValue(el, parts[i]); el.blur(); }
      }
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
  function fillRichEditor(iframeEl, text, editable) {
    const opener = iframeEl?.closest('.blankItemInp')?.querySelector('.InpDIV');
    if (opener?.getClientRects().length) opener.click();
    let doc;
    try {
      doc = editable ? editable.ownerDocument : iframeEl.contentDocument;
    } catch {
      throw new Error('富文本编辑器跨域不可写入');
    }
    if (!doc || !doc.body) throw new Error('富文本编辑器不可访问');
    const body = editable || doc.body;
    body.focus();
    let ok = false;
    try {
      const range = doc.createRange();
      range.selectNodeContents(body);
      const selection = doc.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
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
    fire(body);
    // 超星在编辑器失焦时同步答案；脚本点提交不会自动使最后一个编辑器失焦。
    body.blur();
    iframeEl?.blur();
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
          // 载体值两代格式都认：新版式 true/false（字母圈 data），旧版式 对/错
          if (JUDGE_TRUE.test(ans)) return /^(T|true|对|正确)$/i.test(cur);
          if (JUDGE_FALSE.test(ans)) return /^(F|false|错|错误)$/i.test(cur);
          return false;
        }
        const wantSet = new Set(lettersOf(ans));
        const curSet = new Set((cur.toUpperCase().match(/[A-H]/g) || []));
        return curSet.size === wantSet.size && [...wantSet].every((k) => curSet.has(k));
      }
      if (type === 'choice' || type === 'multi') {
        const wants = lettersOf(ans);
        const states = q.el.labels.map((l) => stateOf(l));
        const canRead = !!learnedSelClass() || q.el.labels.some((l) => l.input || l.clickEl?.hasAttribute('aria-checked'));
        if (!canRead && !states.some(Boolean)) return 'unknown';
        return q.el.labels.every((l, i) => states[i] === wants.includes(l.key));
      }
      if (type === 'judge') {
        const looksFalse = /错|误|×|✘|false/i.test(ans);
        const target = q.el.labels.find((l) => (looksFalse ? JUDGE_FALSE : JUDGE_TRUE).test(plainLabel(l.text)));
        if (!target) return 'unknown';
        const canRead = !!learnedSelClass() || q.el.labels.some((l) => l.input || l.clickEl?.hasAttribute('aria-checked'));
        const anySel = q.el.labels.some((l) => stateOf(l));
        if (!canRead && !anySel) return 'unknown';
        return stateOf(target);
      }
      if (type === 'blank') {
        const fields = blankFields(q);
        const parts = blankParts(ans, fields.length);
        return fields.every((el, i) => {
          if (HW.AIDetection?.sharedOptions(el)) return el.querySelectorAll('.num_option.check_answer').length === 1 && selectOption(el, parts[i]).clickEl.classList.contains('check_answer');
          if (el.tagName === 'SELECT') return el.selectedOptions.length === 1 && el.selectedOptions[0] === selectOption(el, parts[i]);
          const value = el.tagName === 'IFRAME' ? el.contentDocument?.body?.textContent : el.isContentEditable ? el.textContent : el.value;
          return norm(value) === parts[i];
        });
      }
      if (type === 'subjective') {
        if (q.el.iframe) {
          const body = q.el.iframe.contentDocument?.body;
          return !!body && squash(body.textContent).length > 0;
        }
        const input = q.el.inputs[0];
        return !!norm(input?.isContentEditable ? input.textContent : input?.value);
      }
    } catch {
      return false;
    }
    return false;
  }

  HW.Filler = { fill, verify };
})();
