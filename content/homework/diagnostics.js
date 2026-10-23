/* 异常发生时同步保存现场；不等待导航，不读取表单值、Cookie 或页面存储。 */
(function () {
  const HW = (window.HW = window.HW || {});
  if (HW.Diagnostics) return;
  const clean = value => String(value || '')
    .replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [已隐藏]')
    .replace(/\bsk-[\w-]{8,}/g, '[已隐藏]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[邮箱已隐藏]')
    .replace(/\b1[3-9]\d{9}\b/g, '[手机号已隐藏]');
  const safeURL = (value, base) => {
    if (!value) return '';
    if (/^(data|blob|javascript|file|about):/i.test(value)) return '[非网页地址]';
    try { const u = new URL(value, base); return /^https?:$/.test(u.protocol) ? (u.origin + u.pathname).slice(0, 1000) : '[非网页地址]'; }
    catch { return '[无效地址]'; }
  };
  const escape = value => clean(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  function capture() {
    const scene = { schema: 1, capturedAt: new Date().toISOString(), status: 'captured',
      url: safeURL(location.href), title: clean(document.title),
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
      limits: { documents: 10, nodes: 12000, characters: 400000, milliseconds: 200 }, documents: [], truncated: false };
    const started = performance.now(), seen = new Set();
    let nodes = 0, characters = 0;
    const exhausted = () => nodes >= scene.limits.nodes || characters >= scene.limits.characters || performance.now() - started > scene.limits.milliseconds;
    function read(doc, path, depth = 0) {
      if (seen.has(doc)) return;
      seen.add(doc);
      const row = { path, url: safeURL(doc.URL), title: clean(doc.title), readyState: doc.readyState,
        status: 'readable', html: '', media: [], fonts: [], stylesheets: [], fontRules: [], truncated: false };
      scene.documents.push(row);
      let size = 0;
      // 目录很长时正文可能先截断，仍需找到后面的任务 iframe。
      const frameNodes = doc.querySelectorAll('iframe,frame');
      const parts = [], frames = [...frameNodes].slice(0, 10);
      if (frameNodes.length > frames.length) { row.truncated = true; row.omittedFrames = frameNodes.length - frames.length; }
      function append(text) {
        const room = Math.min(100000 - size, scene.limits.characters - characters);
        if (text.length > room) row.truncated = true;
        const piece = text.slice(0, Math.max(0, room));
        parts.push(piece); size += piece.length; characters += piece.length;
      }
      function walk(node, level = 0) {
        if (exhausted() || size >= 100000 || level > 80) { row.truncated = true; return; }
        nodes++;
        if (node.nodeType === 3) {
          const text = node.textContent, room = Math.min(100000 - size, scene.limits.characters - characters);
          if (text.length > room) row.truncated = true;
          append(escape(text.slice(0, Math.max(0, room)))); return;
        }
        if (node.nodeType !== 1) return;
        const tag = node.localName;
        if (/^(script|style|noscript|template|svg|canvas|nav|header|footer)$/.test(tag) || node.id === 'hw-panel-host') return;
        // 隐藏控件保留结构、不留值；不复制用户资料区及密码/令牌字段。
        if (tag === 'input' && /^(password|file)$/i.test(node.type) ||
            /(?:password|passwd|api.?key|access.?token|authorization|user-?info|avatar)/i.test(node.id + ' ' + node.className + ' ' + (node.getAttribute('name') || ''))) return;
        append('<' + tag);
        for (const attr of node.attributes) {
          if (!/^(id|class|name|type|typename|role|title|aria-label|aria-hidden|aria-expanded|aria-selected|aria-checked|disabled|checked|contenteditable|data|data-type|data-id|data-index|data-status|data-jobid|href|src)$/.test(attr.name)) continue;
          const value = /^(href|src)$/.test(attr.name) ? safeURL(attr.value, doc.baseURI) : attr.value.slice(0, 300);
          append(' ' + attr.name + '="' + escape(value) + '"');
        }
        append('>');
        if (/^(iframe|frame)$/.test(tag)) { /* 框架正文单独采集。 */ }
        else if (/^(input|textarea)$/.test(tag) || node.isContentEditable || doc.designMode === 'on') append('[表单内容已隐藏]');
        else for (const child of node.childNodes) { walk(child, level + 1); if (exhausted() || size >= 100000) break; }
        if (exhausted() || size >= 100000) row.truncated = true;
        append('</' + tag + '>');
      }
      try {
        // 编辑器 iframe 仍留控件结构，正文视为用户输入。
        if (doc.body?.isContentEditable || doc.designMode === 'on') append('<body>[编辑器内容已隐藏]</body>');
        else walk(doc.body || doc.documentElement);
        row.html = parts.join('');
        row.media = [...doc.querySelectorAll('video,audio')].slice(0, 12).map(v => ({
          tag: v.localName, src: safeURL(v.currentSrc || v.getAttribute('src'), doc.baseURI),
          currentTime: v.currentTime, duration: Number.isFinite(v.duration) ? v.duration : null,
          paused: v.paused, ended: v.ended, playbackRate: v.playbackRate, readyState: v.readyState,
          networkState: v.networkState, error: v.error ? { code: v.error.code, message: clean(v.error.message) } : null }));
        row.fonts = [...(doc.fonts || [])].slice(0, 40).map(f => ({ family: clean(f.family), status: f.status }));
        row.stylesheets = [...doc.styleSheets].slice(0, 40).map(s => s.href ? safeURL(s.href) : '[内嵌样式]');
        let fontSize = 0;
        for (const sheet of [...doc.styleSheets].slice(0, 40)) {
          if (exhausted()) { row.truncated = true; break; }
          try {
            for (const rule of [...sheet.cssRules].slice(0, 2000)) {
              if (fontSize >= 10000) { row.truncated = true; break; }
              if (rule.type !== 5 && !/font-cxsecret/.test(rule.selectorText || '')) continue;
              const text = clean(rule.cssText.replace(/url\([^)]*\)/gi, 'url([字体地址已省略])')).slice(0, 10000 - fontSize);
              row.fontRules.push(text); fontSize += text.length;
            }
          } catch { /* 跨域样式表仍保留地址，不能读取规则。 */ }
        }
      } catch (e) { row.status = 'partial'; row.error = clean(e.message); }
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i], framePath = path + '/frame[' + i + ']';
        if (scene.documents.length >= scene.limits.documents || exhausted() || depth >= 6) {
          row.truncated = true; row.omittedFrames = (row.omittedFrames || 0) + frames.length - i; break;
        }
        try {
          const child = frame.contentDocument;
          if (!child) throw new Error('跨域、沙箱限制或尚未加载');
          read(child, framePath, depth + 1);
        } catch (e) {
          scene.documents.push({ path: framePath, url: safeURL(frame.getAttribute('src'), doc.baseURI), status: 'unreadable', reason: clean(e.message) });
        }
      }
    }
    try { read(document, 'top'); }
    catch (e) { scene.status = 'partial'; scene.error = clean(e.message); }
    scene.truncated = scene.documents.some(d => d.truncated) || exhausted();
    scene.visitedNodes = nodes;
    return scene;
  }
  const safeCapture = () => {
    try { return capture(); }
    catch (e) { return { status: 'unavailable', reason: clean(e.message) }; }
  };
  HW.Diagnostics = { capture: safeCapture };
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === 'HW_DIAGNOSTIC_CAPTURE') { respond(safeCapture()); return false; }
  });
})();
