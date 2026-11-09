/* 只收集题干、选项和共享材料中的图片，图片不可读时必须报错。 */
(function () {
  'use strict';
  const HW = (window.HW = window.HW || {});
  const ROOT_SEL = '.questionLi,.TiMu,.mark_item,.q-item,.question-item,.question,.exam-question,.topic-item,fieldset';
  function questionRoot(q) {
    const el = q.el || {};
    const target = el.stateInput || el.labels?.[0]?.clickEl || el.labels?.[0]?.input || el.fields?.[0] || el.inputs?.[0] || el.iframe || el.iframes?.[0];
    return el.root || target?.closest?.(ROOT_SEL) || null;
  }
  function imageNodes(q) {
    const root = questionRoot(q);
    const areas = [...(q.el?.contexts || [])];
    if (root?.matches('.questionLi')) {
      areas.push(...root.querySelectorAll('.mark_name,.Zy_TItle,.answer_p'));
    } else if (root) areas.push(root);
    else if (!areas.length) throw new Error('无法定位题目图片区域');
    const images = new Set();
    for (const area of areas) {
      if (area.matches?.('img,canvas,svg')) images.add(area);
      for (const img of area.querySelectorAll('img,canvas,svg')) images.add(img);
    }
    /* 公式图（ans-latex-moudle）也要发：豆包/API 看到渲染后的公式比纯 LaTeX 文字更稳。
       原图直读失败时会走截图，需要用户点工具栏图标授权当前页面。 */
    return [...images];
  }
  async function screenshot(node, capture) {
    if (!node?.isConnected || !node.ownerDocument?.defaultView) throw new Error('题图已离开页面');
    const win = node.ownerDocument.defaultView;
    if (node.ownerDocument.visibilityState !== 'visible') throw new Error('作业标签页不可见，无法截取题图');
    const saved = [], hidden = [];
    let current = win, element = node;
    try {
      while (current) {
        const doc = current.document;
        const host = doc.getElementById('hw-panel-host');
        if (host) { hidden.push([host, host.style.getPropertyValue('visibility'), host.style.getPropertyPriority('visibility')]); host.style.setProperty('visibility', 'hidden', 'important'); }
        for (let parent = element.parentElement; parent; parent = parent.parentElement) saved.push([parent, parent.scrollLeft, parent.scrollTop]);
        saved.push([current, current.scrollX, current.scrollY]);
        if (current === current.top) break;
        element = current.frameElement;
        if (!element) throw new Error('无法读取跨域题目框架');
        current = current.parent;
      }
      node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      await new Promise(resolve => { const timer = setTimeout(resolve, 150); win.requestAnimationFrame(() => { clearTimeout(timer); resolve(); }); });
      const style = win.getComputedStyle(node);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) throw new Error('题图不可见，无法截图');
      let r = node.getBoundingClientRect();
      let rect = { x: r.left, y: r.top, width: r.width, height: r.height };
      current = win;
      while (true) {
        if (rect.width < 1 || rect.height < 1 || rect.x < 0 || rect.y < 0 || rect.x + rect.width > current.innerWidth || rect.y + rect.height > current.innerHeight) throw new Error('题图未完整显示在窗口内，请手动调整页面');
        if (current === current.top) break;
        const frame = current.frameElement;
        if (!frame) throw new Error('无法读取跨域题目框架');
        const fr = frame.getBoundingClientRect();
        const sx = fr.width / frame.offsetWidth, sy = fr.height / frame.offsetHeight;
        rect = { x: fr.left + (frame.clientLeft + rect.x) * sx, y: fr.top + (frame.clientTop + rect.y) * sy, width: rect.width * sx, height: rect.height * sy };
        current = current.parent;
      }
      return await capture({ rect, viewport: { width: current.innerWidth, height: current.innerHeight } });
    } finally {
      for (const [target, x, y] of saved.reverse()) {
        if (target.window === target) target.scrollTo(x, y);
        else { target.scrollLeft = x; target.scrollTop = y; }
      }
      for (const [host, value, priority] of hidden) value ? host.style.setProperty('visibility', value, priority) : host.style.removeProperty('visibility');
    }
  }
  async function collect(q, load, capture) {
    const nodes = imageNodes(q);
    if (!nodes.length) return [];
    /* 公式图带 data 源码，题干/选项文字里已还原成可读公式，不需要再截图或上传；
       只有存在读不出文字的真实图片（照片、图表、手绘、材料图）才需要截图。 */
    const unreadable = nodes.filter(img => !(img.matches?.('img.ans-latex-moudle,img.ans-edrawmath-moudle')
      && HW.AIDetection?.imageText?.(img)));
    if (!unreadable.length) return [];
    /* 题块内有真实图片时整题截一张：题干、全部选项和渲染后的公式都在里面。
       共享材料在题块外时退回逐张（只传读不出文字的那些）。 */
    const root = questionRoot(q);
    const outside = (q.el?.contexts || []).some(c => c?.querySelector?.('img,canvas,svg'));
    if (capture && root && !outside) {
      try { return [await screenshot(root, capture)]; }
      catch (error) { throw new Error('题目图片无法完整截图：' + String(error.message || error) + '（请最大化作业窗口后重试）'); }
    }
    const images = [];
    for (const img of unreadable) {
      const src = img.currentSrc || img.src || img.getAttribute('src');
      let value;
      try {
        if (!src) throw new Error('题图没有可读取的原图');
        value = /^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(src) ? src : await load(src);
        if (!/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(value || '')) throw new Error('题目图片读取失败');
      } catch (error) {
        if (!capture) throw error;
        value = await screenshot(img, capture);
      }
      if (!/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(value || '')) throw new Error('题目图片读取失败');
      images.push(value);
    }
    return images;
  }
  HW.QuestionImages = { imageNodes, questionRoot, collect, screenshot };
})();
