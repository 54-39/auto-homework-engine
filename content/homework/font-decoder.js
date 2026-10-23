/* 超星自定义字体：按TrueType字形SHA-256匹配随包附带的思源字体索引，只在本地还原文字。 */
(function () {
  'use strict';
  const HW = (window.HW = window.HW || {});
  if (HW.FontDecoder) return;
  const states = new WeakMap();
  function glyphs(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = p => view.getUint16(p), i16 = p => view.getInt16(p), u32 = p => view.getUint32(p);
    if (u32(0) !== 0x00010000) throw new Error('暂不支持此页面的字体格式');
    const tables = {};
    for (let i = 0; i < u16(4); i++) {
      const p = 12 + i * 16;
      tables[String.fromCharCode(...bytes.subarray(p, p + 4))] = u32(p + 8);
    }
    const count = u16(tables.maxp + 4), long = i16(tables.head + 50) === 1;
    const offsets = Array.from({ length: count + 1 }, (_, i) => long ? u32(tables.loca + i * 4) : u16(tables.loca + i * 2) * 2);
    const data = id => {
      if (!id || id >= count) return null;
      const start = offsets[id];
      let end = offsets[id + 1];
      // 子集字体和原字体的四字节对齐填充可能不同，不把尾部零填充算进字形。
      while (end > start && bytes[tables.glyf + end - 1] === 0) end--;
      return end > start ? bytes.subarray(tables.glyf + start, tables.glyf + end) : null;
    };
    const result = new Map();
    const add = (code, id) => { const value = data(id); if (value) result.set(String.fromCodePoint(code), value); };
    let supported = false;
    for (let c = 0; c < u16(tables.cmap + 2); c++) {
      const p = tables.cmap + u32(tables.cmap + 8 + c * 8), format = u16(p);
      if (format === 4) {
        supported = true;
        const segments = u16(p + 6) / 2, ends = p + 14, starts = ends + segments * 2 + 2;
        const deltas = starts + segments * 2, ranges = deltas + segments * 2;
        for (let s = 0; s < segments; s++) {
          const start = u16(starts + s * 2), end = u16(ends + s * 2), range = u16(ranges + s * 2), delta = i16(deltas + s * 2);
          for (let code = start; code <= end && code < 65535; code++) {
            const id = range ? u16(ranges + s * 2 + range + (code - start) * 2) : code;
            add(code, range && id === 0 ? 0 : (id + delta) & 65535);
          }
        }
      } else if (format === 12) {
        supported = true;
        for (let g = 0; g < u32(p + 12); g++) {
          const q = p + 16 + g * 12, start = u32(q), end = u32(q + 4), first = u32(q + 8);
          for (let code = start; code <= end && code <= 0x10ffff; code++) add(code, first + code - start);
        }
      }
    }
    if (!supported) throw new Error('暂不支持此页面的字体字符表');
    return result;
  }
  function source(doc) {
    if (!doc.querySelector('.font-cxsecret')) return '';
    let found = '';
    const read = rules => {
      for (const rule of rules) {
        if (rule.type === 5 && rule.style.fontFamily.replace(/["']/g, '').trim() === 'font-cxsecret') found = rule.style.src;
        else if (rule.cssRules) read(rule.cssRules);
      }
    };
    for (const sheet of doc.styleSheets) { try { read(sheet.cssRules); } catch { /* 跨域样式表不能直接读 */ } }
    if (!found && [...doc.querySelectorAll('.font-cxsecret')].some(el => doc.defaultView.getComputedStyle(el).fontFamily.includes('font-cxsecret'))) {
      throw new Error('无法读取页面的加密字体，请导出页面结构');
    }
    return found;
  }
  function documents(root) {
    const out = [];
    const walk = (doc, depth) => {
      if (!doc || depth > 6) return;
      out.push(doc);
      for (const frame of doc.querySelectorAll('iframe')) {
        try { if (frame.contentDocument?.body && !frame.contentDocument.body.isContentEditable) walk(frame.contentDocument, depth + 1); } catch { /* 只读取同源题目 */ }
      }
    };
    walk(root, 0);
    return out;
  }
  async function prepareDoc(doc) {
    const src = source(doc);
    if (!src) return;
    const previous = states.get(doc);
    if (previous?.source === src) return previous.promise;
    const state = { source: src, map: null };
    states.set(doc, state);
    state.promise = (async () => {
      const encoded = /url\(["']?data:[^,]+;base64,([^"')\s]+)/i.exec(src)?.[1];
      if (!encoded) throw new Error('页面字体不是可本地读取的内嵌字体，请导出页面结构');
      const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
      const entries = await Promise.all([...glyphs(bytes)].map(async ([char, data]) => [char,
        [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(n => n.toString(16).padStart(2, '0')).join('')]));
      let response;
      try {
        response = await chrome.runtime.sendMessage({ type: 'HW_FONT_MAP', payload: { hashes: [...new Set(entries.map(e => e[1]))] } });
      } catch (error) {
        if (/extension context invalidated/i.test(error.message || String(error))) throw new Error('插件已更新或重载，请刷新页面（F5）后重试');
        throw error;
      }
      if (!response?.ok) throw new Error(response?.error || '无法读取本地字体索引');
      state.map = new Map(entries.map(([char, hash]) => [char, response.map[hash] || null]));
    })();
    return state.promise;
  }
  const ready = root => documents(root).every(doc => {
    try { const src = source(doc); const state = states.get(doc); return !src || state?.source === src && !!state.map; } catch { return false; }
  });
  function translate(doc, text) {
    const src = source(doc);
    if (!src) return text;
    const state = states.get(doc);
    if (state?.source !== src || !state.map) throw new Error('页面字体尚未还原，请稍候');
    return [...text].map(char => {
      if (!state.map.has(char)) return char;
      const value = state.map.get(char);
      /* 索引里查不到这个字形（多半是页面换了字体子集）：以前这里直接抛错，
         整页读取跟着崩、一份测验直接作废（2026-10-22 传统文化/大学英语实测：
         「页面字体有字形无法唯一还原」把两份测验都卡掉）。
         改成留占位符，由 panel 把**那一题**降级成待人工、其余题照常填。
         用户明确：先刷完；但也不能把还原不了的字当成真答案硬填。 */
      if (!value) {
        (state.bad || (state.bad = new Set())).add(char);
        return '\uFFFD';
      }
      return value;
    }).join('');
  }
  HW.FontDecoder = {
    glyphs, ready, prepare: root => Promise.all(documents(root).map(prepareDoc)),
    decodeNode: node => node.parentElement && node.ownerDocument.defaultView.getComputedStyle(node.parentElement).fontFamily.includes('font-cxsecret')
      ? translate(node.ownerDocument, node.data) : node.data,
    decodeText: (el, text) => el && (el.matches('.font-cxsecret') || el.querySelector('.font-cxsecret')) ? translate(el.ownerDocument, text) : text,
  };
})();
