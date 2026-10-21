/* 页面结构采集与 AI 结果绑定。元素引用只留在内容脚本中，不交给模型操作。 */
(function () {
  'use strict';
  const HW = (window.HW = window.HW || {});
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const esc = (s) => String(s).replace(/[&<>"\n]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\n': ' ' }[c]));
  const OMIT = 'script,style,noscript,nav,footer,[role="navigation"],[role="banner"],[role="search"],#hw-panel-host,.newTopic1,#posDiscussScroll,#searchChapterListByName';
  const TYPES = new Set(['choice', 'multi', 'judge', 'blank', 'subjective']);
  function sharedOptions(el) {
    if (!el.matches?.('.B-answerCon')) return null;
    const root = el.closest('.TiMu');
    if (!root) return null;
    const words = new Map([...root.querySelectorAll('.mark_letter > li')].map((li) => {
      const match = norm(li.textContent).match(/^([A-Z])[.、．]\s*(.+)$/);
      return match ? [match[1], match[1] + '. ' + match[2]] : [];
    }).filter((entry) => entry.length));
    const spans = [...el.querySelectorAll('label > span.num_option[data]')];
    if (spans.length < 2 || spans.length > 26 || new Set(spans.map((span) => span.getAttribute('data'))).size !== spans.length ||
        spans.some((span) => !words.has(span.getAttribute('data')))) return null;
    return spans.map((span) => ({ text: words.get(span.getAttribute('data')), clickEl: span }));
  }
  const visible = (el) => {
    if (!el || !el.isConnected || el.hidden) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && !!el.getClientRects().length;
  };
  const isEditor = (el) => {
    try { return !!el.contentDocument?.body?.isContentEditable; } catch { return false; }
  };

  function collect() {
    const refs = new Map();
    const ids = new WeakMap();
    const documents = new Set([document]);
    const root = [...document.querySelectorAll('main,[role="main"]')].find(visible) || document.body;
    let seq = 0;
    let total = 0;
    const walk = (el) => {
      // 超星题干 <h3 class="mark_name"> 自带 aria-hidden="true" 却视觉可见，不能按 aria-hidden 过滤。
      if (el.matches(OMIT) || el.closest('[hidden]')) return null;
      if (el.matches('form') && el.querySelector('input[type="password"]')) return null;
      const native = el.matches('input,textarea,select');
      // 不采集表单值、密码或账号字段。隐藏字段仅在本地绑定时用于读取站点答案状态。
      if (native && ((el.tagName === 'INPUT' && !['radio', 'checkbox', 'text', 'number', 'file'].includes(el.type)) ||
          /password|token|secret|api.?key|username|account|email|phone|mobile/i.test(el.name + ' ' + el.id + ' ' + el.autocomplete))) return null;
      const hiddenChoice = el.matches('input[type="radio"],input[type="checkbox"]') &&
        (visible(el.closest('label')) || [...(el.labels || [])].some(visible));
      if (!visible(el) && !hiddenChoice) return null;
      // 超星填空框点击后才显示编辑器，且同一时间只展开一空；可见宿主对应的编辑器仍可填写。
      const lazyEditor = el.matches('.blankItemInp') ? el.querySelector('iframe') : null;
      const editor = lazyEditor && isEditor(lazyEditor) ? lazyEditor : null;
      const id = 'e' + (++seq);
      ids.set(el, id);
      if (editor) ids.set(editor, id);
      if (seq > 12000) throw new Error('页面结构过多，请收起无关内容后重新检测');
      let kind = '';
      if (el.matches('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"],.answerBg') ||
          (el.matches('label') && !el.querySelector('input:not([type="radio"]):not([type="checkbox"]),textarea'))) kind = 'option';
      else if (el.matches('input[type="file"],[draggable="true"]')) kind = 'unsupported';
      else if (el.matches('select') || sharedOptions(el)) kind = 'select';
      else if (el.matches('input,textarea')) kind = 'text';
      else if (el.isContentEditable) kind = 'editable';
      else if (editor || (el.tagName === 'IFRAME' && isEditor(el))) kind = 'editor';
      else if (!el.matches('a,button,select,option') && !el.querySelector('input,textarea,[contenteditable="true"]')) {
        // 重复兄弟节点可作为选项候选；这里只提供位置，是否为选项由 AI 判断。
        const siblings = el.parentElement?.children;
        const text = norm(el.textContent);
        if (siblings?.length >= 2 && siblings.length <= 12 && text && text.length <= 1200 &&
            !/^[A-H][.、．:：)）]?$/.test(text) && !el.querySelector('ul,ol,fieldset,section,article,h1,h2,h3,h4,h5,h6,form') &&
            ![...el.children].some((c) => c.matches('div,li') && c.children.length > 1)) kind = 'option';
      }
      if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true') kind = '';
      if (el.tagName === 'IFRAME' && kind !== 'editor') {
        try { if (!el.contentDocument?.body) kind = 'unavailable'; } catch { kind = 'unavailable'; }
      }
      const attrs = [`ref="${id}"`];
      if (kind) attrs.push(`kind="${kind}"`);
      for (const name of ['role', 'type', 'typename', 'aria-label']) {
        const v = el.getAttribute(name);
        if (v) attrs.push(`${name}="${esc(v.slice(0, 120))}"`);
      }
      // 超星编号和题型编码只作为额外上下文，不据此决定识别结果。
      const cxId = (el.id || '').replace(/^question/, '');
      if (el.matches('.questionLi')) {
        const code = el.querySelector(`input[name="answertype${CSS.escape(cxId)}"]`)?.value;
        if (code) attrs.push(`type-hint="${esc(code)}"`);
      }
      const truth = el.getAttribute('data');
      if (/^(true|false)$/i.test(truth || '')) attrs.push(`truth-hint="${truth.toLowerCase()}"`);
      if (el.matches('b.ri,b.wr')) attrs.push(`truth-hint="${el.matches('b.ri') ? 'true' : 'false'}"`);
      const tag = el.tagName.toLowerCase();
      const open = `<${tag} ${attrs.join(' ')}>`;
      const close = `</${tag}>`;
      const children = [];
      if (kind === 'select') {
        // 只提供可选文字，不提供当前答案或站点内部 value。
        for (const option of sharedOptions(el) || [...el.options].filter((o) => !o.disabled && o.value !== '')) {
          children.push('<option>' + esc(option.text || norm(option.textContent)) + '</option>');
        }
        if (el.multiple) children.push('（多选下拉控件，尚不支持填写）');
      } else if (el.tagName === 'IFRAME' && kind !== 'editor') {
        try {
          const doc = el.contentDocument;
          if (doc?.body) {
            documents.add(doc);
            const tree = walk(doc.body);
            if (tree) children.push(tree);
          } else children.push('（此嵌入区域无法读取，待确认）');
        } catch { children.push('（此嵌入区域无法读取，待确认）'); }
      } else if (!native && !el.isContentEditable && kind !== 'editor') {
        for (const child of el.childNodes) {
          if (child.nodeType === 3) {
            const text = norm(child.data);
            if (text) children.push(esc(text));
          } else if (child.nodeType === 1) {
            const tree = walk(child);
            if (tree) children.push(tree);
          }
        }
      }
      if (kind === 'editor') documents.add((editor || el).contentDocument);
      if (el.tagName === 'IMG') children.push(el.alt ? esc(norm(el.alt)) : '（图片内容未读取）');
      const body = children.map((c) => typeof c === 'string' ? c : c.full).join(' ');
      const full = open + body + close;
      total += open.length + close.length + children.filter((c) => typeof c === 'string').join('').length;
      if (total > 240000) throw new Error('页面内容过多，请收起无关内容后重新检测');
      refs.set(id, { el: editor || el, kind, markup: full });
      return { open, close, children, full };
    };
    const tree = walk(root);
    if (!tree) throw new Error('没有可读取的作业区域，请展开题目后重新检测');
    // 优先整块保留；特别长的容器沿子树切分，每批携带祖先编号和相邻内容。
    const pieces = [];
    const split = (node, ancestors = '') => {
      if (typeof node === 'string') {
        if (node.length > 12000) throw new Error('单段题目过长，无法完整识别，请分段展开后重新检测');
        pieces.push(ancestors + '\n' + node);
      } else if ((ancestors + node.full).length <= 12000) pieces.push(ancestors + '\n' + node.full);
      else {
        const prefix = ancestors + node.open + '\n';
        if (prefix.length > 3000) throw new Error('页面嵌套过深，无法可靠定位题目');
        node.children.forEach((c) => split(c, prefix));
      }
    };
    split(tree);
    const batches = [];
    let batch = '';
    let previous = '';
    for (const piece of pieces) {
      if (batch && batch.length + piece.length + 2 > 14000) {
        batches.push(batch);
        batch = previous.length < 4000 ? previous : '';
      }
      batch += '\n' + piece;
      previous = piece;
    }
    if (batch.trim()) batches.push(batch);
    if (batches.length > 40) throw new Error('页面题目过多，请分批展开后重新检测');
    return { refs, ids, batches, documents, signature: tree.full, url: location.href };
  }

  function isCurrent(snapshot) {
    try {
      if (!snapshot || snapshot.url !== location.href) return false;
      const current = collect();
      const controls = (s) => [...s.refs.values()].filter(({ el, kind }) => ['text', 'editable', 'editor', 'select', 'unsupported'].includes(kind) ||
        el.matches('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"],.answerBg')).map(({ el }) => el);
      const before = controls(snapshot);
      const now = new Set(controls(current));
      if (before.length !== now.size || before.some((el) => !now.has(el))) return false;
      if (snapshot.carriers?.some((el) => !el.isConnected)) return false;
      if (snapshot.scopeIds?.size) {
        // 只比较实际题目区域，页面其他位置的时钟等内容变化不使答案位置失效。
        const stripRefs = (text) => text.replace(/ ref="e\d+"/g, '');
        return [...snapshot.scopeIds].every((id) => {
          const ref = snapshot.refs.get(id);
          const next = ref && current.refs.get(current.ids.get(ref.el));
          return !!next && next.el === ref.el && stripRefs(next.markup) === stripRefs(ref.markup);
        });
      }
      return current.signature === snapshot.signature && [...snapshot.refs].every(([id, ref]) => current.refs.get(id)?.el === ref.el);
    } catch { return false; }
  }

  function bind(snapshot, items) {
    if (!Array.isArray(items)) throw new Error('AI 返回的题目列表格式错误，请重新检测');
    snapshot.scopeIds = new Set(items.flatMap((q) => [q.containerId, ...(q.contextIds || []), ...(q.inputIds || []), ...(q.options || []).map((o) => o.targetId)])
      .filter((id) => snapshot.refs.has(id)));
    if (!isCurrent(snapshot)) throw new Error('页面已变化，请重新检测题目');
    const ready = new Map();
    const pending = [];
    const pendingKeys = new Set();
    const pendingRoots = [];
    const occupied = new Map();
    const blocked = new Set();
    const addPending = (item, reason) => {
      const key = (item.containerId || '') + '|' + item.stem;
      if (!pendingKeys.has(key)) {
        pendingKeys.add(key);
        pending.push({ stem: item.stem, reason: reason || '题型或答题位置无法确认' });
        const root = snapshot.refs.get(item.containerId)?.el;
        if (root) {
          pendingRoots.push(root);
          snapshot.scopeIds.add(item.containerId);
        }
      }
    };
    for (const item of items) {
      try {
        if (!TYPES.has(item.type)) throw new Error(item.reason || '暂不支持此题型或题目资料不完整');
        const container = snapshot.refs.get(item.containerId)?.el;
        if (!container) throw new Error('AI 返回的题目容器不存在');
        if ([...container.querySelectorAll('img')].some((img) => !norm(img.alt))) throw new Error('题目包含尚未读取的图片内容，需要人工确认');
        if (container.querySelector('input[type="file"],[draggable="true"],select[multiple]')) throw new Error('题目包含上传、拖拽或多选下拉控件，尚不能可靠填写');
        const context = (item.contextIds || []).map((id) => {
          const el = snapshot.refs.get(id)?.el;
          if (!el || el.matches('input,textarea,select,iframe,[contenteditable]') || el.querySelector('input,textarea,select,iframe,[contenteditable]')) throw new Error('共享材料区域不存在或混入了答题控件');
          if ([...el.querySelectorAll('img')].some((img) => !norm(img.alt))) throw new Error('共享材料包含尚未读取的图片内容');
          return norm(el.innerText || el.textContent);
        }).filter(Boolean).filter((text) => !norm(item.stem).includes(text)).join('\n');
        const stem = context ? context + '\n' + item.stem : item.stem;
        if (stem.length > 12000) throw new Error('材料与子题内容过长，请分段确认');
        const get = (id, kinds) => {
          const ref = snapshot.refs.get(id);
          if (!ref || !kinds.includes(ref.kind)) throw new Error('AI 返回的答题位置不存在或不可填写');
          let el = ref.el;
          // 同源 iframe 的控件通过宿主 iframe 回溯至题目容器。
          while (el && el.ownerDocument !== container.ownerDocument) el = el.ownerDocument.defaultView.frameElement;
          if (!el || !container.contains(el)) throw new Error('AI 混用了不同题目的答题位置');
          return ref.el;
        };
        const labels = [];
        const inputs = [];
        const iframes = [];
        const fields = [];
        const targetIds = [];
        if (['choice', 'multi', 'judge'].includes(item.type)) {
          if (item.inputIds.length || item.options.length < 2 || item.options.length > 8) throw new Error('选项数量或答题位置无法确认');
          for (const option of item.options) {
            const validKey = item.type === 'judge' ? /^[TF]$/ : /^[A-H]$/;
            if (!validKey.test(option.key)) throw new Error('选项编号无效');
            const candidate = get(option.targetId, ['option']);
            const row = candidate.closest('.answerBg,[role="radio"],[role="checkbox"]');
            const el = row && container.contains(row) ? row : candidate;
            const native = el.matches('input[type="radio"],input[type="checkbox"]') ? el : el.control || el.querySelector('input[type="radio"],input[type="checkbox"]');
            if (native && (native.disabled || (item.type === 'multi' ? native.type !== 'checkbox' : native.type !== 'radio'))) throw new Error('题型与页面选项控件不一致');
            const clickEl = el.matches('input') ? null : el;
            let text = norm((native?.closest('label') || native?.labels?.[0] || el).textContent);
            const pageKey = norm(el.querySelector('[class*="num_option"]')?.textContent) || text.match(/^([A-H])[.、．:：)）\s]+/)?.[1];
            if (item.type !== 'judge' && /^[A-H]$/.test(pageKey || '') && option.key !== pageKey) throw new Error('AI 返回的选项编号与页面不一致');
            if (item.type === 'judge') {
              const mark = el.querySelector('[data="true"],[data="false"],b.ri,b.wr') || el;
              const truth = mark.getAttribute('data');
              if (truth === 'true' || mark.matches('b.ri')) text = '对';
              else if (truth === 'false' || mark.matches('b.wr')) text = '错';
              else if (!/^(?:[A-H][.、．:：)）\s]*)?(对|错|正确|错误|是|否|真|假|true|false|T|F|√|×)$/i.test(text)) throw new Error('判断题真值无法确认');
              const plain = text.replace(/^[A-H][.、．:：)）\s]+/, '');
              const key = /^(对|正确|是|真|true|T|√)$/i.test(plain) ? 'T' : 'F';
              if (option.key !== key) throw new Error('AI 返回的判断题真值与页面不一致');
              text = key === 'T' ? '对' : '错';
            }
            labels.push({ key: option.key, text, input: native, clickEl });
            targetIds.push(snapshot.ids.get(native || el));
          }
          if (new Set(labels.map((l) => l.key)).size !== labels.length) throw new Error('选项编号重复');
          for (let i = 0; i < labels.length; i++) {
            const a = labels[i].clickEl || labels[i].input;
            if (labels.some((l, j) => j !== i && (a.contains(l.clickEl || l.input) || (labels[i].input && labels[i].input === l.input)))) throw new Error('选项位置重复或相互嵌套');
          }
        } else {
          if (item.options.length || !item.inputIds.length || (item.type === 'subjective' && item.inputIds.length !== 1)) throw new Error('文本答题位置数量无法确认');
          for (const id of item.inputIds) {
            const el = get(id, item.type === 'blank' ? ['text', 'editable', 'editor', 'select'] : ['text', 'editable', 'editor']);
            fields.push(el);
            if (el.tagName === 'IFRAME') iframes.push(el);
            else inputs.push(el);
            targetIds.push(id);
          }
          if (targetIds.some((id, i) => i && Number(id.slice(1)) <= Number(targetIds[i - 1].slice(1)))) throw new Error('填空位置顺序与页面不一致');
        }
        if (new Set(targetIds).size !== targetIds.length) throw new Error('答题位置重复');
        const targetEls = targetIds.map((id) => snapshot.refs.get(id)?.el);
        const groups = targetEls.map((el) => el.closest('.questionLi,.TiMu,.mark_item') || el.closest('fieldset,[role="group"],[role="radiogroup"],section,article'));
        if (groups.some(Boolean) && new Set(groups).size > 1) throw new Error('答题位置属于不同的题目区域');
        const radios = labels.map((l) => l.input).filter((el) => el?.type === 'radio');
        if (radios.length && (new Set(radios.map((el) => el.name)).size > 1 || new Set(radios.map((el) => el.form)).size > 1)) throw new Error('选项属于不同的单选组');
        const key = [...targetIds].sort().join('|');
        const existing = ready.get(key);
        if (existing && existing.meta.type === item.type && norm(existing.meta.stem) === norm(stem)) continue;
        const conflict = targetIds.map((id) => occupied.get(id)).find(Boolean);
        if (conflict || targetIds.some((id) => blocked.has(id))) {
          if (conflict) {
            const old = ready.get(conflict);
            if (old) {
              addPending({ stem: old.meta.stem }, '不同识别结果占用了同一答题位置，请重新检测');
              old._targetIds.forEach((id) => blocked.add(id));
              ready.delete(conflict);
            }
          }
          targetIds.forEach((id) => blocked.add(id));
          throw new Error('不同题目占用了同一答题位置，请重新检测');
        }
        const firstTarget = snapshot.refs.get(targetIds[0])?.el;
        const cx = firstTarget?.closest('.questionLi');
        const stateInput = cx && targetIds.every((id) => snapshot.refs.get(id)?.el.closest('.questionLi') === cx) &&
          (!labels.length || labels.every((l) => l.clickEl?.matches('.answerBg')))
          ? cx.querySelector('input[type="hidden"][name^="answer"]:not([name^="answertype"])') : null;
        const q = {
          meta: { type: item.type, stem: fields.some((el) => sharedOptions(el))
              ? norm(container.querySelector('.Zy_TItle')?.innerText) + '\n' + stem : stem,
            writing: item.writing, blanks: item.type === 'blank' ? targetIds.length : 0,
            options: labels.map((l) => ({ key: l.key, text: l.text })),
            slotOptions: item.type === 'blank' ? fields.map((el) => el.tagName === 'SELECT'
              ? [...el.options].filter((o) => !o.disabled && o.value !== '').map((o) => norm(o.textContent))
              : (sharedOptions(el) || []).map((o) => o.text)) : [] },
          el: { inputs, labels, stateInput, fields: item.type === 'blank' ? fields : [], iframes: item.type === 'blank' ? iframes : [], iframe: item.type === 'subjective' ? iframes[0] : null },
          _targetIds: targetIds,
        };
        ready.set(key, q);
        targetIds.forEach((id) => occupied.set(id, key));
      } catch (e) { addPending(item, e.message); }
    }
    // AI 可能遗漏题目：真实答题控件仍未归属时，明确保留为待确认区域。
    for (const [id, { el, kind }] of snapshot.refs) {
      if (kind === 'unavailable' || kind === 'unsupported') {
        addPending({ containerId: id, stem: kind === 'unavailable' ? '无法读取的嵌入区域' : '尚不支持的答题控件' }, kind === 'unavailable' ? '此区域不可读取，需要人工确认' : '此区域尚不能可靠填写，需要人工确认');
        continue;
      }
      if (!['text', 'editable', 'editor', 'select'].includes(kind) && !el.matches('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]')) continue;
      if (occupied.has(id) || blocked.has(id) || pendingRoots.some((r) => r.contains(el))) continue;
      const container = el.closest('.questionLi,fieldset,section,article,[role="group"]') || el.parentElement;
      addPending({ containerId: snapshot.ids.get(container), stem: '尚未识别的答题区域' }, 'AI 未能识别此答题区域，请重新检测或导出页面结构');
    }
    const questions = [...ready.values()];
    snapshot.carriers = questions.map((q) => q.el.stateInput).filter(Boolean);
    questions.sort((a, b) => Number(a._targetIds[0].slice(1)) - Number(b._targetIds[0].slice(1)));
    questions.forEach((q, i) => { q.meta.index = i; delete q._targetIds; });
    return { questions, pending };
  }

  HW.AIDetection = { collect, bind, isCurrent, sharedOptions };
})();
