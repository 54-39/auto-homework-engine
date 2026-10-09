/* 悬浮控制面板：Shadow DOM 隔离样式，注入到作业页面右下角。
   视觉按 Pixso 设计稿「悬浮控制面板」落地：无图标、纯文字、浅色渐变卡片。 */
(function () {
  'use strict';
  const HW = (window.HW = window.HW || {});

  const CSS = `
    :host{all:initial;color-scheme:light;scrollbar-color:#C7D0DB transparent;scrollbar-width:thin}
    *{box-sizing:border-box;font:12px/1.5 system-ui,'Microsoft YaHei','PingFang SC',sans-serif}
    /* 浏览器自带表面跟随面板主题：选中态、键盘焦点环、滚动条（原生 Windows 样式与浅色卡片不搭） */
    ::selection{background:#DBE6FD;color:#111827}
    :focus-visible:not(input){outline:2px solid #2563EB;outline-offset:2px}
    .fab{position:fixed;right:24px;bottom:24px;width:56px;height:56px;border-radius:50%;background:#2563EB;border:1px solid rgba(255,255,255,.35);color:#fff;
      display:flex;align-items:center;justify-content:center;font-size:24px;cursor:pointer;user-select:none;
      box-shadow:0 6px 14px -2px rgba(15,23,42,.16);z-index:2147483646}
    .fab:hover{background:#1d4ed8}
    .panel{position:fixed;right:24px;bottom:96px;width:360px;height:min(72vh,620px);overflow:hidden;transition:height .15s ease;display:flex;flex-direction:column;gap:8px;padding:14px;
      border-radius:14px;z-index:2147483646;color:#111827;
      background:
        radial-gradient(circle 300px,rgba(37,99,235,.10),rgba(37,99,235,0) 70%) right -40px top -40px / 600px 600px no-repeat,
        radial-gradient(circle 260px,rgba(96,165,250,.08),rgba(96,165,250,0) 70%) left -40px bottom -40px / 520px 520px no-repeat,
        linear-gradient(180deg,#FFFFFF 0%,#F6F8FD 50%,#EAEFF8 100%);
      box-shadow:0 16px 36px -8px rgba(15,23,42,.08),0 2px 6px -2px rgba(15,23,42,.06),inset 0 0 0 1px rgba(255,255,255,.9)}
    .hidden{display:none!important}
    .tip{position:fixed;z-index:2147483647;max-width:230px;padding:6px 9px;border-radius:8px;background:#fff;border:1px solid #E3E8EF;color:#374151;font-size:11px;line-height:1.5;
      box-shadow:0 10px 24px -8px rgba(15,23,42,.22),0 2px 6px -2px rgba(15,23,42,.08);pointer-events:none}
    .panel.apiopen{height:min(calc(72vh + 190px), calc(100vh - 108px))}
    header{display:flex;align-items:center;gap:6px;cursor:move;user-select:none;flex:none;min-height:22px}
    header b{font-size:15px;font-weight:700;color:#111827}
    .badge{font-size:11px;color:#2563EB;background:#E8EFFD;border-radius:4px;padding:2px 7px;font-weight:500}
    .spacer{flex:1}
    .tbtn{border:0;background:none;cursor:pointer;font-size:12px;color:#6B7280;padding:0 2px;flex:none}
    .tbtn:hover{color:#111827}
    .row{display:flex;gap:8px;align-items:center;flex:none}
    .row label{display:flex;flex:1;align-items:center;gap:8px;font-size:12px;color:#374151;font-weight:500;min-width:0}
    select{flex:1;min-width:0;height:30px;padding:0 10px;border:1px solid #E3E8EF;border-radius:6px;font-size:12px;font-weight:500;color:#111827;background:#fff}
    .hintline{font-size:11px;color:#9AA1A9;flex:none}
    .updline{flex:none;font-size:11px;font-weight:500;color:#2563EB;cursor:pointer}
    .updline:hover{color:#1d4ed8}
    .apitoggle{border:0;background:none;cursor:pointer;font-size:11.5px;color:#374151;font-weight:500;padding:2px 0;text-align:left;flex:none;align-self:flex-start}
    .apitoggle:hover{color:#111827}
    .apisec{display:flex;flex-direction:column;gap:8px;flex:none}
    .provrow{border:1px solid #DBE6FF;background:#F5F8FF;border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:4px;flex:none}
    .provtop{display:flex;align-items:center;gap:8px}
    .provtop label{font-size:12px;color:#374151;font-weight:500;flex:none}
    .psource{font-size:11px;color:#9AA1A9}
    .keyrow{display:flex;gap:8px;align-items:center;flex:none}
    .inputGroup{flex:1;min-width:0;position:relative}
    .inputGroup input{width:100%;height:36px;padding:0 14px;outline:none;caret-color:#2563EB;border:2px solid rgb(200,200,200);border-radius:20px;background:#fff;color:#111827;font-size:12px;transition:border-color .18s ease,box-shadow .18s ease}
    .inputGroup input::placeholder{color:transparent}
    .inputGroup :is(input:focus,input:valid){border-color:rgb(150,150,200)}
    .inputGroup input:focus{border-color:#2563EB;box-shadow:0 0 0 3px rgba(37,99,235,.16)}
    .inputGroup label{position:absolute;left:0;top:50%;transform:translateY(-50%);margin-left:14px;padding:0 6px;pointer-events:none;transition:top .18s ease,transform .18s ease,background-color .18s ease,color .18s ease;color:#646464;font-size:12px;white-space:nowrap;background:transparent}
    .inputGroup :is(input:focus,input:valid)~label{top:0;transform:translateY(-50%) scale(.82);margin-left:16px;padding:0 6px;background:#fff}
    .lbtn{border:0;background:none;cursor:pointer;font-size:12px;padding:0 2px;flex:none}
    .lbtn.primary{color:#2563EB;font-weight:500}
    .lbtn.plain{color:#6B7280}
    .keylist{display:flex;flex-direction:column;gap:6px;max-height:100px;overflow:auto;flex:none}
    .keylist.off{opacity:.55;pointer-events:none}
    .krow{display:flex;align-items:center;gap:8px;border-radius:6px;border:1px solid #CCD2D9;background:#fff;padding:6px 10px;min-height:46px}
    .krow.active{background:#ECFDF5;border-color:#A7F3D0}
    .kmain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
    .kstat{font-size:11px;font-weight:500;color:#374151;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .krow.active .kstat{color:#059669}
    .kmeta{font-size:10.5px;color:#6B7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .kbtn{border:0;background:none;cursor:pointer;font-size:11px;padding:0 2px;flex:none;color:#2563EB;font-weight:500}
    .kbtn.del{color:#6B7280;font-weight:400}
    .kbtn:disabled{color:#C0C6CD;cursor:not-allowed}
    .keywarn{color:#DC2626;font-size:11.5px;font-weight:600;flex:none}
    .btnrow{display:flex;gap:8px;align-items:center;flex:none}
    button.act{flex:1;height:32px;border:0;border-radius:6px;background:#2563EB;color:#fff;cursor:pointer;font-size:12px;font-weight:500}
    button.act.ghost{background:#fff;color:#374151;border:1px solid #CCD2D9;font-weight:400}
    button.act:disabled{opacity:.45;cursor:not-allowed}
    .summary{background:#F3F4F6;border-radius:6px;padding:4px 10px;min-height:28px;display:flex;align-items:center;gap:8px;font-size:11.5px;color:#4B5563;flex:none}
    .summary .smsg{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .summary.warn{background:#FEF2F2;color:#DC2626;font-weight:600}
    .summary .shint{margin-left:auto;font-size:10.5px;color:#9AA1A9;flex:none;font-weight:400}
    .list{flex:none;height:clamp(120px,20vh,170px);overflow:auto;border:1px solid #CCD2D9;background:#fff;border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:4px}
    .item{display:flex;gap:8px;align-items:center;padding:0 6px;min-height:30px;cursor:pointer;flex:none;border-radius:4px}
    .item:hover{background:#F5F8FF}
    .item .no{color:#9AA1A9;font-size:11px;font-weight:500;width:16px;text-align:right;flex:none}
    .item .type{flex:none;font-size:10.5px;color:#fff;border-radius:4px;padding:2px 6px;font-weight:500;background:#2563EB}
    .item .type.t-choice{background:#059669}
    .item .type.t-multi{background:#D97706}
    .item .type.t-judge{background:#64748B}
    .item .type.t-blank{background:#0EA5E9}
    .item .type.t-subjective{background:#2563EB}
    .item .stem{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#374151;font-size:11.5px}
    .item .st{flex:none;font-size:11px;font-weight:500;width:36px;text-align:right;color:#C0C6CD}
    .item .st.s-asking{color:#6B7280}
    .item .st.s-filled{color:#2563EB}
    .item .st.s-fixed{color:#7C3AED}
    .item .st.s-skipped{color:#059669}
    .item .st.s-conflict{color:#D97706}
    .item .st.s-failed{color:#DC2626}
    .logwrap{display:flex;flex-direction:column;gap:2px;flex:1 1 0;min-height:96px}
    .loghd{font-size:11px;font-weight:500;color:#374151;flex:none}
    .log{font-size:10.5px;color:#7C848C;flex:1 1 0;min-height:60px;overflow:auto;line-height:1.6;white-space:pre-wrap}
    .panel.expanded{left:50%!important;top:3vh!important;transform:translateX(-50%);width:min(640px,94vw);max-height:92vh}
    .panel.expanded .item{min-height:34px}
    .modal{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:2147483647;display:flex;align-items:center;justify-content:center}
    .mbox{background:#fff;border:1px solid #CCD2D9;border-radius:12px;padding:16px;width:300px;font-size:12px;line-height:1.7;color:#1f2328;box-shadow:0 16px 36px -8px rgba(15,23,42,.2)}
    .mbox b{font-size:13px;display:block;margin-bottom:6px}
    .mbtns{display:flex;gap:8px;margin-top:12px}
    .mbtns .act{padding:6px}
    .mcheck{display:flex;align-items:center;gap:5px;font-size:11px;color:#6B7280;margin-top:8px;cursor:pointer}
    .mcheck input{width:auto;margin:0;accent-color:#2563EB}
    .subjhint{color:#98A2B3;margin-top:8px}
  `;

  const TYPE_NAME = { choice: '单选', multi: '多选', judge: '判断', blank: '填空', subjective: '简答' };

  /* 行尾纯文字状态（设计稿无图标方案） */
  const STATUS_TEXT = { queued: '待机', asking: '获取中', answered: '获取中', filled: '填入', fixed: '改对', skipped: '保留', conflict: '冲突', failed: '失败' };

  /* 答案归一化比对（跳过/改写判断用） */
  const normAns = (t, v) => {
    const s = String(v || '').trim();
    if (t === 'judge') {
      if (/^(对|正确|√|✔|✓|是|真|T|True|TRUE)$/i.test(s)) return 'T';
      if (/^(错|错误|误|×|✘|✗|否|假|F|False|FALSE)$/i.test(s)) return 'F';
      return s;
    }
    if (t === 'choice' || t === 'multi') return [...new Set(String(v).toUpperCase().match(/[A-H]/g) || [])].sort().join('');
    return s;
  };
  const answersMatch = (t, a, b) => {
    const x = normAns(t, a);
    const y = normAns(t, b);
    return !!x && !!y && x === y;
  };
  /* 读答案缓存（与后台同规则：题干哈希为键），供"写对跳过/写错改写"判断 */
  async function cachedAnswer(q) {
    try {
      const enc = new TextEncoder().encode(
        JSON.stringify({ t: q.meta.type, s: q.meta.stem, o: (q.meta.options || []).map((x) => x.text) }),
      );
      const buf = await crypto.subtle.digest('SHA-256', enc);
      const key = 'c:' + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
      const o = await chrome.storage.local.get(key);
      return o[key] ? o[key].answer : null;
    } catch {
      return null;
    }
  }

  /* 接口类型（不再让用户挑大模型）：粘贴 Key 后自动探测；也可手动指定协议 */
  const IFACES = [
    { id: 'auto', label: '自动识别（推荐）', source: '粘贴 Key，自动匹配接口和模型' },
    { id: 'openai', label: 'OpenAI 兼容', source: 'DeepSeek/智谱/Kimi/火山/通义 等' },
    { id: 'anthropic', label: 'Anthropic', source: 'Claude 系 /v1/messages' },
  ];

  function init() {
    if (document.getElementById('hw-panel-host')) return;
    const host = document.createElement('div');
    host.id = 'hw-panel-host';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="fab" data-tip="点击收起/展开面板，按住可拖动位置">⚡</div>
      <div class="tip hidden" role="tooltip"></div>
      <section class="panel hidden">
        <header data-tip="按住拖动移动面板；双击复位位置"><b>作业助手</b><span class="badge"></span><span class="spacer"></span>
          <button class="tbtn expandbtn" data-tip="切换大/小面板（题目多时更清晰）">展开</button>
          <button class="tbtn settingsbtn" data-tip="打开设置页（记忆 / 诊断 / 检测更新）">设置</button>
          <button class="tbtn btn-collapse" data-tip="收起面板">收起</button>
        </header>
        <div class="row">
          <label>引擎
            <select class="engine">
              <option value="api">API</option>
              <option value="bridge">豆包桥接(免费)</option>
            </select>
          </label>
        </div>
        <div class="hintline">只填写不提交，提交请自行操作</div>
        <div class="updline hidden" data-tip="点击前往 GitHub 查看新版本（不会自动安装，可继续用当前版本）"></div>
        <button class="apitoggle hidden">▾ 接口 与 API Key</button>
        <div class="apisec hidden">
          <div class="provrow">
            <div class="provtop"><label>接口类型</label><select class="provider"></select></div>
            <div class="psource"></div>
          </div>
          <div class="keyrow">
            <div class="inputGroup">
              <input class="keyinput" id="hw-keyinput" type="password" placeholder=" " required>
              <label for="hw-keyinput" class="keylabel">粘贴 API Key</label>
            </div>
            <button class="lbtn primary savekey">保存</button>
            <button class="lbtn plain clearkey" data-tip="停用当前 Key（列表记录保留）">停用</button>
          </div>
          <div class="keywarn hidden">提示：API 引擎还没有填写 Key，粘贴后点「保存」</div>
          <div class="keylist"></div>
        </div>
        <div class="modal subjmodal hidden">
          <div class="mbox">
            <b>发现已作答的简答题</b>
            <p class="subjbody"></p>
            <p>· <b>清空重写</b>：删除已有内容，由 AI 重新生成作答<br>· <b>保留跳过</b>：完全不改动这些题</p>
            <div class="mbtns">
              <button class="act ghost subjcancel">取消</button>
              <button class="act ghost subjkeep">保留跳过</button>
              <button class="act subjrewrite">清空重写</button>
            </div>
            <p class="subjhint">每次开始都会询问；想固定策略可在设置页改「简答题策略」。</p>
          </div>
        </div>
        <div class="modal keymodal hidden">
          <div class="mbox">
            <b>保存 API Key 前请知悉</b>
            <p>该插件不能完全保证您的 API Key 不被泄露：Key 会明文保存在本机浏览器的插件存储里，任何能读取浏览器插件数据或操作这台电脑的程序/人都可能拿到它（插件不会把它上传到任何服务器）。</p>
            <p>若您的 Key 有大量余额，建议不要保存，改为每次答题时临时粘贴使用。</p>
            <div class="mbtns">
              <button class="act ghost mcancel">取消</button>
              <button class="act ghost mtemp">仅本次使用</button>
              <button class="act msave">保存并记住</button>
            </div>
          </div>
        </div>
        <div class="btnrow">
          <button class="act ghost detect">检测题目</button>
          <button class="act start" disabled>开始</button>
          <button class="act ghost stop" disabled>停止</button>
        </div>
        <div class="summary"><span class="smsg">先点「检测题目」</span><span class="shint hidden">列表可滚动</span></div>
        <div class="list"></div>
        <div class="logwrap"><div class="loghd">日志</div><div class="log"></div></div>
      </section>`;
    wire(root);
  }

  function wire(root) {
    const $ = (s) => root.querySelector(s);
    const els = {
      fab: $('.fab'), panel: $('.panel'), badge: $('.badge'), header: $('header'), settingsbtn: $('.settingsbtn'), collapse: $('.btn-collapse'), expandbtn: $('.expandbtn'),
      engine: $('.engine'), keyrow: $('.keyrow'), keyinput: $('.keyinput'), keylabel: $('.keylabel'), savekey: $('.savekey'), clearkey: $('.clearkey'),
      keylist: $('.keylist'), keywarn: $('.keywarn'), provrow: $('.provrow'), provider: $('.provider'), psource: $('.psource'),
      apiToggle: $('.apitoggle'), apisec: $('.apisec'),
      modal: $('.keymodal'), msave: $('.msave'), mtemp: $('.mtemp'), mcancel: $('.mcancel'),
      subjmodal: $('.subjmodal'), subjbody: $('.subjbody'), subjcancel: $('.subjcancel'), subjkeep: $('.subjkeep'), subjrewrite: $('.subjrewrite'),
      detect: $('.detect'), start: $('.start'), stop: $('.stop'),
      summary: $('.summary'), smsg: $('.smsg'), shint: $('.shint'), list: $('.list'), log: $('.log'),
      updline: $('.updline'),
    };
    /* 原生 title 提示在 Windows 上是系统气泡框（字体/圆角/箭头都不受控），改成本面板内的文字气泡：
       鼠标悬停与键盘聚焦都显示；事件委托在 Shadow 根上，动态生成的列表行（答题记录/Key 列表）同样生效。 */
    const tip = $('.tip');
    const tipHit = (e) => (e.target && e.target.closest ? e.target.closest('[data-tip]') : null);
    const showTip = (el) => {
      const text = el.dataset.tip;
      if (!text) return;
      tip.textContent = text;
      tip.classList.remove('hidden');
      const r = el.getBoundingClientRect();
      const tr = tip.getBoundingClientRect();
      tip.style.left = Math.max(8, Math.min(r.left + r.width / 2 - tr.width / 2, window.innerWidth - tr.width - 8)) + 'px';
      tip.style.top = (r.top > tr.height + 12 ? r.top - tr.height - 8 : r.bottom + 8) + 'px';
    };
    const hideTip = () => tip.classList.add('hidden');
    const onLeave = (e) => {
      const next = tipHit({ target: e.relatedTarget });
      next ? showTip(next) : hideTip();
    };
    root.addEventListener('mouseover', (e) => {
      const el = tipHit(e);
      if (el && el !== tipHit({ target: e.relatedTarget })) showTip(el);
    });
    root.addEventListener('mouseout', onLeave);
    root.addEventListener('focusin', (e) => { const el = tipHit(e); if (el) showTip(el); });
    root.addEventListener('focusout', onLeave);
    let rows = [];
    let stopRequested = false; // 停止后忽略后台迟到的答题消息
    // 所有后台通信失败都转成可见的错误（插件更新后旧页面会报 Extension context invalidated）
    const send = (type, payload) =>
      chrome.runtime.sendMessage({ type, payload }).catch((e) => {
        const msg = String(e && e.message ? e.message : e);
        return { ok: false, error: /context/i.test(msg) ? '插件刚更新过，请刷新页面（F5）再试' : msg };
      });
    const log = (m) => {
      const d = document.createElement('div');
      d.textContent = `[${new Date().toLocaleTimeString()}] ${m}`;
      els.log.appendChild(d);
      while (els.log.children.length > 40) els.log.firstChild.remove();
      els.log.scrollTop = els.log.scrollHeight;
    };
    const setSummary = (text, warn) => {
      els.smsg.textContent = text;
      els.summary.classList.toggle('warn', !!warn);
    };
    const engineName = () => els.engine.selectedOptions[0]?.textContent || '';
    const refreshBadge = () => (els.badge.textContent = engineName());

    /* 可拖动：面板按标题栏拖、悬浮球直接拖（移动 ≥4px 判定为拖动，否则算点击）。
       位置按网站存在 localStorage（刷新/下次打开还在）；双击标题栏复位；自动限制在屏幕内。 */
    const clampApply = (target, x, y) => {
      const maxX = window.innerWidth - target.offsetWidth;
      const maxY = window.innerHeight - target.offsetHeight;
      target.style.left = Math.max(4, Math.min(x, Math.max(4, maxX))) + 'px';
      target.style.top = Math.max(4, Math.min(y, Math.max(4, maxY))) + 'px';
      target.style.right = 'auto';
      target.style.bottom = 'auto';
    };
    const makeDraggable = (handle, target, key, onTap) => {
      handle.addEventListener('mousedown', (e) => {
        if (e.target.closest('button, select, input')) return;
        if (target.classList.contains('expanded')) return; // 展开模式居中定位，不拖动
        e.preventDefault();
        const rect = target.getBoundingClientRect();
        const sx = e.clientX;
        const sy = e.clientY;
        const ox = rect.left;
        const oy = rect.top;
        let moved = false;
        const onMove = (ev) => {
          const dx = ev.clientX - sx;
          const dy = ev.clientY - sy;
          if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
          moved = true;
          clampApply(target, ox + dx, oy + dy);
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          if (moved) {
            const r = target.getBoundingClientRect();
            try {
              localStorage.setItem(key, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
            } catch {
              /* 隐私模式忽略 */
            }
          } else if (onTap) onTap();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      try {
        const saved = JSON.parse(localStorage.getItem(key));
        if (saved && typeof saved.x === 'number') clampApply(target, saved.x, saved.y);
      } catch {
        /* 忽略损坏的位置数据 */
      }
    };
    makeDraggable(els.header, els.panel, 'hwPanelPos', null);
    makeDraggable(els.fab, els.fab, 'hwFabPos', () => {
      els.panel.classList.toggle('hidden');
      if (!els.panel.classList.contains('hidden') && !HW.questions) els.detect.click();
    });
    els.header.addEventListener('dblclick', () => {
      try {
        localStorage.removeItem('hwPanelPos');
      } catch {
        /* 忽略 */
      }
      els.panel.style.left = '';
      els.panel.style.top = '';
      els.panel.style.right = '';
      els.panel.style.bottom = '';
      log('面板位置已复位（右下角默认）');
    });

    // 接口类型下拉：填充选项
    IFACES.forEach((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label;
      els.provider.appendChild(o);
    });
    els.provider.addEventListener('change', async () => {
      const r = await send('SET_CONFIG', { api: { iface: els.provider.value } });
      if (!r?.ok) {
        log('接口类型切换失败：' + (r?.error || '未知错误'));
        return;
      }
      const p = IFACES.find((x) => x.id === els.provider.value) || IFACES[0];
      els.psource.textContent = p.source;
      log('接口类型已切换：' + p.label + '（粘贴 Key 保存后会自动探测匹配）');
    });

    els.apiToggle.addEventListener('click', () => {
      try { localStorage.setItem('hwApiOpen', apiSecOpen() ? '0' : '1'); } catch {}
      refreshKeyRow();
    });

    /* 展开模式：大面板（题目多时清晰），紧凑模式可拖动；展开时禁用拖动避免定位冲突 */
    const isExpanded = () => els.panel.classList.contains('expanded');
    const setExpanded = (on) => {
      els.panel.classList.toggle('expanded', on);
      els.expandbtn.textContent = on ? '收起面板' : '展开';
      els.expandbtn.dataset.tip = on ? '恢复小面板（可拖动）' : '切换大面板（题目多时更清晰）';
      if (on) {
        els.panel.style.left = '';
        els.panel.style.top = '';
        els.panel.style.right = '';
        els.panel.style.bottom = '';
        try { sessionStorage.setItem('hwExpanded', '1'); } catch {}
      } else {
        try { sessionStorage.removeItem('hwExpanded'); } catch {}
        try {
          const saved = JSON.parse(localStorage.getItem('hwPanelPos'));
          if (saved && typeof saved.x === 'number') clampApply(els.panel, saved.x, saved.y);
        } catch {}
      }
    };
    els.expandbtn.addEventListener('click', () => setExpanded(!isExpanded()));
    try {
      if (sessionStorage.getItem('hwExpanded') === '1') setExpanded(true);
    } catch {}

    els.collapse.addEventListener('click', () => els.panel.classList.add('hidden'));
    // 设置页（记忆 / 诊断 / 检测更新）在独立标签页打开，见 settings.html；
    // 注意：content script 没有 chrome.tabs，必须让后台代开
    els.settingsbtn.addEventListener('click', async () => {
      const r = await send('OPEN_SETTINGS');
      if (!r?.ok) log('设置页打开失败：' + (r?.error || '未知错误'));
    });
    const fmtTime = (t) => {
      const d = new Date(t);
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const renderKeyList = async (showWhenApi) => {
      const res = await send('KEY_LIST');
      const cfg = (await send('GET_CONFIG'))?.config;
      const list = res?.list || [];
      const active = cfg?.api?.apiKey || '';
      els.keylist.innerHTML = '';
      if (!list.length || !showWhenApi) {
        els.keylist.innerHTML = '';
        return;
      }
      list.forEach((rec) => {
        const isActive = active === rec.key;
        const row = document.createElement('div');
        row.className = 'krow' + (isActive ? ' active' : '');
        const main = document.createElement('span');
        main.className = 'kmain';
        const pl = (IFACES.find((p) => p.id === (rec.iface || 'openai')) || {}).label || '已记住接口';
        const stat = document.createElement('span');
        stat.className = 'kstat';
        stat.textContent = (isActive ? '使用中 尾号 ' : '尾号 ') + rec.key.slice(-4);
        const meta = document.createElement('span');
        meta.className = 'kmeta';
        meta.textContent = `${pl} | 记于 ${fmtTime(rec.savedAt)}`;
        main.appendChild(stat);
        main.appendChild(meta);
        row.appendChild(main);
        const useBtn = document.createElement('button');
        useBtn.className = 'kbtn';
        useBtn.textContent = '使用';
        useBtn.disabled = isActive;
        useBtn.addEventListener('click', async () => {
          const r = await send('KEY_USE', { id: rec.id });
          if (r?.ok) {
            log(`已切换使用尾号 ${rec.key.slice(-4)} 的 Key（${pl}）`);
            refreshKeyRow();
          } else log('切换失败：' + (r?.error || '未知错误'));
        });
        row.appendChild(useBtn);
        const delBtn = document.createElement('button');
        delBtn.className = 'kbtn del';
        delBtn.textContent = '删除';
        delBtn.dataset.tip = '删除这条记录';
        delBtn.addEventListener('click', async () => {
          const r = await send('KEY_REMOVE', { id: rec.id, key: rec.key });
          if (r?.ok) {
            log(`已删除尾号 ${rec.key.slice(-4)} 的记录${isActive ? '（正在使用，已一并停用）' : ''}`);
            refreshKeyRow();
          }
        });
        row.appendChild(delBtn);
        els.keylist.appendChild(row);
      });
    };
    const substantive = (t) => String(t || '').replace(/[^一-龥A-Za-z0-9]/g, '').length >= 20;
    function askSubjMode(count) {
      return new Promise((resolve) => {
        els.subjbody.textContent = '共 ' + count + ' 道简答题页面上已有内容。简答题无法自动判断对错，怎么处理？';
        els.subjmodal.classList.remove('hidden');
        const done = (mode) => {
          els.subjmodal.classList.add('hidden');
          els.subjcancel.removeEventListener('click', onCancel);
          els.subjkeep.removeEventListener('click', onKeep);
          els.subjrewrite.removeEventListener('click', onRew);
          log(mode === 'rewrite' ? '已选择：清空重写 ' + count + ' 道简答题' : '已选择：保留跳过 ' + count + ' 道简答题');
          resolve(mode);
        };
        const onCancel = () => { els.subjmodal.classList.add('hidden'); els.subjcancel.removeEventListener('click', onCancel); els.subjkeep.removeEventListener('click', onKeep); els.subjrewrite.removeEventListener('click', onRew); resolve(null); };
        const onKeep = () => done('keep');
        const onRew = () => done('rewrite');
        els.subjcancel.addEventListener('click', onCancel);
        els.subjkeep.addEventListener('click', onKeep);
        els.subjrewrite.addEventListener('click', onRew);
      });
    }

    const apiSecOpen = () => { try { return localStorage.getItem('hwApiOpen') !== '0'; } catch { return true; } };
    const refreshKeyRow = async () => {
      const isApi = els.engine.value === 'api';
      const open = isApi && apiSecOpen();
      // API 引擎：显示「接口与Key」抽屉（可折叠）；其他引擎：整块隐藏，空间让给题目列表和日志
      els.apiToggle.classList.toggle('hidden', !isApi);
      els.apiToggle.textContent = open ? '▾ 接口 与 API Key' : '▸ 接口 与 API Key（已折叠）';
      els.apisec.classList.toggle('hidden', !open);
      els.panel.classList.toggle('apiopen', open);
      const cfg = (await send('GET_CONFIG'))?.config;
      const key = cfg?.api?.apiKey;
      els.keylabel.textContent = key ? `使用中：尾号 ${key.slice(-4)}` : '粘贴 API Key';
      // 没填 Key：红色醒目提醒（选引擎时/打开面板时/停用后都会经过这里）
      els.keywarn.classList.toggle('hidden', !open || !!key);
      const cur = IFACES.find((p) => p.id === (cfg?.api?.iface || 'auto')) || IFACES[0];
      els.provider.value = cur.id;
      els.psource.textContent = cur.source;
      await renderKeyList(open);
    };
    const doSaveKey = async (raw, remember) => {
      const clean = String(raw || '').replace(/[^\x21-\x7E]/g, '').trim();
      if (!clean) {
        log('Key 无效：清理掉中文/全角/空格后为空，请重新复制（注意别带上旁边的文字）');
        return;
      }
      if (clean !== String(raw || '')) {
        log(`已自动清理 Key 中的非法字符（中文/全角/空格等），清理后尾号 ${clean.slice(-4)}——若与你的 Key 尾号不符说明复制时带入了多余内容`);
      }
      const iface = els.provider.value || 'auto';
      if (remember) {
        log('正在自动识别接口类型（并行尝试已知接口，几秒钟）…');
        const res = await send('KEY_SAVE', { key: clean, iface });
        if (res?.ok) {
          els.keyinput.value = '';
          const d = res.detected || {};
          const dl = (IFACES.find((p) => p.id === d.iface) || {}).label || d.iface;
          log(`Key 已保存并记住  接口: ${dl}（${d.baseURL}）  模型: ${d.model}`);
          refreshKeyRow();
        } else log('保存失败：' + (res?.error || '未知错误'));
      } else {
        // 仅本次：Key 生效但不入列表；接口类型 auto 时答题时自动探测
        const res = await send('SET_CONFIG', { api: { apiKey: clean, iface } });
        if (res?.ok) {
          els.keyinput.value = '';
          log(`Key 已临时使用（尾号 ${clean.slice(-4)}，未加入列表）`);
          refreshKeyRow();
        } else log('保存失败：' + (res?.error || '未知错误'));
      }
    };
    els.savekey.addEventListener('click', async () => {
      if (!els.keyinput.value.trim()) return;
      const cfg = (await send('GET_CONFIG'))?.config;
      if (cfg?.keyWarned) return doSaveKey(els.keyinput.value, true); // 已告知过泄露风险，直接保存并记住
      els.modal.classList.remove('hidden'); // 首次：弹窗告知，用户选择
    });
    els.msave.addEventListener('click', async () => {
      els.modal.classList.add('hidden');
      await send('SET_CONFIG', { keyWarned: true });
      doSaveKey(els.keyinput.value, true);
    });
    els.mtemp.addEventListener('click', async () => {
      els.modal.classList.add('hidden');
      await send('SET_CONFIG', { keyWarned: true });
      doSaveKey(els.keyinput.value, false);
    });
    els.mcancel.addEventListener('click', () => {
      els.modal.classList.add('hidden');
      log('已取消（未使用、未存储）');
    });
    els.clearkey.addEventListener('click', async () => {
      const res = await send('SET_CONFIG', { api: { apiKey: '' } });
      if (res?.ok) {
        log('已停用当前 Key（列表记录保留，可随时点「使用」恢复）');
        refreshKeyRow();
      }
    });
    els.engine.addEventListener('change', async () => {
      const r = await send('SET_CONFIG', { engine: els.engine.value });
      if (!r?.ok) {
        log('引擎切换失败：' + (r?.error || '未知错误'));
        return;
      }
      refreshBadge();
      refreshKeyRow();
      log('引擎已切换：' + engineName() + (els.engine.value === 'bridge' ? '（将自动打开豆包标签页答题）' : ''));
    });
    els.detect.addEventListener('click', () => {
      const qs = HW.Extractor.extract();
      HW.questions = qs;
      const cnt = {};
      qs.forEach((q) => (cnt[q.meta.type] = (cnt[q.meta.type] || 0) + 1));
      setSummary(
        qs.length
          ? `检测到 ${qs.length} 题：` + Object.entries(cnt).map(([k, v]) => `${TYPE_NAME[k] || k}${v}`).join('　')
          : '未检测到题目，可到设置页「诊断」导出页面结构',
        false,
      );
      els.shint.classList.toggle('hidden', !qs.length);
      els.list.innerHTML = '';
      rows = qs.map((q, i) => {
        const r = document.createElement('div');
        r.className = 'item';
        r.innerHTML = `<span class="no">${i + 1}</span><span class="type t-${q.meta.type}"></span><span class="stem"></span><span class="st">待机</span>`;
        r.querySelector('.type').textContent = TYPE_NAME[q.meta.type] || q.meta.type;
        r.querySelector('.stem').textContent = q.meta.stem.replace(/_{2,}/g, '＿＿').slice(0, 60);
        r.dataset.tip = '点击可重新询问本题';
        r.addEventListener('click', () => {
          if (['answered', 'filled', 'failed', 'skipped', 'conflict'].includes(q._status)) rerun(i);
        });
        els.list.appendChild(r);
        return r;
      });
      els.start.disabled = !qs.length;
    });

    els.start.addEventListener('click', async () => {
      if (!HW.questions?.length) return;
      try {
        const cfg = (await send('GET_CONFIG'))?.config || {};
        if (cfg.engine === 'api' && !cfg.api?.apiKey) {
          try { localStorage.setItem('hwApiOpen', '1'); } catch {}
          els.apiToggle.textContent = '▾ 接口 与 API Key';
          els.apisec.classList.remove('hidden');
          els.panel.classList.add('apiopen');
          els.keywarn.classList.remove('hidden'); // 红色提醒
          els.panel.classList.remove('hidden');
          log('API 引擎未配置 Key：请在上方输入框粘贴后点「保存」');
          return;
        }
        // 简答题策略：ask=开始弹窗询问 / keep=保留跳过 / rewrite=清空重写
        let subjMode = cfg.subjMode || 'ask';
        if (subjMode === 'ask') {
          const n = HW.questions.filter((q) => q.meta.type === 'subjective' && substantive(HW.Extractor.currentAnswer(q))).length;
          if (n > 0) subjMode = await askSubjMode(n);
          if (subjMode === null) {
            log('已取消开始（未做任何改动）');
            return;
          }
        }
        els.start.disabled = true;
        els.detect.disabled = true;
        els.stop.disabled = false;
        setBusy(true);
        stopRequested = false;
        // 逐题决策（用户算法定稿）：写没写 → 没写直接写 → 写了比对对错 → 不对改写 → 对了跳过。
        // 页面答案只信硬证据；页面状态读不出来时一律视为"没写"（重写由 toggleSafeClick 保证不取消）。
        const questions = [];
        for (const q of HW.questions) {
          const pageAnswer = HW.Extractor.currentAnswer(q); // 硬证据（input.checked / 学习类 / 文本值）
          const cached = await cachedAnswer(q);
          let decision = 'ask'; // 没写（或读不出）→ 问引擎后填写
          let refAnswer = null;
          let skipNote = '';
          if (pageAnswer) {
            if (q.meta.type === 'subjective') {
              // 主观题：乱码/占位短文本视为没写 → 生成；像样内容按策略 keep=保留跳过 / rewrite=清空重写
              if (substantive(pageAnswer)) {
                if (subjMode === 'rewrite') {
                  decision = 'ask';
                } else {
                  decision = 'skip';
                  skipNote = '已保留你原来的简答内容（未改动），请人工确认';
                }
              } else {
                decision = 'ask'; // 太短：视为没写
              }
            } else if (cached) {
              if (answersMatch(q.meta.type, pageAnswer, cached)) decision = 'skip'; // 写了且正确
              else {
                decision = 'rewrite'; // 写了但不对 → 用参考答案改写
                refAnswer = cached;
              }
            }
            // 无缓存：问了引擎才知道对错，先按 ask 走
          }
          questions.push({
            ...q.meta,
            _decision: decision,
            _pageAnswer: pageAnswer,
            _refAnswer: refAnswer,
            _skipNote: skipNote,
          });
        }
        const skipCount = questions.filter((q) => q._decision === 'skip').length;
        const rewriteCount = questions.filter((q) => q._decision === 'rewrite').length;
        log(
          `开始答题（引擎：${engineName()}，共 ${questions.length} 题` +
            (skipCount ? `，已写且正确 ${skipCount} 题跳过` : '') +
            (rewriteCount ? `，写错 ${rewriteCount} 题将改写` : '') +
            '；只填写不提交）',
        );
        const res = await send('HW_START', { questions });
        if (!res?.ok) {
          log('启动失败：' + (res?.error || '未知错误'));
          setBusy(false);
        }
      } catch (e) {
        // 任何意外错误都可见 + 按钮解锁，不再"半天没反应"
        log('启动异常：' + (e && e.message ? e.message : e) + '（按钮已解锁，可重试）');
        setBusy(false);
      }
    });
    els.stop.addEventListener('click', async () => {
      // 立即本地解锁按钮：后台可能在忙等回答（最长 150 秒）才回"已停止"，
      // 不能依赖它来恢复 UI；迟到的答题消息用 stopRequested 忽略。
      stopRequested = true;
      setBusy(false);
      await send('HW_STOP');
      log('已请求停止（后台正在获取的回答会被丢弃）…');
    });

    function setBusy(busy) {
      els.detect.disabled = busy;
      els.start.disabled = busy || !HW.questions?.length;
      els.stop.disabled = !busy;
    }

    function setRow(i, status, tip) {
      const q = HW.questions?.[i];
      if (q) q._status = status;
      const r = rows[i];
      if (!r) return;
      const st = r.querySelector('.st');
      st.textContent = STATUS_TEXT[status] || '·';
      st.className = 'st s-' + status;
      st.dataset.tip = tip || status;
    }

    async function rerun(i) {
      setRow(i, 'asking');
      log(`重问第 ${i + 1} 题…`);
      const res = await send('HW_RERUN', { index: i });
      if (res && !res.ok) log(`重问失败：${res.error}`);
    }

    chrome.runtime.onMessage.addListener((msg) => {
      const { type, payload = {} } = msg || {};
      if (type === 'HW_STATUS') {
        if (stopRequested) return;
        setRow(payload.index, payload.status, payload.error || payload.note || '');
        if (payload.status === 'failed') log(`第 ${payload.index + 1} 题获取答案失败：${payload.error}`);
        if (payload.status === 'skipped') log(`第 ${payload.index + 1} 题：${payload.note || '已作答，跳过'}`);
        if (payload.status === 'conflict') log(`第 ${payload.index + 1} 题：${payload.note}（点击该行会用参考答案重答）`);
      } else if (type === 'HW_ANSWER') {
        if (stopRequested) return; // 已停止：丢弃迟到的回答
        (async () => {
          const i = payload.index;
          try {
            const q = HW.questions[i];
            // 最终比对：页面已写的答案与引擎/缓存答案一致 → 无需点击；不一致（或没写）→ 真实填写
            const live = HW.Extractor.currentAnswer(q);
            if (answersMatch(q.meta.type, live, payload.answer)) {
              setRow(i, 'skipped', '答案：' + payload.answer + '（你原来的答案正确，保持不动）');
              log(`第 ${i + 1} 题已写且答案正确，无需改写${payload.fromCache ? '（缓存命中）' : ''}`);
              chrome.runtime.sendMessage({ type: 'HW_FILLED', payload: { index: i, ok: true } });
              return;
            }
            // 缓存命中只负责"快速拿到答案"，填写永远真实执行：
            // 已选中的选项由 clickOption 的状态保护自动跳过，不会重复点击/取消。
            await HW.Filler.fill(q, payload.answer);
            // 状态载体可能异步更新（超星点击后延迟写状态/标记）：等待式校验（最多约 3 秒）
            let verified = HW.Filler.verify(q, payload.answer);
            for (let w = 0; w < 12 && verified === false; w++) {
              await new Promise((r) => setTimeout(r, 250));
              verified = HW.Filler.verify(q, payload.answer);
            }
            setRow(i, verified === false ? 'failed' : payload.kind === 'rewrite' ? 'fixed' : 'filled', '答案：' + payload.answer);
            rows[i] && (rows[i].dataset.tip = '答案：' + payload.answer);
            const vTip = verified === 'unknown' ? '｜（页面不暴露选中状态，按点击成功处理）' : verified === false ? '｜校验未通过，将自动重试' : '';
            log(`第 ${i + 1} 题已填写${payload.fromCache ? '（缓存命中）' : ''}${payload.note ? '｜' + payload.note : ''}${vTip}`);
            chrome.runtime.sendMessage({
              type: 'HW_FILLED',
              payload: { index: i, ok: verified !== false, error: verified === false ? '填写校验未通过' : undefined },
            });
          } catch (e) {
            setRow(i, 'failed', String(e.message || e));
            log(`第 ${i + 1} 题填写失败：${e.message || e}`);
            chrome.runtime.sendMessage({ type: 'HW_FILLED', payload: { index: i, ok: false, error: String(e.message || e) } });
          }
        })();
      } else if (type === 'HW_DONE') {
        stopRequested = false;
        setBusy(false);
        if (payload.paused) {
          setSummary(payload.paused, true);
          els.panel.classList.remove('hidden'); // 确保面板可见
          log('已暂停：' + payload.paused);
        } else {
          const failed = payload.failed || 0;
          const skipped = payload.skipped || 0;
          if (failed > 0) {
            setSummary(`完成：填写 ${payload.filled ?? '?'} / 失败 ${failed}（点「失败」行可重答）`, true);
            els.panel.classList.remove('hidden');
            log(`全部处理完毕，但有 ${failed} 题未成功（修复 Key 后点「开始」可整页重跑，已成功的题会命中缓存秒填）`);
          } else {
            setSummary(`完成：填写 ${payload.filled ?? payload.total ?? '?'}${skipped ? ` / 保留 ${skipped}` : ''}，请检查后自行提交`, false);
            log(`全部处理完毕（共 ${payload.total} 题），提交请自行操作`);
          }
        }
      } else if (type === 'HW_STOPPED') {
        stopRequested = false;
        setBusy(false);
        log('队列已停止');
      }
    });

    // 初始化：读取配置回显
    (async () => {
      try {
        const res = await send('GET_CONFIG');
        const cfg = res?.config;
        if (cfg) {
          els.engine.value = cfg.engine;
          refreshBadge();
          refreshKeyRow();
        } else if (res && res.error) {
          log('提示：' + res.error);
        }
      } catch {
        /* 扩展上下文失效时忽略 */
      }
      // 更新提示：只读后台缓存（不联网，自动检查在设置页），且只有功能更新（次版本号变化）才提示
      try {
        const r = await send('CHECK_UPDATE', { cacheOnly: true });
        if (r?.ok && r.major) {
          els.updline.textContent = `发现新版本 v${r.latest}（当前 v${r.current}）`;
          els.updline.classList.remove('hidden');
          els.updline.addEventListener('click', () => window.open(r.url, '_blank'));
        }
      } catch {
        /* 未检查过或读取失败：静默 */
      }
    })();
  }

  HW.Panel = { init };
})();
