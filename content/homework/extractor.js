/* 题目提取器：从作业页面 DOM 识别题目（通用启发式，M3 再按具体平台加专属适配器覆盖）。
   输出：[{ meta:{ index,type,stem,options,blanks }, el:{ inputs, labels } }]
   meta 可结构化克隆走消息通道；el 保留页面上的真实元素引用供填写器使用。 */
(function () {
  'use strict';
  const HW = (window.HW = window.HW || {});

  const BLOCK_SELECTORS = [
    '.questionLi', '.TiMu', // 超星学习通
    '.q-item', '.question-item', '.question', '.exam-question', '.topic-item',
    '[class*="question"]', '.topic', 'fieldset', 'form li', 'li',
  ];
  const STEM_SELECTORS = '.q-stem, [class*="stem"], .q-title, [class*="title" i], .topic-title';
  const JUDGE_TRUE = /^(对|正确|√|✔|✓|是|真|T|True|TRUE)$/;
  const JUDGE_FALSE = /^(错|错误|误|×|✘|✗|否|假|F|False|FALSE)$/;
  const LETTERS = 'ABCDEFGHIJ'.split('');

  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  /* 找题目块：按常见容器类名逐级尝试；命中过多输入的容器（整页包裹层）则继续降级 */
  function findBlocks() {
    for (const sel of BLOCK_SELECTORS) {
      let els;
      try {
        els = [...document.querySelectorAll(sel)];
      } catch {
        continue;
      }
      els = els
        .filter(isVisible)
        .filter((el) => el.querySelector('input, textarea, li, iframe')) // li/iframe：纯样式选项、iframe 富文本编辑器的题块
        .filter((el) => !els.some((o) => o !== el && o.contains(el)))
        .filter((el) => el.querySelectorAll('input, textarea').length <= 20);
      if (els.length) return els;
    }
    return [];
  }

  /* 单选/多选/判断：把块内输入按 name 聚成组（无 name 的同类型输入合为一组）。
     兼容隐藏 input 的站点（如超星）：input 不可见但其所属 label 可见时同样收录。 */
  function groupsIn(block) {
    const accepted = (inp) => {
      if (isVisible(inp)) return true;
      const lab = inp.closest('label');
      return !!(lab && isVisible(lab));
    };
    const mk = (type) => {
      const list = [...block.querySelectorAll(`input[type=${type}]`)].filter(accepted);
      if (!list.length) return [];
      const named = new Map();
      const anon = [];
      list.forEach((i) => (i.name ? named.set(i.name, [...(named.get(i.name) || []), i]) : anon.push(i)));
      const out = [...named.entries()].map(([name, inputs]) => ({ kind: type, name, inputs }));
      if (anon.length) out.push({ kind: type, name: null, inputs: anon });
      return out;
    };
    return [...mk('radio'), ...mk('checkbox')];
  }

  /* 超星判断题：选项文字可能没有"对/错"，用 <b class="ri">/<b class="wr"> 图标区分（OCS 脚本同款识别） */
  const judgeMark = (el) => {
    const b = el && el.querySelector && el.querySelector('b');
    if (!b) return null;
    if (b.classList.contains('ri')) return '对';
    if (b.classList.contains('wr')) return '错';
    return null;
  };

  function optionLabel(input) {
    const lab = input.closest('label');
    let t = lab ? norm(lab.textContent) : '';
    if (!t) t = norm((input.parentElement && input.parentElement.textContent) || input.value);
    return t;
  }

  /* 题干 = 题目块中第一个输入框之前的文本（天然排除选项文字） */
  function stemBefore(block, firstInput) {
    try {
      const range = document.createRange();
      range.setStart(block, 0);
      range.setEndBefore(firstInput);
      return norm(range.toString());
    } catch {
      return '';
    }
  }

  /* 填空/简答题干：整块文本，输入框位置替换为 ____ */
  function textWithBlanks(node) {
    let out = '';
    node.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) out += n.data;
      else if (n.nodeType === Node.ELEMENT_NODE) {
        if (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA') out += ' ____ ';
        else out += textWithBlanks(n);
      }
    });
    return out;
  }

  function stemOf(block, firstInput, { blanks }) {
    let stem = stemBefore(block, firstInput);
    if (stem.length < 4) stem = norm(block.querySelector(STEM_SELECTORS)?.textContent || '');
    if (stem.length < 4) stem = norm(textWithBlanks(block));
    return stem.slice(0, 500);
  }

  /* 块内可访问的 iframe 富文本编辑器（超星简答题用 UEditor：编辑区在 iframe 的 contenteditable body 里） */
  function richEditorsIn(block) {
    return [...block.querySelectorAll('iframe')].filter((f) => {
      if (!isVisible(f) || f.getBoundingClientRect().height < 40) return false;
      try {
        const d = f.contentDocument;
        if (!d || !d.body) return false;
        if (d.body.isContentEditable || (d.body.getAttribute('contenteditable') || '').toLowerCase() === 'true') return true;
        return !!d.querySelector('[contenteditable="true"], textarea');
      } catch {
        return false; // 跨域 iframe 不可访问
      }
    });
  }

  function extract() {
    // 超星专用适配器优先（答案状态从隐藏 answer input 读取，100% 可靠）
    if (window.HW.CXAdapter && window.HW.CXAdapter.match()) {
      const qs = window.HW.CXAdapter.extract();
      qs.forEach((q, i) => (q.meta.index = i));
      return qs;
    }
    const blocks = findBlocks();
    const questions = [];
    blocks.forEach((block) => {
      // —— 选择 / 判断 ——
      groupsIn(block).forEach((g) => {
        const firstInput = g.inputs[0];
        const labels = g.inputs.map((inp, idx) => {
          const mark = judgeMark(inp.closest('label') || inp.parentElement);
          return { key: LETTERS[idx], text: mark || optionLabel(inp), input: inp };
        });
        const plain = (t) => norm(t).replace(/^[A-Za-z]?[\s.、．:：)）]*/, '').trim();
        const isJudge =
          g.kind === 'radio' &&
          labels.length === 2 &&
          labels.some((l) => JUDGE_TRUE.test(plain(l.text))) &&
          labels.some((l) => JUDGE_FALSE.test(plain(l.text)));
        const stem = stemOf(block, firstInput, {});
        const meta = { type: isJudge ? 'judge' : g.kind === 'radio' ? 'choice' : 'multi', stem };
        meta.options = labels.map((l) => ({ key: l.key, text: l.text }));
        questions.push({ meta, el: { inputs: g.inputs, labels } });
      });

      // —— 兜底：无 input 的纯样式选项列表（部分站点只用 li + 点击事件） ——
      if (!block.querySelector('input[type=radio], input[type=checkbox]')) {
        // 超星等站点的答案状态载体：隐藏 answer input 的 value（"A"/"ABC"）
        const stateInput = block.querySelector(
          'input[type=hidden][name^="answer"]:not([name^="answertype"])',
        );
        const cands = [...block.querySelectorAll('ul, ol, div')].filter((c) => {
          const kids = [...c.children];
          return (
            kids.length >= 2 &&
            kids.length <= 10 &&
            kids.every((k) => /^[A-H](?=[\s.、．:：)）])/.test(norm(k.textContent)))
          );
        });
        const innermost = cands.filter((c) => !cands.some((o) => o !== c && c.contains(o)));
        innermost.forEach((c) => {
          const kids = [...c.children];
          const labels = kids.map((k, idx) => {
            const mark = judgeMark(k);
            return { key: LETTERS[idx], text: mark || norm(k.textContent), input: null, clickEl: k };
          });
          const plain = (t) => t.replace(/^[A-Za-z]?[\s.、．:：)）]*/, '').trim();
          const isJudge =
            labels.length === 2 &&
            labels.some((l) => JUDGE_TRUE.test(plain(l.text))) &&
            labels.some((l) => JUDGE_FALSE.test(plain(l.text)));
          // 超星题型编码（隐藏 answertype input）：0 单选 1 多选 2 填空 3 判断 4 简答——官方值优先于猜测
          const typeCode = (block.querySelector('input[type=hidden][name^="answertype"]') || {}).value;
          const typeByCode = { 0: 'choice', 1: 'multi', 3: 'judge' };
          const type = isJudge ? 'judge' : typeByCode[typeCode] || 'choice';
          let stem = '';
          try {
            const range = document.createRange();
            range.setStart(block, 0);
            range.setEndBefore(c);
            stem = norm(range.toString());
          } catch {
            /* setEndBefore 失败时走下面兜底 */
          }
          if (stem.length < 4) stem = norm(block.querySelector(STEM_SELECTORS)?.textContent || '');
          const meta = { type, stem: stem.slice(0, 500) };
          meta.options = labels.map((l) => ({ key: l.key, text: l.text }));
          questions.push({ meta, el: { inputs: [], labels, stateInput: stateInput || undefined } });
        });
      }

      // —— 填空（块内可见 text 输入，且不在选项 label 里） ——
      const textInputs = [...block.querySelectorAll('input')].filter((t) => {
        if (!(t.type === 'text' || !t.type)) return false;
        if (!isVisible(t)) return false;
        const lab = t.closest('label');
        return !(lab && lab.querySelector('input[type=radio], input[type=checkbox]'));
      });
      if (textInputs.length) {
        questions.push({
          meta: { type: 'blank', stem: norm(textWithBlanks(block)).slice(0, 500), blanks: textInputs.length },
          el: { inputs: textInputs, labels: [] }, // labels 统一存在（填空无选项）
        });
      }

      // —— 简答：优先 iframe 富文本编辑器（UEditor 类），否则每个 textarea 独立成题 ——
      const editors = richEditorsIn(block);
      if (editors.length) {
        editors.forEach((f, i) => {
          let stem = stemOf(block, f, {});
          if (editors.length > 1) stem = `${stem}（第${i + 1}小问）`;
          questions.push({ meta: { type: 'subjective', stem: stem.slice(0, 500) }, el: { inputs: [], iframe: f, labels: [] } });
        });
      } else {
        const tas = [...block.querySelectorAll('textarea')].filter(isVisible);
        tas.forEach((ta, i) => {
          const stem =
            tas.length === 1 ? stemOf(block, ta, {}) : `${stemOf(block, ta, {})}（第${i + 1}小问）`;
          questions.push({ meta: { type: 'subjective', stem: stem.slice(0, 500) }, el: { inputs: [ta], labels: [] } });
        });
      }
    });

    // 去重（同一输入被嵌套块重复提取时）
    const seen = new Set();
    const out = [];
    for (const q of questions) {
      const sig = [q.meta.type, q.el.inputs[0]?.name || '', q.meta.stem.slice(0, 40)].join('|');
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(q);
    }
    out.forEach((q, i) => (q.meta.index = i));
    return out;
  }

  /* 跳过判断只信硬证据：input.checked 或已学习的选中类。
     猜测性的 CSS 类（cur/check/on/active 等）不作为"已答"依据——
     超星等站点未选中的选项也可能带这些词，误判会让没答的题全部跳过。
     学习类由 filler 点击后 diff 选项 class 自动获得。 */
  function learnedHit(el) {
    if (!el) return false;
    let learned = null;
    try {
      learned = sessionStorage.getItem('hwSelClass:' + location.host);
    } catch {
      learned = null;
    }
    if (!learned) return false;
    const hit = (n) => n && n.classList && n.classList.contains(learned);
    return hit(el) || hit(el.closest && el.closest('li'));
  }
  function labelState(l) {
    return !!(l.input && l.input.checked) || learnedHit(l.clickEl) || learnedHit(l.input && l.input.closest('label'));
  }

  /* 已作答检测：页面上这道题是否已有答案（重跑时跳过已完成的题） */
  function isAnswered(q) {
    // 超星：可见选中标记优先（用户看到的即真相）
    if (q.el.stateInput && Array.isArray(q.el.labels) && q.el.labels.some((l) => l.clickEl && l.clickEl.querySelector('[class*="num_option"]'))) {
      return !!markerKeys(q);
    }
    // 其余：隐藏 answer input 的 value
    if (q.el.stateInput) return !!String(q.el.stateInput.value || '').trim();
    const t = q.meta.type;
    try {
      if (t === 'choice' || t === 'multi' || t === 'judge') {
        return q.el.labels.some(labelState);
      }
      if (t === 'blank') {
        return q.el.inputs.length > 0 && q.el.inputs.every((i) => norm(i.value));
      }
      if (t === 'subjective') {
        if (q.el.iframe) {
          const b = q.el.iframe.contentDocument && q.el.iframe.contentDocument.body;
          return !!b && norm(b.textContent).length > 0;
        }
        return !!norm(q.el.inputs[0] && q.el.inputs[0].value);
      }
    } catch {
      return false;
    }
    return false;
  }

  /* 超星：读取可见选中标记（字母圈上的 check_answer 类）——比隐藏 input 可靠（后者可能异步/陈旧） */
  function markerKeys(q) {
    const keys = [];
    const spans = (q.el.labels || []).map((l) => (l.clickEl && l.clickEl.querySelector('[class*="num_option"]')) || null).filter(Boolean);
    const selClass = spans.some((sp) => sp.classList.contains('check_answer_dx')) ? 'check_answer_dx' : 'check_answer';
    for (const l of q.el.labels || []) {
      if (l.clickEl && l.clickEl.hasAttribute && l.clickEl.hasAttribute('aria-checked')) {
        if (l.clickEl.getAttribute('aria-checked') === 'true') keys.push(l.key);
        continue;
      }
      const span = l.clickEl && l.clickEl.querySelector('[class*="num_option"]');
      if (span && span.classList.contains(selClass)) keys.push(l.key);
    }
    return keys.sort().join('');
  }

  /* 读取页面上已填的答案（用于与缓存答案比对） */
  function currentAnswer(q) {
    // 超星：可见选中标记优先（用户看到的即真相）；没有标记时才回退隐藏 input
    if (q.el.stateInput && Array.isArray(q.el.labels) && q.el.labels.some((l) => l.clickEl)) {
      return markerKeys(q);
    }
    const t = q.meta.type;
    const strip = (s) => norm(s).replace(/^[A-Za-z]?[\s.、．:：)）]*/, '');
    try {
      if (t === 'choice' || t === 'multi') {
        return q.el.labels
          .filter(labelState)
          .map((l) => l.key)
          .sort()
          .join('');
      }
      if (t === 'judge') {
        const picked = q.el.labels.find(labelState);
        return picked ? strip(picked.text) : '';
      }
      if (t === 'blank') return q.el.inputs.map((i) => norm(i.value)).filter(Boolean).join(';');
      if (t === 'subjective') {
        if (q.el.iframe) {
          const b = q.el.iframe.contentDocument && q.el.iframe.contentDocument.body;
          return b ? norm(b.textContent).slice(0, 80) : '';
        }
        return norm((q.el.inputs[0] && q.el.inputs[0].value) || '').slice(0, 80);
      }
    } catch {
      return '';
    }
    return '';
  }

  /* 题目签名：跨运行稳定（会话记录"本页已填过什么"用的键） */
  function sig(q) {
    return [q.meta.type, (q.el.inputs[0] && q.el.inputs[0].name) || '', q.meta.stem.slice(0, 40)].join('|');
  }

  HW.Extractor = { extract, isAnswered, currentAnswer, sig };
})();
