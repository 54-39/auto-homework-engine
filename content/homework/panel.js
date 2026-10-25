/* 悬浮控制面板：Shadow DOM 隔离样式，注入到作业页面右下角。
   视觉按 Pixso 设计稿「悬浮控制面板」落地：无图标、纯文字、浅色渐变卡片。 */
(function () {
  'use strict';
  const HW = (window.HW = window.HW || {});
  if (HW.Panel) return;

  const CSS = `
    :host{all:initial;color-scheme:light;scrollbar-color:#C7D0DB transparent;scrollbar-width:thin}
    *{box-sizing:border-box;font:12px/1.5 system-ui,'Microsoft YaHei','PingFang SC',sans-serif}
    /* 浏览器自带表面跟随面板主题：选中态、键盘焦点环、滚动条（原生 Windows 样式与浅色卡片不搭） */
    ::selection{background:#DBE6FD;color:#111827}
    :focus-visible:not(input){outline:2px solid #64748B;outline-offset:2px}
    .fab{box-sizing:content-box;padding:0;font-family:inherit;position:fixed;right:24px;bottom:24px;width:56px;height:56px;border-radius:50%;background:#2563EB;border:1px solid rgba(255,255,255,.35);color:#fff;
      display:flex;align-items:center;justify-content:center;font-size:24px;cursor:pointer;user-select:none;touch-action:none;
      box-shadow:0 6px 14px -2px rgba(15,23,42,.16);z-index:2147483646}
    .fab:hover{background:#1d4ed8}
    .fab:focus-visible{outline:2px solid #1d4ed8;outline-offset:3px}
    /* 球心闪电：以前是 Unicode ⚡，Windows 上按彩色 emoji 渲染（偏黄、还带渐变），
       改成内联 SVG 用 currentColor 填纯白（用户 2026-10-23 要求白色闪电）。 */
    .fab .boltsvg{display:block;width:24px;height:24px;fill:currentColor;color:#fff;pointer-events:none;user-select:none;-webkit-user-select:none}
    .panel{--hw-panel-width:320px;--hw-panel-ratio:2;--hw-panel-space-x:calc(100vw - 32px);--hw-panel-space-y:calc(100vh - 108px);
      --hw-panel-fit:min(var(--hw-panel-width),var(--hw-panel-space-x),calc(var(--hw-panel-space-y) / var(--hw-panel-ratio)));
      position:fixed;right:24px;bottom:96px;width:var(--hw-panel-fit);height:calc(var(--hw-panel-fit) * var(--hw-panel-ratio));min-height:0;overflow:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:8px;padding:14px;
      border-radius:14px;z-index:2147483646;color:#111827;
      background:
        radial-gradient(circle 300px,rgba(37,99,235,.10),rgba(37,99,235,0) 70%) right -40px top -40px / 600px 600px no-repeat,
        radial-gradient(circle 260px,rgba(96,165,250,.08),rgba(96,165,250,0) 70%) left -40px bottom -40px / 520px 520px no-repeat,
        linear-gradient(180deg,#FFFFFF 0%,#F6F8FD 50%,#EAEFF8 100%);
      box-shadow:0 16px 36px -8px rgba(15,23,42,.08),0 2px 6px -2px rgba(15,23,42,.06),inset 0 0 0 1px rgba(255,255,255,.9)}
    .hidden{display:none!important}
    .tip{position:fixed;z-index:2147483647;max-width:230px;padding:6px 9px;border-radius:8px;background:#fff;border:1px solid #E3E8EF;color:#374151;font-size:11px;line-height:1.5;white-space:pre-wrap;
      box-shadow:0 10px 24px -8px rgba(15,23,42,.22),0 2px 6px -2px rgba(15,23,42,.08);pointer-events:none}
    /* 外框宽高共用同一尺寸：页面缩放或视口变化时保持比例，内容过多在内部滚动。 */
    .panel.apiopen,.panel.watchmode{--hw-panel-width:360px}
    .panel.bridgemode .list{height:clamp(170px,29vh,240px)}
    .panel.watchmode .apitoggle,.panel.watchmode .apisec{display:none}
    header{display:flex;flex-wrap:wrap;align-items:center;gap:6px;cursor:move;user-select:none;touch-action:none;flex:none;min-height:22px}
    header b{font-size:15px;font-weight:700;color:#111827}
    .badge{font-size:11px;color:#2563EB;background:#E8EFFD;border-radius:4px;padding:2px 7px;font-weight:500}
    .spacer{flex:1}
    .tbtn{border:0;background:none;cursor:pointer;font-size:12px;color:#6B7280;padding:0 2px;flex:none}
    .tbtn:hover{color:#111827}
    .row{display:flex;gap:8px;align-items:center;flex:none}
    .row label{flex:none;font-size:12px;color:#374151;font-weight:500}
    .hintline{font-size:11px;color:#9AA1A9;flex:none}
    /* 刷课：与作业那套并列的独立一行，只占一行高度（面板外框尺寸不动，压缩的是日志区） */
    .updline{flex:none;font-size:11px;font-weight:500;color:#2563EB;cursor:pointer}
    .updline:hover{color:#1d4ed8}
    .updline .updgo{margin-left:2px;padding:1px 10px;font-size:11px;font-weight:500;color:#fff;background:#2563EB;border:none;border-radius:6px;cursor:pointer}
    .updline .updgo:hover{background:#1d4ed8}
    .updline .updgo:disabled{opacity:.6;cursor:default}
    .apitoggle{border:0;background:none;cursor:pointer;font-size:11.5px;color:#374151;font-weight:500;padding:2px 0;text-align:left;flex:none;align-self:flex-start}
    .apitoggle:hover{color:#111827}
    .apisec{display:flex;flex-direction:column;gap:8px;flex:none}
    /* 二次判断开关＝用户给的组件（switch/slider/title/ball/icon 五个元素、动效全不动）。
       按用户指定改的颜色：关态轨道浅灰 #D9DEE7，开态轨道**透明＝直接露出面板背景**
       （开态原为淡浅蓝 #DCE9FB；2026-10-15 用户圈住开态轨道、在 A/B/C 里选定 A「改成和背景一样的颜色」）。
       ON/OFF 文字随之改深灰 #313033，否则白字在两个浅底上都看不见。
       球选中时**没有光晕**（用户：「球形外不要带蓝色的光晕」，原来那圈
       outline:6px rgba(147,197,253,.55) 已删，box-shadow 保持 none）。
       icon 里是站点原版那颗播放三角 SVG（用户 2026-10-15：「闪电图标改回三角图标，和网站的一样」，
       并抱怨原来那个 ⚡ 文字能被拖选 → icon 加 user-select:none;pointer-events:none）。
       icon 用 top/left 50% 与球心重合（用户：「把圆形和三角形的中心重合就行了」）——站点原版的 58%/53%
       会让三角偏在球心右下 3.08px，转起来是绕球心画小圈；居中后就是原地自转一圈。
       尺寸只动了长度：高度、球径、字号全部保持组件原基准（font-size:14px、高 2.6em=36.39px、球 36px），
       width 由 9em 收到 8em（126px→112px）——用户先嫌长，等比缩到 11px 后又改口「不要等比例缩小，
       让它变短一点点，符合审美」，所以只收长度、不缩球。
       ⚠ 再要改长度就只改 .switch 的 width：选中时的 left 是 calc(100% - 35px)，会自动跟着贴到右端（左右各溢 1px）。
       ⚠ 绝对不要加 prefers-reduced-motion 关过渡的规则：用户机器 Windows「动画效果」是关的（SPI_GETCLIENTAREAANIMATION=0），
       Edge 因此常报 reduce，加了那条整个滑动+旋转动画会直接消失——用户已因此报过一次「没有旋转动画」。 */
    .v2row{display:flex;align-items:center;gap:8px;flex:none}
    .v2text{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
    .v2t{font-size:12px;color:#374151;font-weight:500}
    .v2h{font-size:11px;color:#9AA1A9}
    .switch{font-size:14px;position:relative;display:inline-block;width:8em;height:2.6em;flex:none}
    /* 真 checkbox 只隐形、不移出键盘：组件原来的 display:none 会让开关没法 Tab/Space 操作 */
    .switch input{position:absolute;top:0;left:0;width:1px;height:1px;opacity:0;margin:0;pointer-events:none}
    .switch .slider{position:absolute;top:0;left:0;right:0;bottom:0;background-color:#D9DEE7;transition:all .4s;border-radius:30px;cursor:pointer}
    /* 开态＝和面板背景一模一样（用户 2026-10-15 m08565 选 A）。
       ⚠ 这里**不能写死任何一个背景色值**：面板背景是渐变（见 .panel 的 background 三条），
       开关在竖排里随位置不同而不同（实测同一横行上左端 #F7F9FE、右端 #FFFFFF）。
       所以开态用 background-color:transparent —— 轨道自身不上色，露出底下真正的面板背景，
       这才是字面意义上的「和背景一样的颜色」，且面板背景以后怎么改都不会再对不上。
       白球保持纯白：实测背景是 #F6F8FE~#FFFFFF，球与背景仍有约 1.03~1.10 的亮度差，
       加上球投影和深灰三角，开态的球依然清晰可辨。 */
    .switch input:checked+.slider{background-color:transparent}
    .switch input:focus-visible+.slider{outline:2px solid #64748B;outline-offset:2px}
    /* 文字深灰：轨道改浅灰/淡浅蓝之后，白字对比度只有 1.35/1.22，等于看不见（用户 2026-10-15 报过看不清） */
    .switch .slider .title{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-weight:600;color:#313033;white-space:nowrap;transition:all .4s;user-select:none}
    .switch .slider .ball{position:absolute;top:0;left:-1px;width:36px;height:36px;border-radius:50%;background-color:#fff;transition:.4s}
    /* 图标＝站点原版播放三角（SVG 自带 width/height=25，与站点逐字一致）。不给选、不接鼠标：用户抱怨过 ⚡ 能被拖选。
       top/left 50% ＝ 与球心重合（用户 2026-10-15：「把圆形和三角形的中心重合就行了」），不再是站点的 58%/53% */
    .switch .slider .ball .icon{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#313033;font-size:12px;line-height:0;user-select:none;-webkit-user-select:none;pointer-events:none}
    .switch .slider .ball .icon svg{display:block}
    .switch input:checked+.slider .title{left:40%}
    /* ⚠ 球里不能再用 em：面板顶部那条 *{font:12px/1.5 …} 是直接命中每个元素的规则，优先级高于继承，
       所以 .ball 的 font-size 会被它压成 12px（不是 .switch 的 14px），em 在这里会算错。球固定 36px，用 px 最稳。 */
    .switch input:checked+.slider .ball{left:calc(100% - 35px);transform:rotate(360deg);outline:none;box-shadow:none}
    .keyrow{display:flex;gap:8px;align-items:center;flex:none;padding-top:14px} /* 顶部留白：浮起后的标签占这里，写死以免聚焦时布局跳 */
    .inputGroup{flex:1;min-width:0;position:relative}
    .inputGroup input{width:100%;height:36px;padding:0 14px;outline:none;caret-color:#2563EB;border:2px solid rgb(200,200,200);border-radius:999px;background:#fff;color:#111827;font-size:12px;transition:border-color .18s ease,box-shadow .18s ease}
    .inputGroup input::placeholder{color:transparent}
    .inputGroup :is(input:focus,input:valid){border-color:#64748B}
    .inputGroup input:focus{border-color:#64748B;outline:none;box-shadow:none}
    .inputGroup label{position:absolute;left:0;top:50%;transform:translateY(-50%);margin-left:14px;pointer-events:none;transition:top .18s ease,transform .18s ease,color .18s ease;color:#646464;font-size:12px;white-space:nowrap;background:transparent}
    /* 聚焦/已填时标签浮到输入框上方：底边正好贴上边缘，不压边框、不带任何背景（用户明确要求去掉原来的白底） */
    .inputGroup :is(input:focus,input:valid)~label{top:0;transform:translateY(-100%) scale(.9);transform-origin:0 100%;margin-left:12px;max-width:calc(100% - 24px);overflow:hidden;text-overflow:ellipsis}
    .inputGroup input:focus~label{color:#374151}
    .lbtn{border:0;background:none;cursor:pointer;font-size:12px;padding:0 2px;flex:none}
    .lbtn.primary{color:#2563EB;font-weight:500}
    .lbtn.plain{color:#6B7280}
    .keywarn{color:#64748B;font-size:11px;font-weight:400;flex:none}
    .keywarn a{color:#2563EB;font-weight:500;text-decoration:underline;text-underline-offset:2px}
    .keywarn a:hover{color:#1d4ed8}
    .btnrow{display:flex;gap:8px;align-items:center;flex:none}
    button.act{flex:1;height:32px;border:0;border-radius:6px;background:#2563EB;color:#fff;cursor:pointer;font-size:12px;font-weight:500}
    button.act.ghost{background:#fff;color:#374151;border:1px solid #CCD2D9;font-weight:400}
    button.act:disabled{opacity:.45;cursor:not-allowed}
    .bridgebar{display:flex;flex-direction:column;gap:4px;flex:none}
    .bridgebar button.act{flex:none;width:100%}
    .bridgestatus{margin:0;color:#4B5563;font-size:11px;line-height:1.6}
    .panel.watchmode .homework-only{display:none}
    .watchview{display:flex;flex-direction:column;gap:8px;flex:1.6 0 auto;min-height:min-content}
    .watchview>*{flex:none}
    .watchview .courselist{flex:1 1 140px;min-height:80px}
    .watchintro{padding:4px 0 6px;border-bottom:1px solid #DCE3ED}
    .watchtitle{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
    .courserefresh{min-height:28px}
    .courserefresh:disabled{opacity:.55;cursor:wait}
    .watchheading{margin:0 0 4px;font-size:16px;font-weight:600;line-height:1.4;color:#111827}
    .watchcontext{margin:0;color:#4B5563;font-size:12px;line-height:1.6;overflow-wrap:anywhere}
    .watchmeta{margin-top:6px;font-size:11px;color:#4B5563;font-variant-numeric:tabular-nums}
    .watchprogress{margin-top:10px}
    .wphead{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:6px;font-size:11px;line-height:1.5;color:#4B5563}
    .wpvalue{font-weight:500;color:#374151;font-variant-numeric:tabular-nums;text-align:right}
    .wptrack{height:7px;border-radius:4px;background:#E2E8F0;overflow:hidden}
    .wpfill{height:100%;width:0;border-radius:inherit;background:linear-gradient(90deg,#2563EB 0%,#3B82F6 55%,#75AEF2 100%)}
    .watchrow{display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between;flex:none}
    .watchrate{display:flex;align-items:center;gap:8px;color:#374151}
    .watchrow .rateslot{flex:none;width:116px}
    .muteopt{display:flex;align-items:center;gap:6px;flex:none;min-height:32px;font-size:12px;color:#374151;white-space:nowrap;cursor:pointer}
    .muteopt input{width:14px;height:14px;margin:0;accent-color:#4B5563;cursor:pointer}
    .muteopt input:focus-visible{outline:2px solid #64748B;outline-offset:2px}
    /* 队列信息：多门课程排队时，正在刷哪门、还剩几门、这门还要多久一目了然（用户 2026-10-23 要求） */
    .watchqueue{flex:none;display:flex;flex-direction:column;gap:3px;padding:8px 10px;border:1px solid #DCE3ED;border-radius:8px;background:rgba(255,255,255,.72)}
    .wqrow{display:flex;gap:8px;align-items:baseline;line-height:1.5}
    .wqk{flex:none;width:52px;font-size:11px;color:#6B7280}
    .wqv{flex:1;min-width:0;font-size:11.5px;font-weight:500;color:#111827;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
    .watchline{min-height:36px;padding:9px 0 0;border-top:1px solid #DCE3ED;font-size:12px;color:#2563EB;font-weight:500;line-height:1.6;overflow-wrap:anywhere}
    .watchline.warn{color:#DC2626}
    .watchview .watchbtn{flex:none;width:100%;height:36px}
    .watchempty{margin:0;padding:16px 10px;text-align:center;color:#4B5563;line-height:1.7;border:1px dashed #C7D0DB;border-radius:8px}
    /* 课程清单占的是题目列表那一格（同样的高度），有课时替换掉它，
       面板外框尺寸不变（用户硬要求）。 */
    .courselist{flex:none;height:clamp(120px,20vh,170px);overflow:auto;border:1px solid #CCD2D9;background:#fff;border-radius:8px;padding:6px;display:flex;flex-direction:column;gap:2px}
    .crow{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:4px;cursor:pointer;flex:none}
    .crow:hover{background:#F5F8FF}
    .crow input{flex:none;margin:0;cursor:pointer;accent-color:#4B5563}
    .crow input:focus-visible{outline:2px solid #64748B;outline-offset:2px}
    .crow .cname{flex:1;min-width:0;font-size:11.5px;color:#374151;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .crow .cprog{flex:none;font-size:10.5px;color:#9AA1A9}
    .crow .ctime{flex:none;font-size:10.5px;color:#4B5563;white-space:nowrap;font-variant-numeric:tabular-nums}
    .ccompleted{flex:none;border-top:1px solid #E5E7EB;margin-top:4px;padding-top:4px}
    .ccompleted summary{padding:5px 6px;font-size:11.5px;color:#4B5563;cursor:pointer}
    .ccompleted summary:focus-visible{outline:2px solid #64748B;outline-offset:-2px;border-radius:4px}
    .crow.all .cname{font-weight:600;color:#111827}
    .summary{background:#F3F4F6;border-radius:6px;padding:4px 10px;min-height:28px;display:flex;align-items:center;gap:8px;font-size:11.5px;color:#4B5563;flex:none}
    .summary .smsg{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .summary.warn{background:#FEF2F2;color:#DC2626;font-weight:600}
    .summary .shint{margin-left:auto;font-size:10.5px;color:#9AA1A9;flex:none;font-weight:400}
    .list{flex:none;height:clamp(120px,20vh,170px);overflow:auto;border:1px solid #CCD2D9;background:#fff;border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:4px}
    .item{display:flex;gap:8px;align-items:center;padding:0 6px;min-height:30px;cursor:pointer;flex:none;border-radius:4px}
    .item:hover{background:#F5F8FF}
    .item.pending{cursor:default;flex-wrap:wrap;padding-top:6px;padding-bottom:6px;gap:6px 8px}
    .pending-reason{flex-basis:100%;margin:0 0 0 24px;color:#6B7280;font-size:11px;line-height:1.6;overflow-wrap:anywhere}
    .item .retry-detect{width:auto;min-height:28px;padding:2px 4px;border:0;background:transparent;color:#2563EB;cursor:pointer;font:inherit;font-size:11px}
    .retry-detect:hover{background:#E8EFFD;border-radius:4px}
    .retry-detect:focus-visible{outline:2px solid #64748B;outline-offset:2px}
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
    .item .st.s-failed{color:#DC2626}
    .logwrap{display:flex;flex-direction:column;gap:2px;flex:1 0 96px;min-height:96px}
    .loghd{display:flex;align-items:center;justify-content:space-between;font-size:11px;font-weight:500;color:#374151;flex:none}
    .issuewarn{flex:none;padding:8px;border-radius:6px;background:#FEF2F2;color:#B91C1C;font-size:11px;line-height:1.6;overflow-wrap:anywhere}
    .log{font-size:10.5px;color:#7C848C;flex:1 1 0;min-height:60px;overflow:auto;line-height:1.6;white-space:pre-wrap}
    .panel.expanded{--hw-panel-width:640px;--hw-panel-ratio:1.25;--hw-panel-space-x:94vw;--hw-panel-space-y:92vh;left:50%!important;top:3vh!important;transform:translateX(-50%)}
    .panel.expanded .item{min-height:34px}
    @media (max-height:600px){.panel{--hw-panel-space-y:calc(100vh - 32px)}.watchview{flex:none}.logwrap{flex:none}.log{max-height:96px}}
    .modal{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:2147483647;display:flex;align-items:center;justify-content:center}
    .mbox{background:#fff;border:1px solid #CCD2D9;border-radius:12px;padding:16px;width:300px;font-size:12px;line-height:1.7;color:#1f2328;box-shadow:0 16px 36px -8px rgba(15,23,42,.2)}
    .mbox b{font-size:13px;display:block;margin-bottom:6px}
    .mbtns{display:flex;gap:8px;margin-top:12px}
    .mbtns .act{padding:6px}
    .subjhint{color:#98A2B3;margin-top:8px}
  `;

  const TYPE_NAME = { choice: '单选', multi: '多选', judge: '判断', blank: '填空', subjective: '简答' };

  /* 行尾纯文字状态（设计稿无图标方案） */
  const STATUS_TEXT = { asking: '获取中', filled: '填入', fixed: '改对', skipped: '保留', failed: '失败' };

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
        JSON.stringify({ v: 2, t: q.meta.type, s: q.meta.stem, o: (q.meta.options || []).map((x) => x.text), b: q.meta.blanks || 0, d: q.meta.slotOptions || [] }),
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

  /* 刷课倍速：默认「自动」= 先问播放器菜单最高到几档（多数课 1.5x，个别 2x）就按几档走。
     手动档只留 1x～2x 这几档常见的：再往上多数播放器根本没有，给了也只会被站点弹回来。
     站点不让改时脚本仍会直接写 playbackRate（那正是「不让改也改」要处理的情况）。 */
  const RATES = [
    { id: 'auto', label: '自动（最高档）' },
    { id: '1', label: '1x' },
    { id: '1.25', label: '1.25x' },
    { id: '1.5', label: '1.5x' },
    { id: '2', label: '2x' },
  ];

  function init() {
    if (document.getElementById('hw-panel-host')) return;
    const host = document.createElement('div');
    host.id = 'hw-panel-host';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <button type="button" class="fab" aria-label="打开或收起作业助手面板" data-tip="点击收起/展开面板，按住可拖动位置"><svg class="boltsvg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/></svg></button>
      <div class="tip hidden" role="tooltip"></div>
      <section class="panel hidden">
        <header data-tip="按住拖动移动面板；双击复位位置"><b>作业助手</b><span class="badge"></span><span class="spacer"></span>
          <button class="tbtn expandbtn" data-tip="切换大/小面板（题目多时更清晰）">展开</button>
          <button class="tbtn settingsbtn" data-tip="打开应用设置、刷课、记忆、诊断和检测更新">设置</button>
          <button class="tbtn btn-collapse" data-tip="收起面板">收起</button>
        </header>
        <div class="row moderow"><label>模式</label><div class="dd modeslot"></div></div>
        <div class="bridgebar hidden"><button type="button" class="act ghost bridgesplit">并排查看豆包</button><p class="bridgestatus hidden" role="status" aria-live="polite"></p></div>
        <div class="hintline homework-only">题目发送至所选 AI；请核对后自行提交</div>
        <div class="updline hidden" data-tip="点击「更新」启动更新事务；下载、验证与回滚状态请在设置页查看，成功后作业页面需 F5"></div>
        <button class="apitoggle hidden">接口 与 API Key</button>
        <div class="apisec hidden">
          <div class="v2row">
            <div class="v2text">
              <span class="v2t">选择题 / 判断题 二次判断</span>
              <span class="v2h">更稳，但每题多一次 AI 调用</span>
            </div>
            <label class="switch" data-tip="开启后：多选与判断题先答一遍，再让 AI 复查一遍；关掉每题省一次调用">
              <input class="v2input" type="checkbox">
              <span class="slider"><span class="title">OFF</span><span class="ball"><span class="icon"><svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="25" height="25" fill="none" viewBox="0 0 24 24"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 18V6l8 6-8 6Z"></path></svg></span></span></span>
            </label>
          </div>
          <div class="keyrow">
            <div class="inputGroup">
              <input class="keyinput" id="hw-keyinput" type="password" placeholder=" " required>
              <label for="hw-keyinput" class="keylabel">粘贴 API Key</label>
            </div>
            <button class="lbtn primary savekey">保存</button>
            <button class="lbtn plain clearkey" data-tip="停用当前 Key（列表记录保留）">停用</button>
          </div>
          <div class="keywarn hidden">还没有 API Key？可先前往 <a href="https://platform.deepseek.com/usage" target="_blank" rel="noopener noreferrer">DeepSeek 平台</a>了解并准备，获取后粘贴到上方并点「保存」。</div>
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
        <div class="issuewarn hidden" role="alert"></div>
        <div class="btnrow homework-only">
          <button class="act ghost detect" data-tip="题目未识别时，点击调用 AI 检测题目">检测题目</button>
          <button class="act start" disabled>开始</button>
          <button class="act ghost stop" disabled>停止</button>
        </div>
        <div class="watchview hidden">
          <div class="watchintro"><div class="watchtitle"><h2 class="watchheading">课程学习</h2><button type="button" class="lbtn plain courserefresh">刷新课程</button></div><p class="watchcontext">打开课程或勾选清单，继续未完成的章节。</p><div class="watchmeta"></div>
            <div class="watchprogress hidden"><div class="wphead"><span>本门课进度</span><span class="wpvalue"></span></div><div class="wptrack" role="progressbar" aria-label="本门课进度" aria-valuemin="0" aria-valuemax="100"><div class="wpfill"></div></div></div>
          </div>
          <div class="watchrow">
            <div class="watchrate"><span>倍速</span><div class="dd rateslot"></div></div>
            <label class="muteopt" data-tip="当前课程页所有视频静音，后续章节沿用；取消后恢复声音"><input class="watchmute" type="checkbox" checked>全部静音</label>
          </div>
          <div class="courselist hidden"></div>
          <p class="watchempty hidden">暂未读取到课程，可点击「刷新课程」重试，或进入课程后开始学习。</p>
          <div class="watchqueue hidden" role="status" aria-live="polite">
            <div class="wqrow"><span class="wqk">正在刷</span><span class="wqv wqnow"></span></div>
            <div class="wqrow"><span class="wqk">剩余</span><span class="wqv wqrest"></span></div>
            <div class="wqrow"><span class="wqk">剩余时间</span><span class="wqv wqtime"></span></div>
          </div>
          <div class="watchline" role="status" aria-live="polite">准备就绪</div>
          <button class="act watchbtn" data-tip="按所选倍速播放视频，播完自动进入下一节">开始刷课</button>
        </div>
        <div class="summary homework-only" role="status" aria-live="polite"><span class="smsg">正在读取页面题目…</span><span class="shint hidden">列表可滚动</span></div>
        <div class="list homework-only"></div>
        <div class="logwrap"><div class="loghd">日志</div><div class="log"></div></div>
      </section>`;
    wire(root);
  }

  function wire(root) {
    const $ = (s) => root.querySelector(s);
    const els = {
      fab: $('.fab'), panel: $('.panel'), badge: $('.badge'), header: $('header'), settingsbtn: $('.settingsbtn'), collapse: $('.btn-collapse'), expandbtn: $('.expandbtn'),
      keyinput: $('.keyinput'), keylabel: $('.keylabel'), savekey: $('.savekey'), clearkey: $('.clearkey'),
      keywarn: $('.keywarn'), v2input: $('.v2input'), v2title: $('.switch .title'),
      apiToggle: $('.apitoggle'), apisec: $('.apisec'),
      modal: $('.keymodal'), msave: $('.msave'), mtemp: $('.mtemp'), mcancel: $('.mcancel'),
      subjmodal: $('.subjmodal'), subjbody: $('.subjbody'), subjcancel: $('.subjcancel'), subjkeep: $('.subjkeep'), subjrewrite: $('.subjrewrite'),
      detect: $('.detect'), start: $('.start'), stop: $('.stop'), bridgebar: $('.bridgebar'), bridgesplit: $('.bridgesplit'), bridgestatus: $('.bridgestatus'),
      watch: $('.watchbtn'), watchmute: $('.watchmute'), watchline: $('.watchline'), courselist: $('.courselist'), courserefresh: $('.courserefresh'),
      watchqueue: $('.watchqueue'), wqnow: $('.wqnow'), wqrest: $('.wqrest'), wqtime: $('.wqtime'),
      moderow: $('.moderow'), watchview: $('.watchview'), watchheading: $('.watchheading'), watchcontext: $('.watchcontext'), watchmeta: $('.watchmeta'), watchempty: $('.watchempty'),
      watchprogress: $('.watchprogress'), wpvalue: $('.wpvalue'), wptrack: $('.wptrack'), wpfill: $('.wpfill'),
      summary: $('.summary'), smsg: $('.smsg'), shint: $('.shint'), list: $('.list'), log: $('.log'),
      updline: $('.updline'),
    };
    let engine = 'api';
    els.mode = HW.Dropdown.create({
      into: $('.modeslot'),
      items: [{ id: 'homework', label: '解题（API）' }, { id: 'watch', label: '刷课（API）' }, { id: 'bridge', label: '豆包' }],
      value: 'homework',
      onChange: async (panelMode) => {
        const nextEngine = panelMode === 'bridge' ? 'bridge' : 'api';
        const r = await send('SET_CONFIG', { engine: nextEngine, panelMode: panelMode === 'watch' ? 'watch' : 'homework' });
        if (r?.ok) syncConfig(r.config || { engine: nextEngine, panelMode });
        if (!r?.ok) log('模式保存失败：' + (r?.error || '请重试'));
      },
    });
    function applyMode() {
      const isApi = engine === 'api';
      const watch = isApi && els.mode.value === 'watch';
      els.moderow.classList.remove('hidden');
      els.panel.classList.toggle('watchmode', watch);
      els.bridgebar.classList.toggle('hidden', engine !== 'bridge');
      els.watchview.classList.toggle('hidden', !watch);
      if (watch) loadCourseTimes();
      updateWatchContext();
    }
    els.bridgesplit.addEventListener('click', async () => {
      const focused = root.activeElement === els.bridgesplit;
      els.bridgesplit.disabled = true;
      els.bridgesplit.textContent = '正在打开分屏…';
      els.bridgesplit.setAttribute('aria-busy', 'true');
      try {
        const result = await send('HW_BRIDGE_SPLIT');
        els.bridgestatus.textContent = result?.ok ? '已并排显示，可直接在豆包侧登录或处理验证。' : result?.error || '分屏未打开，请用 Edge 工具栏的分屏按钮选择豆包';
      } catch (e) { els.bridgestatus.textContent = '分屏未打开：' + String(e.message || e); }
      finally {
        els.bridgestatus.classList.remove('hidden');
        els.bridgesplit.disabled = false;
        els.bridgesplit.textContent = '并排查看豆包';
        els.bridgesplit.removeAttribute('aria-busy');
        if (focused) els.bridgesplit.focus({ preventScroll: true });
      }
    });
    /* 每门课处理几节由设置页决定（用户 2026-10-23 要求：不要再写死在面板里）。
       0 = 整门课程；N>0 = 从第一节起连续完成 N 节，只处理进度低于 35% 的课。 */
    let watchSections = 0;
    const limitedRun = () => watchSections > 0;
    async function loadWatchSections() {
      try {
        const stored = await chrome.storage.local.get('config');
        watchSections = Math.min(10, Math.max(0, Number(stored?.config?.watchSections) || 0));
      } catch { /* 读不到就按整门课程处理 */ }
      updateCourseTimes(); // 节数模式变了，哪些课能勾选也跟着变
      updateWatchContext();
      syncWatchTip();
    }
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area === 'local' && changes.config) {
        syncConfig(changes.config.newValue || {});
        loadWatchSections();
      }
    });
    function updateWatchContext() {
      const nodes = HW.Watch?.nodes?.() || [];
      const list = availableCourses();
      const active = nodes.find(n => n.id === HW.Watch?.activeChapterId?.());
      els.watchheading.textContent = list.length ? '选择课程' : nodes.length ? '当前课程' : '课程学习';
      els.watchcontext.textContent = list.length
        ? limitedRun() ? `只处理进度低于 35% 的课程，每门从第一节起连续完成 ${watchSections} 节（可在设置页改节数）。` : '勾选课程开始学习，进入后显示剩余时间。'
        : active?.name || '打开课程或勾选清单，继续未完成的章节。';
      const left = nodes.map(n => HW.Watch.unfinishedOf(n.id));
      els.watchmeta.textContent = nodes.length ? `${nodes.length} 节 · ` + (left.some(n => n === null) ? '目录加载中' : `剩余 ${left.reduce((a, b) => a + b, 0)} 个任务点`) : list.length ? `共 ${list.length} 门课程` : '';
      if (HW.Watch?.running && nodes.length) {
        const seconds = HW.Watch.remainingSeconds?.();
        if (seconds != null) els.watchmeta.textContent += ' · 剩余' + HW.Watch.formatCourseTime(seconds);
      }
      els.watchempty.classList.toggle('hidden', !!(nodes.length || list.length));
      renderQueue();
    }

    /* ---------------- 队列信息：正在刷哪门 + 还剩几门 + 这门还有多久 ----------------
       多门课排队时每次跳页脚本都会重载，界面原本只剩一行文字，用户看不出刷到第几门、
       后面还有谁、这门大概什么时候结束（2026-10-23 要求补齐）。数据直接读后台队列。 */
    let queueInfo = null;
    let queueAskedAt = 0;
    let queueAsking = false;
    const queueActive = () => !!(queueInfo && !queueInfo.paused && queueInfo.courses?.length);
    async function refreshQueueInfo(force) {
      if (queueAsking) return;
      if (!force && Date.now() - queueAskedAt < 2500) return;
      queueAsking = true;
      queueAskedAt = Date.now();
      try {
        const r = await send('HW_WATCH_QUEUE_GET');
        queueInfo = r?.queue || null;
      } catch { queueInfo = null; }
      queueAsking = false;
      renderQueue();
      syncWatchTip();
    }
    const pad2 = (n) => String(n).padStart(2, '0');
    function clockAfter(seconds) {
      const now = new Date();
      const at = new Date(now.getTime() + Math.max(0, seconds) * 1000);
      const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const days = Math.round((midnight(at) - midnight(now)) / 86400000);
      return (days === 1 ? '明天 ' : days > 1 ? `${days} 天后 ` : '') + pad2(at.getHours()) + ':' + pad2(at.getMinutes());
    }
    /* 这门课还要多久：学习页用目录里的实时任务点算；目录页/切换途中用队列里记下的进度或历史耗时估。 */
    function currentCourseSeconds(course) {
      if (!course) return null;
      if (HW.Watch?.running && HW.Watch?.pageKind?.() === 'study') {
        const live = HW.Watch.remainingSeconds?.();
        if (live != null) return live;
      }
      if (limitedRun()) return null; // 学习页之外不能把整门进度当作本次限定范围
      const item = courseItems.find(c => c.key === course.key);
      const timing = courseTimes[HW.Watch.courseTimeKey({ key: course.key, cpi: item?.cpi || '' })];
      const done = Number.isFinite(item?.done) ? item.done : course.done;
      const total = Number.isFinite(item?.total) ? item.total : course.total;
      if (Number.isFinite(done) && Number.isFinite(total)) {
        const est = HW.Watch.estimateCourseSeconds({ done, total }, rateOpts().rate, timing);
        if (est != null) return est;
      }
      if (timing?.remainingJobs) return HW.Watch.estimateCourseSeconds({ done: 0, total: timing.remainingJobs }, rateOpts().rate, timing);
      return null;
    }
    /* 3 秒一次的重绘只写真正变了的格子：textContent 反复赋值会让读屏和站点的观察器一直被打扰 */
    const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
    function renderCourseProgress(queued) {
      const current = HW.Watch?.currentCourse?.();
      const nodes = HW.Watch?.nodes?.() || [];
      const course = !current || queued?.key === current.key ? queued : null;
      els.watchprogress.classList.toggle('hidden', !current && !nodes.length && !course);
      let done, total, unit = '任务点';
      const native = current && /已完成任务点\s*[:：]?\s*(\d+)\s*\/\s*(\d+)/.exec(document.querySelector('.chapter_head')?.textContent || '');
      const left = nodes.map(n => HW.Watch.unfinishedOf(n.id));
      if (nodes.length && left.every(n => Number.isFinite(n) && n >= 0)) {
        const remaining = left.reduce((a, b) => a + b, 0);
        const taskTotal = native ? Number(native[2]) : course?.total;
        if (Number.isFinite(taskTotal) && taskTotal > 0 && remaining <= taskTotal) {
          total = taskTotal; done = total - remaining;
        } else {
          unit = '节'; total = nodes.length; done = left.filter(n => n === 0).length;
        }
      } else if (native) {
        done = Number(native[1]); total = Number(native[2]);
      } else if (!nodes.length && course) {
        done = course.done; total = course.total;
      }
      const known = Number.isFinite(done) && Number.isFinite(total) && total > 0 && done >= 0 && done <= total;
      const percent = known ? Math.floor(done / total * 100) : 0;
      const text = known ? `${percent}% · ${done}/${total} ${unit}` : '进度读取中';
      setText(els.wpvalue, text);
      els.wpfill.style.width = `${percent}%`;
      els.wptrack.setAttribute('aria-valuetext', text);
      if (known) els.wptrack.setAttribute('aria-valuenow', String(percent));
      else els.wptrack.removeAttribute('aria-valuenow');
    }
    function renderQueue() {
      const q = queueInfo;
      const courses = q?.courses || [];
      const index = q?.index || 0;
      const cur = courses[index];
      renderCourseProgress(cur);
      els.watchqueue.classList.toggle('hidden', !cur);
      if (!cur) return;
      const rest = courses.slice(index + 1);
      setText(els.wqnow, `${cur.name || cur.key}（第 ${index + 1}/${courses.length} 门）`);
      els.wqnow.dataset.tip = cur.name || cur.key;
      setText(els.wqrest, rest.length
        ? `${rest.length} 门：` + rest.slice(0, 3).map(c => c.name || c.key).join('、') + (rest.length > 3 ? ' 等' : '')
        : '这是最后一门');
      els.wqrest.dataset.tip = rest.length ? rest.map(c => c.name || c.key).join('、') : '';
      if (q.paused) {
        setText(els.wqtime, '队列已暂停');
        return;
      }
      const seconds = currentCourseSeconds(cur);
      setText(els.wqtime, seconds == null ? '数据不足，暂无法估算'
        : seconds <= 0 ? '已接近完成'
        : `${HW.Watch.formatCourseTime(seconds)} · 约 ${clockAfter(seconds)} 结束`);
      /* 队列还在推进但这一页的循环还没起来（核验目录、正在跳页）时给一句话，别让按钮看起来像闲着 */
      const idle = !els.watchline.textContent || els.watchline.textContent === '准备就绪';
      const kind = HW.Watch?.pageKind?.() || 'other';
      if (!HW.Watch?.running && idle && (kind === 'study' || kind === 'catalog')) {
        els.watchline.textContent = '队列进行中：正在接管这一门课程…';
      }
    }
    /* 接口类型不再让用户挑：去掉下拉后 Key 一律按「自动识别」保存（KEY_SAVE 收到 auto 会并行
       探测已知接口）；已记住的接口仍随 Key 列表保留，点「使用」即可恢复，所以这里不再有控件。 */
    /* 倍速：'auto' 交给脚本自己问播放器最高到几档，其余是固定档。
       配置里存的就是这个字符串（watchRate），下次打开面板原样回显。 */
    const rateOpts = () => {
      const v = els.rate.value;
      return v === 'auto' ? { rate: 2, autoRate: true } : { rate: Number(v), autoRate: false };
    };
    els.rate = HW.Dropdown.create({
      into: $('.rateslot'),
      items: RATES.map((r) => ({ id: r.id, label: r.label })),
      value: 'auto',
      onChange: async (id) => {
        await send('SET_CONFIG', { watchRate: id }); // 记住倍速，下次打开还是它
        updateCourseTimes();
        // 原地换档，不重启课程循环，避免重新进入页签或重复处理任务点。
        HW.Watch?.setRate?.(id === 'auto' ? 2 : Number(id), id === 'auto');
      },
    });
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
    let nativeDetection = true;
    let preparingFonts = false;
    let stopRequested = false; // 停止后忽略后台迟到的答题消息
    let detectionSnapshot = null;
    /* 上一次「页面读取」失败的真实原因：刷课日志只转发一句「没识别成功」，
       真正的原因（字体还原不了／题目结构不认识）会丢在面板摘要里，
       现场排查时等于没有信息（2026-10-22 传统文化测验就是这样白跑三轮）。 */
    let lastDetectError = '';
    let detecting = false;
    let detectionRequest = 0;
    let detectionObservers = [];
    let pageCheckTimer;
    const CONTEXT_NOTICE = '插件已更新或重载，请刷新页面（F5）后重试';
    const errorText = e => {
      const msg = String(e?.message || e);
      return /extension context invalidated/i.test(msg) ? CONTEXT_NOTICE : msg;
    };
    // sendMessage 在旧页面可能同步抛错，也可能返回被拒绝的 Promise。
    const send = async (type, payload) => {
      try { return await chrome.runtime.sendMessage({ type, payload }); }
      catch (e) { return { ok: false, error: errorText(e) }; }
    };
    const log = (m) => {
      const d = document.createElement('div');
      d.textContent = `[${new Date().toLocaleTimeString()}] ${m}`;
      els.log.appendChild(d);
      while (els.log.children.length > 40) els.log.firstChild.remove();
      els.log.scrollTop = els.log.scrollHeight;
    };
    function reportIssue(stage, message, details = {}) {
      const active = HW.Watch?.activeChapterId?.();
      const chapter = HW.Watch?.nodes?.().find(n => n.id === active)?.name || active || '';
      send('HW_ISSUE_ADD', { stage, message, chapter, stack: new Error(String(message)).stack,
        ...details, scene: HW.Diagnostics?.capture() }).then(r => {
        if (!r?.ok && r?.error !== CONTEXT_NOTICE) showIssueFailure(r?.error || '请刷新扩展后重试');
      });
    }
    function showIssueFailure(message) {
      const notice = $('.issuewarn');
      notice.textContent = '异常记录写入失败，已停止自动操作。请检查磁盘空间后刷新页面。原因：' + message;
      notice.classList.remove('hidden');
      stopRequested = true;
      HW.Watch?.stop?.();
      send('HW_STOP'); send('HW_WATCH_STOP');
      setBusy(false);
      log(notice.textContent);
    }
    HW.Panel.reportIssue = reportIssue;
    async function rememberProgress() {
      try { await HW.Watch?.rememberCourseProgress?.(); }
      catch (e) { reportIssue('课程用时', '目录进度保存失败：' + e.message); }
    }
    document.addEventListener('load', e => { if (e.target?.tagName === 'IFRAME') setTimeout(rememberProgress, 1500); }, true);
    setTimeout(rememberProgress, 1500);
    const extensionRoot = chrome.runtime.getURL?.('');
    window.addEventListener('error', e => {
      if (extensionRoot && e.filename?.startsWith(extensionRoot)) reportIssue('插件脚本', e.message, { stack: e.error?.stack || `${e.filename}:${e.lineno}:${e.colno}` });
    });
    window.addEventListener('unhandledrejection', e => {
      if (extensionRoot && String(e.reason?.stack || '').includes(extensionRoot)) reportIssue('插件脚本', e.reason?.message || e.reason, { stack: e.reason?.stack });
    });
    const setSummary = (text, warn) => {
      els.smsg.textContent = text;
      els.smsg.dataset.tip = text;
      els.summary.classList.toggle('warn', !!warn);
    };
    const stopWatching = () => {
      detectionObservers.forEach((o) => o.disconnect());
      detectionObservers = [];
      clearTimeout(pageCheckTimer);
    };
    const invalidateDetection = (reason) => {
      stopWatching();
      detectionRequest++;
      detectionSnapshot = null;
      detecting = false;
      stopRequested = true;
      HW.questions = [];
      rows = [];
      els.list.replaceChildren();
      els.shint.classList.add('hidden');
      els.detect.textContent = '检测题目';
      setBusy(false);
      setSummary(reason, true);
      send('HW_STOP');
    };
    const requireCurrentPage = () => {
      if (autoRun) return true; // 无人值守填写中，签名变化是自己点出来的，不算页面被换
      if (HW.AIDetection.isCurrent(detectionSnapshot)) return true;
      invalidateDetection('页面已变化，请重新检测题目');
      if (nativeDetection) readPageQuestions();
      return false;
    };
    /* 刷课自己点选项就会改动控件的选中状态，页面签名随之变化，于是页面守卫会
       把自己判成「页面已变化」并把题目清空（真实页面 2026-10-20 就是这样卡住的）。
       无人值守期间（autoRun）跳过这套守卫，换节时由 watch.js 重新检测。 */
    let autoRun = false;
    let autoDocument = null;
    let answerPauseReason = '';
    const watchPage = (snapshot) => {
      stopWatching();
      for (const doc of snapshot.documents) {
        const observer = new MutationObserver(() => {
          clearTimeout(pageCheckTimer);
          pageCheckTimer = setTimeout(() => {
            // 识别期间尚不知道题目边界；返回时再核对相关区域，避免倒计时刷新误取消。
            if (autoRun) return;
            if (detectionSnapshot === snapshot && !detecting) requireCurrentPage();
          }, 150);
        });
        observer.observe(doc.documentElement, { subtree: true, childList: true, characterData: true,
          attributes: true, attributeFilter: ['hidden', 'disabled', 'readonly', 'type', 'name', 'role', 'contenteditable', 'aria-label', 'aria-disabled', 'data'] });
        detectionObservers.push(observer);
      }
    };
    window.addEventListener('hashchange', () => { if (detectionSnapshot && !autoRun) requireCurrentPage(); });
    window.addEventListener('popstate', () => { if (detectionSnapshot && !autoRun) requireCurrentPage(); });
    /* 刷课状态行：跟作业那套的 summary 分开，作业在答题时刷课进度不会把它顶掉 */
    const setWatchLine = (text, warn) => {
      els.watchline.textContent = text || '准备就绪';
      els.watchline.classList.toggle('warn', !!warn);
      updateWatchContext();
    };
    const watchNote = (text) => {
      log('刷课：' + text); updateWatchContext();
      /* 低分与过程日志不单独转异常；节点最终未完成时由 watch 汇总原因和现场。 */
    };
    // 脚本自己停下（走完全课/跳不过去/出错）时把按钮和状态行也收回去，
    // 否则界面还显示「停止刷课」，用户点了才会知道早就停了。
    const watchStopped = () => {
      if (HW.Watch?.running) return; // start() 内部先 stop() 再 start，别把新的一轮关掉
      syncWatchTip();
      setWatchLine('');
    };
    const toggleWatch = async () => {
      if (!$('.issuewarn').classList.contains('hidden')) return;
      userStopped = false;
      reviveCount = 0; reviveMark = ''; reviveAt = 0;
      if (!HW.Watch) {
        setWatchLine('刷课脚本未加载，请刷新页面（F5）', true);
        return;
      }
      /* 先问一遍后台：这一页刚加载时循环可能还没起来，但队列已经在推进了。
         按界面上的旧文字判断「是否在跑」会让按钮和真实状态对不上（2026-10-23 反馈）。 */
      await refreshQueueInfo(true);
      if (HW.Watch.running || queueActive()) {
        HW.Watch.stop();
        stopByUser();
        /* 用户主动停止＝真的不想刷了：把队列也标成暂停，否则刷新页面/换页后
           自动接续又会把它拉起来，跟「停止」的意思相反（看门狗也会照做）。 */
        send('HW_WATCH_PAUSE', { reason: '已手动停止，点「开始刷课」继续' }).catch(() => {});
        queueInfo = null; // 本页立刻反映「已停」，不等下一次轮询
        syncWatchTip();
        setWatchLine('');
        log('刷课：已手动停止，队列已暂停');
        /* 停止时可能正好卡在「接续中」：接续流程稍后仍会把循环拉起来，补一刀按停 */
        setTimeout(() => { if (HW.Watch?.running) HW.Watch.stop(); }, 1500);
        return;
      }
      /* 课程列表页：勾了的课排队全自动刷 */
      const queued = await send('HW_WATCH_QUEUE_GET');
      if (queued?.queue && !pickedCourses().length) {
        const resumed = await send('HW_WATCH_RESUME');
        if (!resumed?.ok) { setWatchLine(resumed?.error || '接续失败', true); return; }
        await HW.Watch.resumeQueued({ onLive: setWatchLine, onNote: watchNote, onStop: watchStopped });
        await refreshQueueInfo(true);
        return;
      }
      const picked = selectedForWatch();
      if (picked.length) {
        startQueue(picked);
        return;
      }
      if (limitedRun()) {
        setWatchLine('没有进度已知且低于 35% 的课程，请先打开课程列表', true);
        return;
      }
      /* 单门课也走后台排队：点目录是整页导航，页面一换状态就没了，
         只有让后台记住「正在刷这门课」，新页面加载后才能自己接上。 */
      const cur = HW.Watch.currentCourse?.();
      if (cur) {
        startQueue([{ ...cur, checked: true }]);
        return;
      }
      HW.Watch.start({
        ...rateOpts(),
        onLive: setWatchLine,
        onNote: watchNote,
        onStop: watchStopped,
      });
      syncWatchTip();
      log('刷课：开始（' + els.rate.label + '）');
    };

    /* ---------------- 课程列表：勾选 → 全自动刷 ---------------- */
    let courseItems = [];
    let courseTimes = {};
    let embeddedCourses = [];
    let courseFrameLoading = null;
    let courseFrameFailed = false;
    const hasCourseFrame = () => !/\/mycourse\/(studentstudy|studentcourse)/.test(location.pathname)
      && [...document.querySelectorAll('iframe')].some(f => {
        try {
          const url = new URL(f.src, location.href);
          return /(^|\.)chaoxing\.com$/.test(url.hostname) || url.origin === location.origin;
        } catch { return false; }
      });
    function availableCourses() {
      const local = HW.Watch?.courseLinks?.() || [];
      return local.length ? local : embeddedCourses;
    }
    function refreshEmbeddedCourses(force = false) {
      if (courseFrameLoading) return force
        ? courseFrameLoading.then(() => !courseFrameFailed && availableCourses().length ? undefined : refreshEmbeddedCourses(true))
        : courseFrameLoading;
      if (!hasCourseFrame() && !force) {
        embeddedCourses = [];
        if (availableCourses().map(c => c.key).join('|') !== courseItems.map(c => c.key).join('|')) renderCourses();
        return;
      }
      courseFrameLoading = Promise.resolve().then(async () => {
        try {
          const result = await send('HW_WATCH_COURSES', { refresh: force });
          if (result?.needsPermission) {
            courseFrameFailed = true;
            setWatchLine(result.error || '请点击「刷新课程」申请超星站点访问权限', true);
            return;
          }
          if (!result?.ok) throw new Error(result?.error || '未读到内嵌课程清单');
          courseFrameFailed = false;
          embeddedCourses = result.courses || [];
          const keys = availableCourses().map(c => c.key).join('|');
          if (keys !== courseItems.map(c => c.key).join('|')) renderCourses();
          else { updateCourseTimes(); updateWatchContext(); }
        } catch (e) {
          if (!courseFrameFailed) reportIssue('课程识别', e.message);
          courseFrameFailed = true;
          setWatchLine('课程清单读取失败，可点「刷新课程」重试', true);
        } finally { courseFrameLoading = null; }
      });
      return courseFrameLoading;
    }
    els.courserefresh.addEventListener('click', async () => {
      const focused = root.activeElement === els.courserefresh;
      els.courserefresh.disabled = true;
      els.courserefresh.textContent = '检查权限…';
      els.courserefresh.setAttribute('aria-busy', 'true');
      setWatchLine('正在检查权限；如浏览器提示授权，请允许访问超星站点后继续');
      try {
        const access = await send('HW_WATCH_ACCESS_REQUEST');
        if (!access?.ok) {
          setWatchLine(access?.error || '未获得超星站点访问权限，请再次点击刷新申请授权', true);
          return;
        }
        els.courserefresh.textContent = '读取中…';
        await refreshEmbeddedCourses(true);
        renderCourses();
        if (!courseFrameFailed) setWatchLine(availableCourses().length ? `已读取 ${availableCourses().length} 门课程` : '暂未读到课程，请确认课程列表已加载');
      } catch (e) {
        setWatchLine('授权或刷新失败，请重试：' + String(e.message || e), true);
      } finally {
        els.courserefresh.disabled = false;
        els.courserefresh.textContent = '刷新课程';
        els.courserefresh.removeAttribute('aria-busy');
        if (focused) els.courserefresh.focus({ preventScroll: true });
      }
    });
    /* 完成的课收进折叠区。卡片没有「任务点进度」的课（青服团、安全教育这类不开任务的）
       原来一律算未完成、永远挂在勾选区顶部；只有本机刷课记录里还留着未完成任务点时
       才把它们当未完成，否则按「没有可刷的内容」归入已完成区。 */
    const courseComplete = (c) => {
      const t = courseTimes[HW.Watch.courseTimeKey(c)];
      if (!(Number.isFinite(c.done) && Number.isFinite(c.total))) return !(Number.isFinite(t?.remainingJobs) && t.remainingJobs > 0);
      return HW.Watch.estimateCourseSeconds(c, 2, t) === 0;
    };
    const pickedCourses = () => courseItems.filter((c) => c.checked);
    const eligibleLimited = c => Number.isFinite(c.done) && Number.isFinite(c.total) && c.total > 0 && c.done / c.total < .35;
    const selectedForWatch = () => limitedRun()
      ? (pickedCourses().length ? pickedCourses() : courseItems).filter(c => eligibleLimited(c) && !courseComplete(c))
      : pickedCourses();
    function updateCourseTimes() {
      const latest = new Map(availableCourses().map(c => [c.key, c]));
      const completed = els.courselist.querySelector('.ccompleted');
      if (!completed) return;
      courseItems.forEach((c, i) => {
        const progress = latest.get(c.key);
        if (progress) Object.assign(c, { done: progress.done, total: progress.total });
        const row = els.courselist.querySelector(`.crow[data-i="${i}"]`);
        if (!row) return;
        const seconds = HW.Watch.estimateCourseSeconds(c, rateOpts().rate, courseTimes[HW.Watch.courseTimeKey(c)]);
        const time = row.querySelector('.ctime');
        const text = seconds === 0 || seconds === null ? '' : HW.Watch.formatCourseTime(seconds);
        if (time.textContent !== text) time.textContent = text;
        time.classList.toggle('hidden', seconds === 0 || seconds === null);
        time.dataset.tip = seconds === null ? '课程页面尚未提供任务进度，暂时无法估算' :
          `按剩余任务点和${courseTimes[HW.Watch.courseTimeKey(c)]?.jobs ? '本课程实际耗时' : '默认每任务点 4 分钟（2 倍速）'}粗估；视频长度、倍速和 AI 响应时间会影响用时`;
        const prog = row.querySelector('.cprog');
        /* 节数进度来自本机刷课记录（watchTime 里刷到这门课时记下的目录统计）；
           没刷过的课列表页拿不到节数，先只显示任务点进度。 */
        const tm = courseTimes[HW.Watch.courseTimeKey(c)];
        const label = (Number.isFinite(c.total) ? `${c.done}/${c.total}` : '')
          + (Number.isFinite(tm?.sectionsTotal) ? ` · ${tm.sectionsDone || 0}/${tm.sectionsTotal} 节` : '');
        if (prog.textContent !== label) prog.textContent = label;
        const done = courseComplete(c);
        /* 折叠进「已完成」区的课不禁用勾选：站点偶尔不渲染进度徽章（2026-10-25 实测
           openGauss/C语言 done=null），这类课若禁勾，用户就永远刷不到它们剩下的任务点。
           折叠位置保持（无进度课仍不占未完成区），手动展开勾选 = 明确要求刷它。 */
        const blocked = limitedRun() && !eligibleLimited(c);
        row.querySelector('input').disabled = blocked;
        if (blocked) { c.checked = false; row.querySelector('input').checked = false; }
        if (done && row.parentElement !== completed) completed.append(row);
        else if (!done && row.parentElement !== els.courselist) els.courselist.insertBefore(row, completed);
      });
      const count = courseItems.filter(courseComplete).length;
      completed.classList.toggle('hidden', !count);
      const label = `已完成（${count} 门）`;
      if (completed.querySelector('summary').textContent !== label) completed.querySelector('summary').textContent = label;
      const all = els.courselist.querySelector('.crow.all');
      all.classList.toggle('hidden', count === courseItems.length);
      all.querySelector('.cname').textContent = `全选未完成（${courseItems.length - count} 门）`;
      /* 只统计未完成区里勾上的；用户手动勾的已折叠课不影响「全选未完成」的勾选态 */
      const picked = courseItems.filter((c) => c.checked && !courseComplete(c)).length;
      all.querySelector('input').checked = picked > 0 && picked === courseItems.length - count;
      all.querySelector('input').indeterminate = picked > 0 && picked < courseItems.length - count;
      syncWatchTip();
    }
    async function loadCourseTimes() {
      const keys = courseItems.map(c => HW.Watch.courseTimeKey(c));
      if (keys.length) courseTimes = await chrome.storage.local.get(keys).catch(() => ({}));
      updateCourseTimes();
    }
    // 课程进度比卡片名称晚加载，更新数字时保留用户的勾选。
    let courseRefreshTimer;
    const courseProgressObserver = new MutationObserver(() => {
      if (!courseItems.length) return;
      clearTimeout(courseRefreshTimer);
      courseRefreshTimer = setTimeout(updateCourseTimes, 200);
    });
    courseProgressObserver.observe(document.body, { childList: true, characterData: true, subtree: true });
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area === 'local' && Object.keys(changes).some(key => key.startsWith('watchTime:'))) loadCourseTimes();
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { loadCourseTimes(); refreshQueueInfo(true); }
    });
    document.addEventListener('load', e => {
      if (e.target?.tagName === 'IFRAME') refreshEmbeddedCourses();
    }, true);
    /* 面板重建后立即对一次后台队列：跳页重建的头几秒里按钮别显示「开始刷课」误导
       用户重复点击（2026-10-24 反馈），3 秒轮询只做后续刷新。 */
    refreshQueueInfo(true);
    setInterval(() => {
      if (HW.Watch?.running) updateWatchContext();
      /* 队列状态每 3 秒对一次：脚本跳页后按钮文字、队列信息、剩余时间都跟着走，
         不再等用户点一下才发现早停了或者早就在跑（2026-10-23 反馈） */
      if (!els.panel.classList.contains('hidden')) refreshQueueInfo();
      if (!els.panel.classList.contains('hidden') && els.mode.value === 'watch') refreshEmbeddedCourses();
    }, 3000);

    /* ---------------- 看门狗：循环意外停住时自己接回去 ----------------
       实况（2026-10-21）：赌徒的困惑那节视频停在 37 秒，循环按「点不起来」自己停了，
       队列既没暂停也没结束，就这么挂着不动，谁也不会再叫它。没人在旁边盯着就不可能刷完。
       这里每隔 30 秒看一眼：队列还在、没被暂停、当前页确实还有没做完的任务点，
       但脚本没在跑 —— 就是断了，隔一段时间接一次。间隔递增，最多 3 次；
       一旦位置/剩余数变了（有实质进展）就重新计数，避免无限重试触发风控。 */
    let reviveAt = 0;
    let reviveCount = 0;
    let reviveMark = '';
    let userStopped = false;
    const stopByUser = () => { userStopped = true; HW.Watch?.observeProgress?.(false); };
    /* 面板脚本是 all_frames 注入的，这段只能由顶层框架跑，
       否则每个 iframe 都会各自来一次「接续」，同时开好几轮循环。 */
    if (window.top === window) setInterval(async () => {
      try {
        if (userStopped || HW.Watch?.pageKind?.() !== 'study') {
          await HW.Watch?.observeProgress?.(false);
          return;
        }
        if (HW.Watch?.running) {
          await HW.Watch.observeProgress?.();
          reviveCount = 0; reviveMark = ''; return;
        }
        const r = await send('HW_WATCH_QUEUE_GET');
        const q = r?.queue;
        await HW.Watch?.observeProgress?.(!!q && !q.paused);
        if (!q || q.paused) return;
        if (Date.now() < reviveAt) return;
        const course = q.courses?.[q.index];
        if (!course) return;
        const sameCourse = HW.Watch.currentCourse?.()?.key === course.key;
        const ids = course.chapterIds;
        if (sameCourse && Number(q.targetRun) >= 1 && (!Array.isArray(ids) || !ids.length)) return;
        const scope = sameCourse ? Array.isArray(ids) && ids.length ? ids : (HW.Watch.nodes?.() || []).map(n => n.id) : [];
        const counts = scope.map(id => HW.Watch.unfinishedOf?.(id));
        const unknown = counts.some(count => count == null);
        const left = counts.reduce((sum, count) => sum + (count || 0), 0);
        const reopen = !sameCourse || scope.length > 0 && !left && !unknown;
        if (!reopen && !scope.length) return;
        const mark = reopen ? `${course.key}:navigation` : `${course.key}:${HW.Watch.activeChapterId?.() || ''}:${left}:${unknown}`;
        if (mark !== reviveMark) { reviveMark = mark; reviveCount = 0; }
        if (reviveCount >= 5) {
          setWatchLine('循环连续中断 5 次，已停止自动接续，请点「开始刷课」', true);
          return;
        }
        reviveCount += 1;
        reviveAt = Date.now() + 120000 * reviveCount; // 2 / 4 / 6 分钟，越往后越慢
        if (reopen) {
          log(`刷课：课程切换未完成，第 ${reviveCount} 次重新打开队列中的课程核验`);
          const result = await send('HW_WATCH_REOPEN', { key: course.key });
          if (!result?.ok) setWatchLine('课程接续未成功：' + (result?.error || '后台无回执'), true);
          return;
        }
        log(`刷课：循环中断（${unknown ? '任务数量待核对' : `还剩 ${left} 个任务点`}），第 ${reviveCount} 次自动接续`);
        // 自动接续只读队列，不能清除此刻刚出现的验证码或手动暂停。
        await HW.Watch.resumeQueued({ onLive: setWatchLine, onNote: watchNote, onStop: watchStopped });
        await refreshQueueInfo(true);
      } catch {
        /* 扩展上下文失效或页面正在跳转：下一轮再看 */
      }
    }, 30000);

    /* 列表页的卡片是站点 JS 画的，等它画完再读；读完画成勾选清单 */
    const renderCourses = () => {
      const list = availableCourses();
      const checked = new Map(courseItems.map(c => [c.key, c.checked]));
      courseItems = list.map((c) => ({ ...c, checked: checked.get(c.key) || false }));
      if (!list.length) {
        els.courselist.classList.add('hidden');
        els.courselist.replaceChildren();
        updateWatchContext();
        return;
      }
      const frag = document.createDocumentFragment();
      const all = document.createElement('label');
      all.className = 'crow all';
      const allBox = document.createElement('input');
      allBox.type = 'checkbox';
      const allName = document.createElement('span');
      allName.className = 'cname';
      allName.textContent = `全选（${list.length} 门）`;
      all.append(allBox, allName);
      allBox.addEventListener('change', () => {
        courseItems.forEach((c, i) => {
          c.checked = allBox.checked && !courseComplete(c) && (!limitedRun() || eligibleLimited(c));
          const row = els.courselist.querySelector(`.crow[data-i="${i}"] input`);
          if (row) row.checked = c.checked;
        });
        syncWatchTip();
      });
      frag.append(all);
      list.forEach((c, i) => {
        const row = document.createElement('label');
        row.className = 'crow';
        row.dataset.i = String(i);
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = courseItems[i].checked;
        box.addEventListener('change', () => {
          courseItems[i].checked = box.checked;
          updateCourseTimes();
        });
        const name = document.createElement('span');
        name.className = 'cname';
        name.textContent = c.name;
        name.dataset.tip = c.name;
        const time = document.createElement('span');
        time.className = 'ctime';
        const prog = document.createElement('span');
        prog.className = 'cprog';
        prog.textContent = c.total ? `${c.done}/${c.total}` : '';
        row.append(box, name, time, prog);
        frag.append(row);
      });
      const completed = document.createElement('details');
      completed.className = 'ccompleted hidden';
      completed.append(document.createElement('summary'));
      frag.append(completed);
      els.courselist.replaceChildren(frag);
      els.courselist.classList.remove('hidden');
      updateWatchContext();
      loadCourseTimes();
      log(`刷课：识别到 ${list.length} 门课程，勾选后点「开始刷 N 门」`);
      syncWatchTip();
    };

    /* 按钮文字永远是「真实状态」：队列在跑就是停止刷课，没跑才谈开始刷哪几门。
       以前这里只看 HW.Watch.running，这一页循环还没起来时按钮会停在旧文字上，
       用户得再点一次才看到「开始刷课」（2026-10-23 反馈）。 */
    const syncWatchTip = () => {
      if (HW.Watch?.running || queueActive()) {
        els.watch.textContent = '停止刷课';
        els.watch.dataset.tip = '停止本轮刷课，并把队列标为暂停';
        return;
      }
      const n = selectedForWatch().length;
      els.watch.dataset.tip = limitedRun()
        ? `只处理进度低于 35% 的课程，每门从第一节起连续完成 ${watchSections} 节（设置页可改）；口语例外单列`
        : n ? `依次刷完勾选的 ${n} 门课` : '按所选倍速播放视频，播完自动进入下一节';
      els.watch.textContent = n ? `开始刷 ${n} 门${limitedRun() ? ` · 前 ${watchSections} 节` : ''}` : '开始刷课';
    };

    const startQueue = async (picked) => {
      const r = await send('HW_WATCH_START', {
        courses: picked.map((c) => ({ key: c.key, scUrl: c.entryUrl || c.scUrl, name: c.name, done: c.done, total: c.total })),
        ...(limitedRun() ? { targetRun: watchSections } : {}),
        ...rateOpts(),
      });
      if (!r?.ok) {
        setWatchLine(r?.error || '启动失败', true);
        return;
      }
      if (r.inPlace) {
        await refreshQueueInfo(true);
        await HW.Watch.resumeQueued({ onLive: setWatchLine, onNote: watchNote, onStop: watchStopped });
        await refreshQueueInfo(true);
        log('刷课：从当前课程页继续');
        return;
      }
      log(`刷课：排队 ${picked.length} 门课，正在进第一门…`);
      setWatchLine('准备中…');
      await refreshQueueInfo(true);
    };

    /* 列表页是站点用 JS 画的，卡片可能比脚本晚到：等到有卡片再铺清单 */
    async function renderCoursesWhenReady() {
      if (/\/mycourse\/(studentstudy|studentcourse)/.test(location.pathname)) return;
      const isList = () => availableCourses().length > 0;
      await refreshEmbeddedCourses();
      if (isList()) { renderCourses(); return; }
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 300));
        if (i % 3 === 0) await refreshEmbeddedCourses();
        if (isList()) { renderCourses(); return; }
      }
      els.courselist.classList.add('hidden');
    }
    const engineName = () => engine === 'bridge' ? '豆包桥接' : 'API';
    const refreshBadge = () => (els.badge.textContent = engineName());

    /* 可拖动：面板按标题栏拖、悬浮球直接拖（移动 ≥4px 判定为拖动，否则算点击）。
       位置按网站存在 localStorage（刷新/下次打开还在）；双击标题栏复位；自动限制在屏幕内。 */
    const clampApply = (target, x, y) => {
      /* offsetWidth/Height 是取整值，面板实际高度常带小数（681.14），用整数算上限会底边溢出 0.14px；
         这里按实际矩形向下取整，保证面板整块都在视口内。 */
      const box = target.getBoundingClientRect();
      const maxX = Math.floor(window.innerWidth - (box.width || target.offsetWidth));
      const maxY = Math.floor(window.innerHeight - (box.height || target.offsetHeight));
      target.style.left = Math.max(4, Math.min(x, Math.max(4, maxX))) + 'px';
      target.style.top = Math.max(4, Math.min(y, Math.max(4, maxY))) + 'px';
      target.style.right = 'auto';
      target.style.bottom = 'auto';
    };
    const makeDraggable = (handle, target, key, onTap) => {
      let dragging = false;
      handle.addEventListener('pointerdown', (e) => {
        if (dragging || e.button !== 0 || !e.isPrimary) return;
        if (handle !== els.fab && e.target.closest('button, select, input')) return;
        if (target.classList.contains('expanded')) return; // 展开模式居中定位，不拖动
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        dragging = true;
        delete handle.dataset.hwDragged;
        const rect = target.getBoundingClientRect();
        const sx = e.clientX;
        const sy = e.clientY;
        const ox = rect.left;
        const oy = rect.top;
        let moved = false;
        const onMove = (ev) => {
          if (ev.pointerId !== e.pointerId) return;
          if (!(ev.buttons & 1)) return onUp(ev);
          const dx = ev.clientX - sx;
          const dy = ev.clientY - sy;
          if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
          moved = true;
          handle.dataset.hwDragged = '1';
          clampApply(target, ox + dx, oy + dy);
        };
        const onUp = (ev) => {
          if (ev.pointerId !== undefined && ev.pointerId !== e.pointerId) return;
          dragging = false;
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          handle.removeEventListener('pointercancel', onUp);
          handle.removeEventListener('lostpointercapture', onUp);
          window.removeEventListener('blur', onUp);
          if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
          if (moved) {
            handle.dataset.hwDragged = '1';
            const r = target.getBoundingClientRect();
            try {
              localStorage.setItem(key, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
            } catch {
              /* 隐私模式忽略 */
            }
          } else if (onTap && ev.type === 'pointerup') onTap();
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
        handle.addEventListener('lostpointercapture', onUp);
        window.addEventListener('blur', onUp);
      });
      try {
        const saved = JSON.parse(localStorage.getItem(key));
        if (saved && typeof saved.x === 'number') clampApply(target, saved.x, saved.y);
      } catch {
        /* 忽略损坏的位置数据 */
      }
    };
    makeDraggable(els.header, els.panel, 'hwPanelPos', null);
    makeDraggable(els.fab, els.fab, 'hwFabPos', null);
    /* 窗口缩小后把显式定位的悬浮球/面板拉回可视区：位置是 left/top 定死的，
       从宽屏缩到窄屏时面板会留在屏幕外，用户再也点不到（2026-10-23 回归用例暴露）。
       等下一帧再量尺寸：resize 事件里面板还没按新宽度重排，offsetHeight 是旧值，夹取会算错。 */
    let reclampQueued = false;
    const queueReclamp = () => {
      if (reclampQueued) return;
      reclampQueued = true;
      requestAnimationFrame(() => {
        reclampQueued = false;
        for (const target of [els.fab, els.panel]) {
          if (target.classList.contains('hidden') || target.classList.contains('expanded') || !target.style.left) continue;
          const rect = target.getBoundingClientRect();
          clampApply(target, rect.left, rect.top);
        }
      });
    };
    window.addEventListener('resize', queueReclamp);
    new ResizeObserver(queueReclamp).observe(els.panel);
    els.fab.addEventListener('click', (e) => {
      if (e.detail === 0 || !els.fab.dataset.hwDragged) {
        els.panel.classList.toggle('hidden');
        if (!els.panel.classList.contains('hidden') && !els.panel.classList.contains('expanded')) {
          const rect = els.panel.getBoundingClientRect();
          clampApply(els.panel, rect.left, rect.top);
        }
      }
      delete els.fab.dataset.hwDragged;
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
    // 内容脚本通过后台打开统一设置页。
    const openSettings = async () => {
      const r = await send('OPEN_SETTINGS', { section: 'app' });
      if (!r?.ok) log('设置页打开失败：' + (r?.error || '未知错误'));
    };
    els.settingsbtn.addEventListener('click', openSettings);
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
    let keyWarningOpen = false;
    let hasSavedApiKey = false;
    const updateKeyWarning = () => {
      els.keywarn.classList.toggle('hidden', !keyWarningOpen || hasSavedApiKey || !!els.keyinput.value.trim());
    };
    const refreshKeyRow = async (current) => {
      const isApi = engine === 'api';
      const open = isApi && apiSecOpen();
      // API 引擎：显示「接口与Key」抽屉（可折叠）；其他引擎：整块隐藏，空间让给题目列表和日志
      els.apiToggle.classList.toggle('hidden', !isApi);
      els.apiToggle.textContent = open ? '接口 与 API Key' : '接口 与 API Key（已折叠）';
      els.apisec.classList.toggle('hidden', !open);
      els.panel.classList.toggle('apiopen', open);
      const cfg = current || (await send('GET_CONFIG'))?.config;
      const key = cfg?.api?.apiKey;
      keyWarningOpen = open;
      hasSavedApiKey = !!key;
      els.keylabel.textContent = key ? `使用中：尾号 ${key.slice(-4)}` : '粘贴 API Key';
      updateKeyWarning();
      /* 二次判断开关回显（与设置页那个勾选框共用 config.verify2） */
      setVerify2(cfg?.verify2 !== false);
    };
    function setVerify2(on) {
      els.v2input.checked = !!on;
      els.v2title.textContent = on ? 'ON' : 'OFF';
    }
    /* 开关立刻生效、不弹确认：出错就把开关拨回去，别显示与后台不一致的状态 */
    els.v2input.addEventListener('change', async () => {
      const on = els.v2input.checked;
      setVerify2(on);
      const r = await send('SET_CONFIG', { verify2: on });
      if (!r?.ok) {
        setVerify2(!on);
        log('二次判断开关保存失败：' + (r?.error || '未知错误'));
      } else log(on ? '已开启二次判断（多选/判断题每题多一次 AI 调用）' : '已关闭二次判断（多选/判断题只答一次）');
    });
    els.keyinput.addEventListener('input', updateKeyWarning);
    const doSaveKey = async (raw, remember) => {
      const clean = String(raw || '').replace(/[^\x21-\x7E]/g, '').trim();
      if (!clean) {
        log('Key 无效：清理掉中文/全角/空格后为空，请重新复制（注意别带上旁边的文字）');
        return;
      }
      if (clean !== String(raw || '')) {
        log(`已自动清理 Key 中的非法字符（中文/全角/空格等），清理后尾号 ${clean.slice(-4)}——若与你的 Key 尾号不符说明复制时带入了多余内容`);
      }
      const iface = 'auto'; // 接口类型控件已去掉：一律自动识别（KEY_SAVE 收到 auto 会并行探测）
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
    function syncConfig(cfg) {
      engine = cfg.engine || 'api';
      els.mode.value = engine === 'bridge' ? 'bridge' : cfg.panelMode || 'homework';
      els.panel.classList.toggle('bridgemode', engine === 'bridge');
      refreshKeyRow(cfg);
      refreshBadge();
      applyMode();
    }
    /* 默认只在本地读取；复用绑定校验，无法确认的区域留给手动 AI 检测。 */
    function readPageQuestions() {
      if (detecting || !els.stop.disabled) return false;
      const sourceDocument = autoDocument || document;
      nativeDetection = true;
      stopWatching();
      if (HW.FontDecoder && !HW.FontDecoder.ready(sourceDocument)) {
        detectionSnapshot = null;
        HW.questions = []; rows = []; els.list.replaceChildren(); els.start.disabled = true;
        setSummary('正在还原页面字体…', false);
        if (!preparingFonts) {
          preparingFonts = true;
          HW.FontDecoder.prepare(sourceDocument).then(() => {
            if (nativeDetection && !detecting && els.stop.disabled) readPageQuestions();
          }, e => setSummary('页面字体未能还原：' + errorText(e), true)).finally(() => { preparingFonts = false; });
        }
        return false;
      }
      try {
        const snapshot = HW.AIDetection.collect(sourceDocument);
        const items = [];
        for (const doc of snapshot.documents) {
          if (doc.body?.isContentEditable) continue; // 富文本编辑器正文不是另一份题目
          for (const q of HW.Extractor.extract(doc)) {
            const labels = (q.el.labels || []).filter(l => snapshot.ids.has(l.input || l.clickEl));
            /* el.fields 是填空专用字段列表（超星多空填空的编辑器藏在 .textDIV 里，
               既不是 inputs 也不是 iframe/iframes，之前漏读导致整题被当成未知）。 */
            const fields = q.el.fields?.length ? q.el.fields
              : q.el.iframes?.length ? q.el.iframes
              : q.el.iframe ? [q.el.iframe] : q.el.inputs || [];
            const target = labels[0]?.input || labels[0]?.clickEl || fields[0];
            const container = HW.AIDetection.questionRoot(target);
            if (!snapshot.ids.has(container)) continue;
            /* 题干/选项里有还原不了的字形（font-decoder 已改为返回 U+FFFD）时，
               只把这一题降级成「待人工」并留空：留空交卷不判错，整卷作废则永远刷不完。 */
            const stemText = HW.FontDecoder?.decodeText(container, q.meta.stem) ?? q.meta.stem;
            const charBad = /[\uFFFD]/.test(stemText) || labels.some((l) => /[\uFFFD]/.test(l.text || ''));
            if (charBad) {
              items.push({ type: 'unknown', containerId: snapshot.ids.get(container),
                stem: stemText.slice(0, 120), options: [], inputIds: [],
                reason: '题干/选项字形无法还原，本题留空' });
              continue;
            }
            items.push({ ...q.meta, stem: stemText, containerId: snapshot.ids.get(container),
              contextIds: (q.el.contexts || []).map(el => snapshot.ids.get(el)).filter(Boolean),
              options: labels.map(l => {
                const plain = l.text.replace(/^[A-H][.、．:：)）\s]+/, '').trim();
                let key = l.key;
                if (q.meta.type === 'judge' && /^(对|正确|是|真|true|T|√)$/i.test(plain)) key = 'T';
                if (q.meta.type === 'judge' && /^(错|错误|否|假|false|F|×)$/i.test(plain)) key = 'F';
                return { key, targetId: snapshot.ids.get(l.input || l.clickEl) };
              }),
              inputIds: q.el.labels?.length ? [] : fields.map(el => snapshot.ids.get(el)) });
          }
          for (const el of doc.querySelectorAll('.questionLi,.TiMu')) {
            const containerId = snapshot.ids.get(el);
            // 同一道题可能同时套着 questionLi 和 TiMu；不再把外壳或内层容器另算一题。
            const represented = items.some(q => {
              const root = snapshot.refs.get(q.containerId)?.el;
              return root === el || (q.type !== 'unknown' && root && (root.contains(el) || el.contains(root)));
            });
            if (containerId && !represented) items.push({ type: 'unknown', containerId,
              stem: HW.AIDetection.textOf(el.querySelector('.mark_name,.Zy_TItle') || el).slice(0, 300), options: [], inputIds: [],
              reason: '页面题型暂未识别，可点「检测题目」调用 AI' });
          }
        }
        const bound = HW.AIDetection.bind(snapshot, items);
        bound.pending.forEach(q => { q.reason = q.reason.replace('AI 未能识别', '页面未能识别'); });
        detectionSnapshot = snapshot;
        renderDetected(bound.questions, bound.pending, '页面读取');
        watchPage(snapshot);
        setBusy(false);
        return true;
      } catch (e) {
        detectionSnapshot = null;
        HW.questions = [];
        rows = [];
        els.list.replaceChildren();
        setBusy(false);
        lastDetectError = errorText(e);
        setSummary('页面题目暂未识别：' + lastDetectError, true);
        return false;
      }
    }
    document.addEventListener('load', e => {
      if (e.target?.tagName === 'IFRAME' && nativeDetection && !detecting && els.stop.disabled) readPageQuestions();
    }, true);

    /* 只有用户点击「检测题目」才调用 AI 识题。 */
    async function detectQuestions() {
      if (detecting || !els.stop.disabled) return false;
      if (HW.CXAdapter?.discussion(document)) return readPageQuestions();
      const nativeQuestions = autoRun ? HW.questions || [] : [];
      const nativeSnapshot = detectionSnapshot;
      const nativePending = autoRun ? [...els.list.querySelectorAll('.item.pending')].map(row => ({
        type: 'unknown', stem: row.querySelector('.stem')?.textContent || '', reason: row.querySelector('.pending-reason')?.textContent || '' })) : [];
      nativeDetection = false;
      const requestId = ++detectionRequest;
      stopWatching();
      detectionSnapshot = null;
      HW.questions = [];
      rows = [];
      els.list.replaceChildren();
      els.shint.classList.add('hidden');
      detecting = true;
      stopRequested = true;
      els.detect.disabled = true;
      els.start.disabled = true;
      els.stop.disabled = false;
      els.detect.textContent = '识别中…';
      setSummary('正在准备 AI 识题…', false);
      try {
        await send('HW_STOP');
        const configResult = await send('GET_CONFIG');
        const cfg = configResult?.config;
        if (requestId !== detectionRequest) return;
        if (!cfg) throw new Error(configResult?.error || '无法读取引擎配置，请刷新页面后重新检测');
        if (cfg.engine === 'api' && !cfg.api?.apiKey) {
          syncConfig(cfg);
          throw new Error('请先在「设置 → 应用设置」配置 API Key，或切换豆包桥接后重新检测');
        }
        await HW.FontDecoder?.prepare(autoDocument || document);
        if (requestId !== detectionRequest) return;
        detectionSnapshot = HW.AIDetection.collect(autoDocument || document);
        watchPage(detectionSnapshot);
        if (!autoRun) log('开始 AI 识题（' + engineName() + '，共 ' + detectionSnapshot.batches.length + ' 批）');
        const result = await send('HW_DETECT_QUESTIONS', { requestId, batches: detectionSnapshot.batches });
        if (requestId !== detectionRequest) return;
        if (!result?.ok) throw new Error(result?.error || 'AI 识题失败，请重新检测');
        if (Array.isArray(result.questions) && !result.questions.length && !nativeQuestions.length) {
          stopWatching();
          detectionSnapshot = null;
          renderDetected([], []);
          return true;
        }
        // 刷课只让 AI 补漏，保留已经可靠绑定的原生题目，避免空识别结果抹掉整卷。
        const nativeItems = nativeQuestions.map(q => {
          const elements = q.el.labels.length ? q.el.labels.map(label => label.input || label.clickEl)
            : q.el.fields.length ? q.el.fields : q.el.iframe ? [q.el.iframe] : q.el.inputs;
          const targets = elements.map(el => detectionSnapshot.ids.get(el));
          const first = detectionSnapshot.refs.get(targets[0])?.el;
          return { ...q.meta, containerId: detectionSnapshot.ids.get(HW.AIDetection.questionRoot(first)),
            inputIds: q.el.labels.length ? [] : targets,
            options: q.el.labels.map((label, index) => ({ key: label.key, targetId: targets[index] })) };
        });
        const nativeIds = new Set(nativeItems.flatMap(q => [...q.inputIds, ...q.options.map(o => o.targetId)]));
        const nativeRoots = new Set(nativeItems.map(q => q.containerId));
        const additions = (result.questions || []).filter(q => !nativeRoots.has(q.containerId) &&
          ![...(q.inputIds || []), ...(q.options || []).map(o => o.targetId)].some(id => nativeIds.has(id)));
        const bound = HW.AIDetection.bind(detectionSnapshot, [...nativeItems, ...additions]);
        renderDetected(bound.questions, bound.pending);
        if (bound.pending.length && !autoRun) reportIssue('识题待确认', bound.pending.map(q => q.reason).join('；'), { question: bound.pending.map(q => q.stem).join('；') });
      } catch (e) {
        if (requestId !== detectionRequest) return;
        stopWatching();
        detectionSnapshot = null;
        HW.questions = [];
        const message = errorText(e);
        setSummary('未检测出题目：' + message, true);
        log('检测未完成：' + message);
        if (message !== CONTEXT_NOTICE) reportIssue('识题失败', message);
        if (autoRun && nativeQuestions.length) {
          detectionSnapshot = nativeSnapshot;
          renderDetected(nativeQuestions, nativePending, '页面读取');
        }
      } finally {
        if (requestId === detectionRequest) {
          detecting = false;
          els.detect.textContent = '检测题目';
          setBusy(false);
        }
      }
      return true;
    }
    els.detect.addEventListener('click', detectQuestions);

    /* 原生读取会在每次 iframe load / DOM 变化后自动重跑，日志里刷出一大片
       「页面读取完成：可处理 0 题」，把刷课那些真正有用的行冲没了（2026-10-21 实测）。
       结果没变就不重复记。 */
    let lastReadSig = '';
    function renderDetected(qs, pending, source = 'AI 识题') {
      HW.questions = qs;
      const cnt = {};
      qs.forEach((q) => (cnt[q.meta.type] = (cnt[q.meta.type] || 0) + 1));
      setSummary(
        qs.length || pending.length
          ? `可处理 ${qs.length} 题` + (pending.length ? `，无法填写 ${pending.length} 题` : '') + '：' + Object.entries(cnt).map(([k, v]) => `${TYPE_NAME[k] || k}${v}`).join('　')
          : '未检测出题目',
        pending.length > 0,
      );
      els.shint.classList.toggle('hidden', !(qs.length + pending.length));
      els.list.innerHTML = '';
      rows = qs.map((q, i) => {
        const r = document.createElement('div');
        r.className = 'item';
        r.innerHTML = `<span class="no">${i + 1}</span><span class="type t-${q.meta.type}"></span><span class="stem"></span><span class="st">待机</span>`;
        r.querySelector('.type').textContent = TYPE_NAME[q.meta.type] || q.meta.type;
        r.querySelector('.stem').textContent = q.meta.stem.replace(/_{2,}/g, '＿＿').slice(0, 60);
        r.dataset.tip = '点击可重新询问本题';
        r.addEventListener('click', () => {
          if (['filled', 'failed', 'skipped'].includes(q._status)) rerun(i);
        });
        els.list.appendChild(r);
        return r;
      });
      pending.forEach((q) => {
        const r = document.createElement('div');
        r.className = 'item pending';
        r.tabIndex = 0; // 键盘也能停在待确认行（0.9.8 加了「重新识别」按钮后丢了可聚焦性）
        r.dataset.tip = q.reason + '｜' + q.stem;
        r.innerHTML = '<span class="no">·</span><span class="type"></span><span class="stem"></span><button type="button" class="retry-detect">重新识别</button><p class="pending-reason"></p>';
        r.querySelector('.pending-reason').textContent = q.reason;
        r.querySelector('.retry-detect').addEventListener('click', detectQuestions);
        const type = r.querySelector('.type');
        type.textContent = TYPE_NAME[q.type] || '未知';
        type.classList.add('t-' + (TYPE_NAME[q.type] ? q.type : 'judge'));
        r.querySelector('.stem').textContent = q.stem;
        els.list.appendChild(r);
      });
      if (pending.length && source === '页面读取') els.smsg.textContent += '；可点「检测题目」调用 AI';
      const sig = `${source}|${qs.length}|${pending.length}|${qs.map((q) => q.meta.type).join(',')}`;
      /* 面板脚本在每一层框架里都有实例，各层会各自记一条一样的「页面读取完成」，
         日志被刷满、刷课那些真正有用的行全被淹掉。原生读取的日志只留顶层那一条。 */
      const quietRead = source === '页面读取' && window.top !== window;
      /* 空读（0 题 0 待确认）不打日志：它在非题目页每几秒就刷一条，
           把真正有用的行全淹了（用户 2026-10-22 抱怨日志太吵）。 */
      const emptyRead = source === '页面读取' && !qs.length && !pending.length;
      if (!autoRun && !quietRead && !emptyRead && (source !== '页面读取' || sig !== lastReadSig)) log(`${source}完成：可处理 ${qs.length} 题，待确认 ${pending.length} 题`);
      lastReadSig = sig;
      els.start.disabled = !qs.length;
    }

    els.start.addEventListener('click', startAnswering);

    /* 开始答题：按钮直接调它，刷课在测验页也调它（auto=true 表示没人盯着，
       简答题策略「ask」不能在刷课时弹窗，按「保留跳过」处理）。 */
    async function startAnswering(opts) {
      if (!$('.issuewarn').classList.contains('hidden')) return false;
      const auto = !!(opts && opts.auto);
      const retry = auto && !!opts.retry;
      if (!HW.questions?.length) return false;
      if (!requireCurrentPage()) return false;
      try {
        const cfg = (await send('GET_CONFIG'))?.config || {};
        if (cfg.engine === 'api' && !cfg.api?.apiKey) {
          els.panel.classList.remove('hidden');
          try { localStorage.setItem('hwApiOpen', '1'); } catch {}
          await refreshKeyRow(cfg);
          log('请在上方粘贴 API Key 并保存，或在设置中切换引擎');
          return false;
        }
        // 简答题策略：ask=开始弹窗询问 / keep=保留跳过 / rewrite=清空重写
        let subjMode = cfg.subjMode || 'ask';
        if (subjMode === 'ask' && auto) subjMode = 'keep';
        if (subjMode === 'ask') {
          const n = HW.questions.filter((q) => q.meta.type === 'subjective' && substantive(HW.Extractor.currentAnswer(q))).length;
          if (n > 0) subjMode = await askSubjMode(n);
          if (subjMode === null) {
            log('已取消开始（未做任何改动）');
            return false;
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
          const cached = retry ? null : await cachedAnswer(q);
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
            _retry: retry,
            _decision: decision,
            _pageAnswer: pageAnswer,
            _refAnswer: refAnswer,
            _skipNote: skipNote,
          });
        }
        const skipCount = questions.filter((q) => q._decision === 'skip').length;
        const rewriteCount = questions.filter((q) => q._decision === 'rewrite').length;
        if (!autoRun) log(
          `开始答题（引擎：${engineName()}，共 ${questions.length} 题` +
            (skipCount ? `，已写且正确 ${skipCount} 题跳过` : '') +
            (rewriteCount ? `，写错 ${rewriteCount} 题将改写` : '') +
            '；只填写不提交）',
        );
        if (!requireCurrentPage()) return false;
        answerPauseReason = '';
        const res = await send('HW_START', { questions, auto });
        if (!res?.ok) {
          log('启动失败：' + (res?.error || '未知错误'));
          setBusy(false);
          return false;
        }
        return true;
      } catch (e) {
        // 任何意外错误都可见 + 按钮解锁，不再"半天没反应"
        log('启动异常：' + (e && e.message ? e.message : e) + '（按钮已解锁，可重试）');
        setBusy(false);
        return false;
      }
    }
    els.stop.addEventListener('click', async () => {
      if (detecting) {
        invalidateDetection('已停止识别，可重新检测；当前 AI 请求返回后才会释放引擎');
        return;
      }
      // 立即本地解锁按钮：后台可能在忙等回答（最长 150 秒）才回"已停止"，
      // 不能依赖它来恢复 UI；迟到的答题消息用 stopRequested 忽略。
      stopRequested = true;
      setBusy(false);
      await send('HW_STOP');
      log('已请求停止（后台正在获取的回答会被丢弃）…');
    });

    /* 刷课先读取原生题目，漏检时调用一次 AI 补漏，再填写并继续原生提交。
       无人值守时简答策略按「保留跳过」处理。
       挂在 HW.Panel 上（每次 init 覆盖，面板只在顶层框架加载，实例唯一）。 */
    async function runHomework(opts = {}) {
      autoRun = true; // 无人值守：自己点选项导致的签名变化不算「页面已变化」
      autoDocument = HW.Watch?.quizDocument?.() || document;
      try {
        await HW.FontDecoder?.prepare(autoDocument);
        const okDetect = readPageQuestions();
        if (!okDetect) throw new Error('没识别成功，不提交测验' + (lastDetectError ? '：' + lastDetectError : ''));
        let aiDetected = false;
        if (!HW.questions?.length) {
          /* 原生题目全部待确认时只补漏一次；仍无法定位的题随卷交给原生提交，
             不因单题不可读而放弃整份测验，也不提前把提交记成成功。 */
          const pendings = [...els.list.querySelectorAll('.item.pending')];
          if (!pendings.length) throw new Error('这一页没有可处理的题目，不提交测验');
          log(`刷课：${pendings.length} 题读不出，先试 AI 识题，读不出就留空提交`);
          const done = await detectQuestions();
          aiDetected = true;
          if (!done) throw new Error('AI 识题没成功，不提交测验');
          if (!HW.questions?.length) {
            reportIssue('识题待确认', `${pendings.length} 题全部无法读取，将继续原生提交流程`);
            return `题目无法读取（${pendings.length} 题），继续原生提交`;
          }
        }
        if (!aiDetected && els.list.querySelector('.item.pending')) {
          /* 无人值守不能停下来等用户点按钮：原生没读全的题（公式图选选项、多空填空等）
             直接自动走一次 AI 识题 —— 这就是「检测题目」按钮本身的能力，只是原来只由点击触发。
             实测 2026-10-21：抓阄先抽后抽那节 5 题可处理 / 1 题待确认，不自动补就叫停了整轮。 */
          setWatchLine('有题目原生没读全，正在调用 AI 识题');
          const done = await detectQuestions();
          if (!done) throw new Error('AI 识题没成功，不提交测验');
          if (!HW.questions?.length) return 'AI 仍未识别到可填写题目，继续原生提交';
          const still = [...els.list.querySelectorAll('.item.pending')];
          /* 用户 2026-10-22 明确「先刷完，不强求正确率」：AI 也没读全的题一律留空提交，
             不再按类型放行（原来只有图片题放行，字形乱码题会把整轮卡死）。 */
          if (still.length) {
            log(`刷课：${still.length} 题读不出（AI 也没读全），留空提交`);
            reportIssue('识题待确认', `${still.length} 题读不出（AI 也没读全），将随卷提交`,
              { question: still.map((el) => (el.querySelector('.stem')?.textContent || '').slice(0, 60)).join('；') });
          }
        }
        if (HW.Watch?.quizDocument && HW.Watch.quizDocument() !== autoDocument) throw new Error('测验页面已切换，不继续填写旧题');
        const started = await startAnswering({ auto: true, retry: !!opts.retry });
        if (!started) throw new Error('没能开始填写，不提交测验');
        // 等后台把这一页的题填完（HW_DONE / HW_STOPPED 都会把按钮解锁）
        const idleMs = Number(opts.timeout) > 0 ? Number(opts.timeout) : 240000;
        let deadline = Date.now() + idleMs;
        let progress = (HW.questions || []).map(q => q._status || 'queued').join('|');
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        while (Date.now() < deadline) {
          await wait(700);
          if (HW.Watch?.quizDocument && HW.Watch.quizDocument() !== autoDocument) throw new Error('测验页面已切换，不继续填写旧题');
          const next = (HW.questions || []).map(q => q._status || 'queued').join('|');
          if (next !== progress) { progress = next; deadline = Date.now() + idleMs; }
          if (els.detect.disabled || !els.stop.disabled) continue; // 还在跑
          break;
        }
        const filled = (HW.questions || []).filter((q) => ['filled', 'fixed', 'skipped'].includes(q._status)).length;
        const failed = (HW.questions || []).filter((q) => q._status === 'failed').length;
        if (els.detect.disabled || !els.stop.disabled) throw new Error('答题长时间无进展，不提交测验');
        if (answerPauseReason) throw new Error(answerPauseReason + '，不提交测验');
        if (failed || filled !== HW.questions.length) {
          /* 用户 2026-10-22：先刷完。个别题填写失败（如「共用选项点击后回读不一致」）
             不再作废整卷：已填的保留，失败题留空，照常提交；分数不再卡 80%。 */
          const unprocessed = HW.questions.length - filled - failed;
          const reason = [failed ? `${failed} 题填写失败` : '', unprocessed ? `${unprocessed} 题未处理` : ''].filter(Boolean).join('，');
          log(`刷课：${reason}，留空随卷提交`);
        }
        return `填了 ${filled} 题`;
      } finally {
        if (!els.stop.disabled) {
          stopRequested = true;
          setBusy(false);
          await send('HW_STOP');
        }
        autoRun = false;
        autoDocument = null;
        /* 填写期间关掉的守卫在这里恢复，但观察器必须一起拆掉：不拆的话，
           收工时 autoRun 刚置回 false，下一次 DOM 变动就会立刻把这一页判成
           「页面已变化」并清空题目列表（真实页面 2026-10-20 日志里就这样刷出来过）。 */
        stopWatching();
      }
    }
    HW.Panel.runHomework = runHomework;

    els.watch.addEventListener('click', toggleWatch);
    els.watchmute.addEventListener('change', async () => {
      const muted = els.watchmute.checked;
      HW.Watch?.setMuted(muted);
      const result = await send('SET_CONFIG', { watchMuted: muted });
      if (!result?.ok) log('静音设置失败：' + (result?.error || '请刷新页面后重试'));
    });

    function setBusy(busy) {
      els.detect.disabled = busy;
      els.start.disabled = busy || !HW.questions?.length;
      els.stop.disabled = !busy;
    }

    function setRow(i, status, tip) {
      const q = HW.questions?.[i];
      if (q) q._status = status;
      if (q) q._error = status === 'failed' ? tip : '';
      if (q && status !== 'failed') q._answerPreview = '';
      const r = rows[i];
      if (!r) return;
      const st = r.querySelector('.st');
      st.textContent = STATUS_TEXT[status] || '·';
      st.className = 'st s-' + status;
      st.dataset.tip = tip || status;
    }

    async function rerun(i) {
      if (!requireCurrentPage()) return;
      stopRequested = false;
      setRow(i, 'asking');
      log(`重问第 ${i + 1} 题…`);
      const res = await send('HW_RERUN', { index: i });
      if (res && !res.ok) log(`重问失败：${res.error}`);
    }

    chrome.runtime.onMessage.addListener((msg) => {
      const { type, payload = {} } = msg || {};
      if (type === 'HW_ISSUE_WRITE_FAILED') { showIssueFailure(payload.error || '存储失败'); return; }
      if (type === 'HW_DETECT_PROGRESS') {
        if (detecting && payload.requestId === detectionRequest) setSummary(`AI 正在识别 ${payload.current}/${payload.total} 批…`, false);
      } else if (type === 'HW_STATUS') {
        if (stopRequested) return;
        setRow(payload.index, payload.status, payload.error || payload.note || '');
        if (payload.status === 'failed' && HW.questions?.[payload.index]) HW.questions[payload.index]._answerPreview = payload.answerPreview || '';
        if (payload.status === 'failed') log(`第 ${payload.index + 1} 题获取答案失败：${payload.error}`);
        if (payload.status === 'skipped' && !autoRun) log(`第 ${payload.index + 1} 题：${payload.note || '已作答，跳过'}`);
      } else if (type === 'HW_ANSWER') {
        if (stopRequested) return; // 已停止：丢弃迟到的回答
        if (autoRun && HW.Watch?.quizDocument && HW.Watch.quizDocument() !== autoDocument) {
          answerPauseReason = '测验页面已切换，不继续填写旧题';
          stopRequested = true;
          setBusy(false);
          send('HW_STOP').catch(() => {});
          return;
        }
        (async () => {
          const i = payload.index;
          try {
            if (!requireCurrentPage()) return;
            const q = HW.questions[i];
            // 最终比对：页面已写的答案与引擎/缓存答案一致 → 无需点击；不一致（或没写）→ 真实填写
            const live = HW.Extractor.currentAnswer(q);
            if (answersMatch(q.meta.type, live, payload.answer)) {
              setRow(i, 'skipped', '答案：' + payload.answer + '（你原来的答案正确，保持不动）');
              if (!autoRun) log(`第 ${i + 1} 题已写且答案正确，无需改写${payload.fromCache ? '（缓存命中）' : ''}`);
              chrome.runtime.sendMessage({ type: 'HW_FILLED', payload: { index: i, fillToken: payload.fillToken, ok: true } });
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
            const vTip = verified === 'unknown' ? '｜（页面不暴露选中状态，按点击成功处理）'
              : verified === false ? autoRun ? '｜校验未通过，本题留空' : '｜校验未通过，已暂停' : '';
            if (!autoRun || verified === false || payload.fallback) log(`第 ${i + 1} 题已填写${payload.fromCache ? '（缓存命中）' : ''}${payload.note ? '｜' + payload.note : ''}${vTip}`);
            chrome.runtime.sendMessage({
              type: 'HW_FILLED',
              payload: { index: i, fillToken: payload.fillToken, ok: verified !== false, error: verified === false ? '填写校验未通过' : undefined },
            });
          } catch (e) {
            setRow(i, 'failed', String(e.message || e));
            log(`第 ${i + 1} 题填写失败：${e.message || e}`);
            chrome.runtime.sendMessage({ type: 'HW_FILLED', payload: { index: i, fillToken: payload.fillToken, ok: false, error: String(e.message || e) } });
          }
        })();
      } else if (type === 'HW_DONE') {
        if (detecting || stopRequested) return;
        stopRequested = false;
        setBusy(false);
        if (payload.paused) {
          answerPauseReason = payload.paused;
          setSummary(payload.paused, true);
          els.panel.classList.remove('hidden'); // 确保面板可见
          log('已暂停：' + payload.paused);
        } else {
          const failed = payload.failed || 0;
          const skipped = payload.skipped || 0;
          if (failed > 0) {
            setSummary(autoRun ? `本页填写 ${payload.filled ?? '?'} 题，${failed} 题留空；原因见异常记录`
              : `完成：填写 ${payload.filled ?? '?'} / 失败 ${failed}（点「失败」行可重答）`, true);
            els.panel.classList.remove('hidden');
            if (!autoRun) log(`全部处理完毕，但有 ${failed} 题未成功（修复 Key 后点「开始」可整页重跑，已成功的题会命中缓存秒填）`);
          } else {
            setSummary(`完成：填写 ${payload.filled ?? payload.total ?? '?'}${skipped ? ` / 保留 ${skipped}` : ''}，请检查后自行提交`, false);
            if (!autoRun) log(`全部处理完毕（共 ${payload.total} 题），提交请自行操作`);
          }
        }
      } else if (type === 'HW_STOPPED') {
        if (detecting || stopRequested) return;
        answerPauseReason = '答题队列已停止';
        stopRequested = false;
        setBusy(false);
        log('队列已停止');
      } else if (type === 'HW_WATCH_FINISHED') {
        setWatchLine('');
        if (payload.cancelled) log('刷课：已停止：' + (payload.reason || '队列已取消'));
        else if (payload.targetRun) log(`刷课：${payload.count}/${payload.total} 门课程开头 ${payload.targetRun} 节已核验（口语例外单列）`);
        else log(payload.limited ? `刷课：${payload.count} 门课的本次限定小节已完成` : `刷课：${payload.count} 门课都走完了（提交与最终成绩请自行核对）`);
        queueInfo = null;
        refreshQueueInfo(true);
      }
    });

    readPageQuestions();

    // 初始化：读取配置回显
    (async () => {
      try {
        const res = await send('GET_CONFIG');
        const cfg = res?.config;
        if (cfg) {
          syncConfig(cfg);
          // 旧版存的是数字档位（可能是已经删掉的 2.5/3/4），下拉会忽略不认识的 id 并保持「自动」
          if (cfg.watchRate) els.rate.value = String(cfg.watchRate);
          els.watchmute.checked = cfg.watchMuted !== false;
          HW.Watch?.setMuted(els.watchmute.checked);
          await send('SET_CONFIG', { watchMuted: els.watchmute.checked });
        } else if (res && res.error) {
          log('提示：' + res.error);
        }
      } catch {
        /* 扩展上下文失效时忽略 */
      }
      // 课程列表页：等站点把卡片画完，再把勾选清单铺出来
      await loadWatchSections();
      await renderCoursesWhenReady();
      updateWatchContext();
      /* 先按后台队列把「正在刷第几门」铺好，再决定要不要自动接续——
         这一页加载过程中按钮和队列信息就已经是真实状态，不用用户再点一下（2026-10-23 反馈）。 */
      await refreshQueueInfo(true);
      // 后台有排队时，新页面一加载就接着刷（跳页后脚本会重新加载，靠这个续上）
      try {
        await HW.Watch?.resumeQueued?.({ onLive: setWatchLine, onNote: watchNote, onStop: watchStopped });
        await refreshQueueInfo(true);
        if (HW.Watch?.running) setWatchLine('接着上一轮排队继续');
      } catch {
        /* 没有排队或后台没响应：当普通页面处理 */
      }
      // 更新提示：只读后台缓存（不联网，自动检查在设置页），且只有功能更新（次版本号变化）才提示
      try {
        const r = await send('CHECK_UPDATE', { cacheOnly: true });
        if (r?.ok && r.major) {
          els.updline.textContent = '';
          els.updline.append(`发现新版本 v${r.latest}（当前 v${r.current}）`, '　');
          const btn = document.createElement('button');
          btn.textContent = '更新';
          btn.className = 'updgo';
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            btn.disabled = true;
            btn.textContent = '更新中…';
            send('HW_RUN_UPDATE').then((res) => {
              els.updline.textContent = res?.ok && res.started
                ? '更新事务已启动；下载、验证与回滚状态请查看设置页「检测更新」'
                : '更新未启动：' + (res?.error || '未知错误') + '（详情见设置页「检测更新」）';
            });
          });
          els.updline.append(btn);
          els.updline.classList.remove('hidden');
        }
      } catch {
        /* 未检查过或读取失败：静默 */
      }
    })();
  }

  HW.Panel = { init };
})();
