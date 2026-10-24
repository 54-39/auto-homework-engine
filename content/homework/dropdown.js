/* 自绘下拉（listbox）：原生 select 的展开层由系统绘制，插件 CSS 改不到，所以面板与设置页
   的「引擎 / 接口类型」共用这一份实现。两处硬约束（都是本项目踩过的坑）：
   1) 弹层挂在面板的 overflow:hidden 之外——与 .tip 一样挂在 Shadow 根上，否则被裁掉；
   2) 面板 .panel.expanded 有 transform，会改 fixed 子元素的定位基准——弹层不能放进 .panel 里。
   用法：HW.Dropdown.create({ into, items:[{id,label}], value, onChange }) → { value, label, close, el }
   返回对象故意长得像原生 select（value 可读写），调用方其余代码不用改。
   列表项只放名称，不放说明文字：说明要么与控件下方的说明行重复，要么是整段话——塞进列表就是臃肿。 */
(function () {
  'use strict';
  const HW = (window.HW = window.HW || {});
  if (HW.Dropdown) return;

  const CSS = `
    .dd{position:relative;flex:1;min-width:0;width:100%}
    .ddtrig{display:flex;align-items:center;gap:6px;width:100%;height:var(--dd-h,30px);padding:0 10px;border:1px solid var(--dd-line,#E3E8EF);
      border-radius:var(--dd-radius,6px);background:#fff;color:#111827;font:inherit;font-size:var(--dd-font,12px);font-weight:500;cursor:pointer;text-align:left}
    .ddtrig:hover{border-color:#C7D0DB;background:#fff;color:#111827}
    .ddtrig:active{background:#F3F4F6;color:#111827}
    .ddtrig:focus-visible,.ddtrig[aria-expanded="true"]{border-color:#64748B;outline:none;box-shadow:none}
    .ddtrig:disabled,.ddtrig:disabled:hover{background:#EEF1F5;color:#6B7480;border-color:var(--dd-line,#E3E8EF);cursor:not-allowed}
    .ddname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    /* 箭头用边框画三角：Unicode 字形（▾）在不同字体下大小和基线都不受控 */
    .ddcaret{flex:none;width:0;height:0;border:4px solid transparent;border-top-color:#6B7280;transition:transform .15s ease}
    .ddtrig[aria-expanded="true"] .ddcaret{border-top-color:#4B5563;transform:rotate(180deg)}
    .ddlist{position:fixed;z-index:2147483647;min-width:180px;max-width:320px;max-height:264px;overflow-y:auto;overscroll-behavior:contain;padding:4px;background:#fff;
      border:1px solid #E3E8EF;border-radius:calc(var(--dd-radius,6px) + 4px);
      box-shadow:0 6px 16px -8px rgba(15,23,42,.20),0 1px 3px -1px rgba(15,23,42,.08)}
    .ddlist.hidden{display:none}
    /* 悬停/键盘高亮用浅灰，选中项用较深灰底与加粗，悬停已选项时保持原样。 */
    .ddopt{padding:6px 8px;border-radius:var(--dd-radius,6px);cursor:pointer;font-size:var(--dd-font,12px);font-weight:500;color:#111827;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ddopt.hot{background:#F3F4F6}
    .ddopt[aria-selected="true"]{background:#E5E7EB;font-weight:600}
    @media (prefers-reduced-motion:reduce){.ddcaret{transition:none}}
  `;

  const styled = new WeakSet();
  const byRoot = new WeakMap(); // 同一个根里同时只允许开一个弹层
  let seq = 0;

  function create({ into, items, value, onChange }) {
    const root = into.getRootNode();
    if (!styled.has(root)) {
      styled.add(root);
      const s = document.createElement('style');
      s.textContent = CSS;
      (root === document ? document.head : root).appendChild(s);
    }
    const popupParent = root === document ? document.body : root;
    let cur = items.some((i) => i.id === value) ? value : items[0].id; // 脏值/缺省都落到第一项，控件不会变空
    let hot = null;

    const trig = document.createElement('button');
    trig.type = 'button';
    trig.className = 'ddtrig';
    trig.setAttribute('aria-haspopup', 'listbox');
    trig.setAttribute('aria-expanded', 'false');
    const name = document.createElement('span');
    name.className = 'ddname';
    const caret = document.createElement('span');
    caret.className = 'ddcaret'; // 箭头由 CSS 边框画，别塞字形进来
    trig.append(name, caret);
    into.appendChild(trig);

    const list = document.createElement('div');
    list.className = 'ddlist hidden';
    list.setAttribute('role', 'listbox');
    const opts = items.map((it) => {
      const o = document.createElement('div');
      o.className = 'ddopt';
      o.id = 'ddopt-' + ++seq;
      o.dataset.id = it.id;
      o.setAttribute('role', 'option');
      o.textContent = it.label; // 单行：说明文字放控件下方，不进列表
      o.addEventListener('mousedown', (e) => e.preventDefault()); // 别让焦点离开触发器，键盘流程才不断
      o.addEventListener('click', () => pick(it.id));
      o.addEventListener('mouseenter', () => setHot(o));
      list.appendChild(o);
      return o;
    });
    popupParent.appendChild(list);

    const optFor = (id) => opts.find((o) => o.dataset.id === id) || opts[0];
    const label = (id) => (items.find((i) => i.id === id) || items[0]).label;
    const render = () => {
      name.textContent = label(cur);
      opts.forEach((o) => o.setAttribute('aria-selected', String(o.dataset.id === cur)));
    };

    // 用 aria-activedescendant 而不是移动真实焦点：焦点始终留在触发器上，关闭时机只需管触发器
    function setHot(o, scrollIntoView = false) {
      if (!o) return;
      opts.forEach((x) => x.classList.toggle('hot', x === o));
      hot = o;
      trig.setAttribute('aria-activedescendant', o.id);
      if (scrollIntoView && (o.offsetTop < list.scrollTop || o.offsetTop + o.offsetHeight > list.scrollTop + list.clientHeight)) {
        list.scrollTop = o.offsetTop - list.clientHeight / 2 + o.offsetHeight / 2;
      }
    }

    function place() {
      const r = trig.getBoundingClientRect();
      list.style.minWidth = Math.round(r.width) + 'px';
      const lr = list.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 8;
      const flip = lr.height > below && r.top - 8 > below; // 下方放不下且上方更宽裕就向上翻
      list.style.left = Math.max(8, Math.min(r.left, window.innerWidth - lr.width - 8)) + 'px';
      list.style.top = (flip ? Math.max(8, r.top - lr.height - 6) : r.bottom + 6) + 'px';
    }

    function onScroll(event) {
      const path = event.composedPath ? event.composedPath() : [event.target];
      if (!path.includes(list)) close(); // 菜单内部滚动不关闭；页面或外层容器滚动时仍收起。
    }

    function close() {
      if (list.classList.contains('hidden')) return;
      list.classList.add('hidden');
      trig.setAttribute('aria-expanded', 'false');
      trig.removeAttribute('aria-activedescendant');
      hot = null;
      opts.forEach((o) => o.classList.remove('hot'));
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
      if (byRoot.get(root) === close) byRoot.delete(root);
    }

    function open() {
      if (!list.classList.contains('hidden')) return;
      const prev = byRoot.get(root);
      if (prev && prev !== close) prev();
      list.classList.remove('hidden');
      trig.setAttribute('aria-expanded', 'true');
      render();
      setHot(optFor(cur), true);
      place();
      byRoot.set(root, close);
      window.addEventListener('resize', close);
      window.addEventListener('scroll', onScroll, true);
    }

    function pick(id) {
      close();
      trig.focus();
      if (id === cur) return; // 与原生一致：选中同一项不触发 change
      cur = id;
      render();
      if (onChange) onChange(id);
    }

    trig.addEventListener('click', () => (list.classList.contains('hidden') ? open() : close()));
    trig.addEventListener('keydown', (e) => {
      const opened = !list.classList.contains('hidden');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!opened) return open();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setHot(opts[(opts.indexOf(hot) + step + opts.length) % opts.length], true);
      } else if (opened && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        pick(hot ? hot.dataset.id : cur);
      } else if (opened && e.key === 'Escape') {
        e.preventDefault();
        close(); // 焦点没动过，天然留在触发器上
      } else if (e.key === 'Tab') {
        close();
      }
    });
    // 点击控件之外关闭：composedPath 才能看穿 Shadow DOM（面板在 shadow 里）
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (list.classList.contains('hidden')) return;
        const path = e.composedPath ? e.composedPath() : [e.target];
        if (path.includes(trig) || path.includes(list)) return;
        close();
      },
      true,
    );

    render();
    return {
      el: into,
      close,
      get value() {
        return cur;
      },
      set value(v) {
        if (items.some((i) => i.id === v)) {
          cur = v;
          render();
        }
      },
      get label() {
        return label(cur);
      },
    };
  }

  HW.Dropdown = { create };
})();
