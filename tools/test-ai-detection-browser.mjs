/* 真实 Chromium DOM + 固定模型返回值；不连接外部服务或个人浏览器配置。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.tmp-ai-tests');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'edge-'));
const edge = process.env.EDGE_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function fixtureBoot() {
  window.testCalls = [];
  window.testMessages = [];
  window.testMode = 'mixed';
  window.testApiKey = 'fixture-only';
  window.frameCourseResults = [];
  window.testStore = { config: { engine: 'api', panelMode: 'homework', verify2: true } };
  window.testStorageListeners = [];
  const listeners = [];
  const currentConfig = () => ({ ...testStore.config, api: { ...testStore.config.api, apiKey: window.testApiKey } });
  window.setExternalConfig = (patch) => {
    const oldValue = currentConfig();
    testStore.config = { ...oldValue, ...patch, api: { ...oldValue.api, ...patch.api } };
    window.testApiKey = testStore.config.api.apiKey;
    testStorageListeners.forEach(fn => fn({ config: { oldValue, newValue: currentConfig() } }, 'local'));
    return currentConfig();
  };
  window.chrome = {
    storage: { local: { get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, testStore[key]])), set: async value => Object.assign(testStore, value) },
      onChanged: { addListener: fn => testStorageListeners.push(fn) } },
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: async (msg) => {
        testCalls.push(msg.type);
        testMessages.push(msg);
        if (msg.type === 'GET_CONFIG') return { ok: true, config: currentConfig() };
        if (msg.type === 'SET_CONFIG') return { ok: true, config: setExternalConfig(msg.payload) };
        if (msg.type === 'KEY_LIST') return { ok: true, list: [] };
        if (msg.type === 'CHECK_UPDATE') return { ok: false };
        if (msg.type === 'HW_WATCH_ACCESS_REQUEST') return window.courseAccessResult || {ok:true};
        if (msg.type === 'HW_BRIDGE_SPLIT') return window.bridgeSplitResult || { ok: true };
        if (msg.type === 'HW_WATCH_COURSES') {
          window.lastCourseRefresh = msg.payload?.refresh === true;
          if (window.testCourseError) return { ok: false, error: '模拟课程读取失败' };
          if (window.holdCourseRead) return new Promise(resolve => { window.releaseCourseRead = () => { window.holdCourseRead = false; resolve({ ok: true, courses: window.frameCourseResults }); }; });
          return { ok: true, courses: window.frameCourseResults };
        }
        if (msg.type === 'HW_ISSUE_ADD' && window.testIssueFailure) return { ok: false, error: '模拟磁盘写入失败' };
        if (msg.type === 'HW_DETECT_QUESTIONS') {
          const result = () => ({ ok: true, questions: window.makeSpecs(HW.AIDetection.collect()).concat(window.unknownSpec(HW.AIDetection.collect())) });
          if (testMode === 'error') return { ok: false, error: '模拟网络超时，请重新检测' };
          if (testMode === 'empty') return { ok: true, questions: [] };
          if (testMode === 'loading') return new Promise((resolve) => { window.releaseDetection = () => { resolve(result()); window.releaseDetection = null; }; });
          return result();
        }
        return { ok: true };
      },
    },
  };
  window.emitHWMessage = message => listeners.forEach(listener => listener(message));
  document.querySelectorAll('[role="checkbox"]').forEach((el) => el.addEventListener('click', () => el.setAttribute('aria-checked', String(el.getAttribute('aria-checked') !== 'true'))));
  /* 每门课刷几节已改到设置页（config.watchSections），面板不再有勾选框：测试直接改配置并触发 onChanged */
  window.setWatchSections = n => setExternalConfig({ watchSections: n });
  document.querySelectorAll('#judge .answerBg').forEach((el) => el.addEventListener('click', () => {
    document.querySelectorAll('#judge .answerBg').forEach((row) => row.setAttribute('aria-checked', String(row === el)));
    document.querySelector('[name="answer30"]').value = el.querySelector('[data]').getAttribute('data');
  }));
}

async function browserChecks() {
  const out = [];
  const check = async (name, fn) => {
    try { await fn(); out.push({ name, ok: true }); } catch (e) { out.push({ name, ok: false, error: e.stack || e.message }); }
  };
  const ok = (v, msg = 'assertion failed') => { if (!v) throw new Error(msg); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await check('异常现场保留题目与同源iframe，排除表单值、编辑器、脚本、面板和敏感字段', () => {
    const scene = HW.Diagnostics.capture(), text = JSON.stringify(scene);
    ok(scene.schema === 1 && scene.documents.length >= 3 && !scene.truncated);
    ok(text.includes('选一个正确选项') && text.includes('嵌入页面的问答题'));
    for (const secret of ['SECRET_PASSWORD', 'SECRET_EXISTING_ANSWER', 'SECRET_NAV', 'SECRET_TOKEN', 'fixtureBoot', 'hw-panel-host']) ok(!text.includes(secret), secret + ' leaked');
    ok(scene.documents.some(d => d.html.includes('textarea')) && scene.documents.some(d => d.html.includes('编辑器内容已隐藏')));
  });
  await check('现场标注沙箱iframe不可读，删除网址凭据及个人联系方式，页面变化不改变已采现场', async () => {
    const extra = document.createElement('section');
    extra.innerHTML = '<p>现场原文 test@example.com 13812345678</p><a href="https://user:pass@example.test/page?token=URL_SECRET#HASH_SECRET">链接</a><iframe sandbox srcdoc="<p>FRAME_SECRET</p>"></iframe>';
    document.body.append(extra);
    try {
      await wait(60);
      const scene = HW.Diagnostics.capture(), text = JSON.stringify(scene);
      extra.querySelector('p').textContent = '页面已跳走';
      ok(text.includes('现场原文') && !JSON.stringify(scene).includes('页面已跳走'));
      ok(scene.documents.some(d => d.status === 'unreadable' && d.reason));
      for (const secret of ['test@example.com', '13812345678', 'URL_SECRET', 'HASH_SECRET', 'user:pass', 'FRAME_SECRET']) ok(!text.includes(secret), secret + ' leaked');
    } finally { extra.remove(); }
  });
  await check('超长现场有明确截断标记，不会生成无限制结构', () => {
    const extra = document.createElement('section');
    extra.textContent = '超长现场'.repeat(100000);
    document.body.prepend(extra);
    try {
      const scene = HW.Diagnostics.capture();
      ok(scene.truncated && scene.documents[0].truncated);
      ok(scene.documents[0].html.length <= 100000 && JSON.stringify(scene).length < 600000);
      ok(scene.documents.some(d => d.html?.includes('嵌入页面的问答题')), '目录截断不能遗漏后面的任务框架');
    } finally { extra.remove(); }
  });
  const byId = (s, id) => [...s.refs].find(([, ref]) => ref.el.id === id)?.[0];
  window.makeSpecs = (s) => {
    const q = (type, container, stem, options = [], inputs = []) => ({ type, containerId: byId(s, container), stem,
      options: options.map((id, i) => ({ key: type === 'judge' ? ['T', 'F'][i] : 'ABCDEFGH'[i], targetId: byId(s, id) })), inputIds: inputs.map((id) => byId(s, id)), writing: false });
    return [
      q('choice', 'choice', '1. 选一个正确选项', ['ra', 'rb']),
      q('multi', 'multi', '2. 选择全部正确选项', ['ma', 'mb', 'mc']),
      q('judge', 'judge', '3. 判断命题是否成立', ['jt', 'jf']),
      q('blank', 'question41', '4. 两处____，____仅需填写一个数值', [], ['blankEditor']),
      q('subjective', 'subjective', '5. 解释概念并分段', [], ['editable']),
      q('subjective', 'duplicateA', '相同题干', [], ['ta']),
      q('subjective', 'duplicateB', '相同题干', [], ['tb']),
      q('subjective', 'frameQuestion', '嵌入页面的问答题', [], ['frameText']),
    ];
  };
  window.unknownSpec = (s) => ({ type: 'unknown', containerId: byId(s, 'sort'), stem: '拖动完成排序', options: [], inputIds: [], reason: '排序题需确认' });
  const s = HW.AIDetection.collect();
  const specs = makeSpecs(s);
  let bound;
  await check('采集不依赖题型名称，并排除导航、脚本、已有值和敏感字段', () => {
    const text = s.batches.join('');
    for (const secret of ['SECRET_PASSWORD', 'SECRET_EXISTING_ANSWER', 'SECRET_NAV', 'SECRET_TOKEN', 'fixtureBoot', 'CHAPTER_SEARCH', 'DISCUSSION_FORM']) ok(!text.includes(secret), secret + ' leaked');
    ok(text.includes('选一个正确选项'));
    ok(s.refs.has(byId(s, 'frameText')), 'same-origin frame missing');
  });
  await check('混合版式、陌生题型名称、判断图标、单空编辑器和同源 iframe 均绑定成功', () => {
    bound = HW.AIDetection.bind(s, specs);
    ok(bound.questions.length === 8, JSON.stringify(bound.pending));
    ok(bound.pending.length === 0, JSON.stringify(bound.pending));
    ok(bound.questions[3].meta.blanks === 1);
    ok(bound.questions[3].el.iframes.length === 1);
    ok(bound.questions[2].el.stateInput?.name === 'answer30');
  });
  await check('原生单选填写并回读，重复填写不取消选中', async () => {
    await HW.Filler.fill(bound.questions[0], 'B');
    await HW.Filler.fill(bound.questions[0], 'B');
    ok(document.querySelector('#rb').checked);
    ok(HW.Filler.verify(bound.questions[0], 'B') === true);
  });
  await check('ARIA 多选精确选择与取消，并保留页面已有答案判断', async () => {
    const q = bound.questions[1];
    await HW.Filler.fill(q, 'AC');
    ok(HW.Filler.verify(q, 'AC') === true);
    ok(HW.Extractor.currentAnswer(q) === 'AC');
    await HW.Filler.fill(q, 'B');
    ok(HW.Filler.verify(q, 'B') === true);
  });
  await check('判断 true/false 真值、隐藏状态与回读不退化', async () => {
    const q = bound.questions[2];
    await HW.Filler.fill(q, '错');
    ok(document.querySelector('[name="answer30"]').value === 'false');
    ok(HW.Filler.verify(q, '错') === true);
    ok(HW.Extractor.currentAnswer(q) === 'F');
    const wrong = { ...specs[2], options: [...specs[2].options].reverse().map((o, i) => ({ ...o, key: ['T', 'F'][i] })) };
    const rejected = HW.AIDetection.bind(s, [wrong]);
    ok(rejected.questions.length === 0 && rejected.pending.some((p) => p.reason.includes('真值')));
  });
  await check('单空不按下划线数填写，富文本正文与回读正确', async () => {
    const q = bound.questions[3];
    let rejected = false;
    try { await HW.Filler.fill(q, '0.4；0.4'); } catch { rejected = true; }
    ok(rejected, '不能静默丢弃多余的填空答案');
    await HW.Filler.fill(q, '0.4');
    ok(document.querySelector('#blankEditor').contentDocument.body.textContent.trim() === '0.4');
    ok(HW.Filler.verify(q, '0.4') === true);
    ok(HW.Extractor.currentAnswer(q) === '0.4');
  });
  await check('contenteditable 与同源 iframe 文本框可填写，正文换行保留', async () => {
    await HW.Filler.fill(bound.questions[4], '第一段\n\n第二段');
    ok(HW.Extractor.currentAnswer(bound.questions[4]).includes('第二段'), 'contenteditable 填写后读不回：' + JSON.stringify(HW.Extractor.currentAnswer(bound.questions[4])));
    ok(HW.Filler.verify(bound.questions[4], '第一段\n\n第二段') === true, 'contenteditable verify 失败');
    ok(HW.Filler.verify(bound.questions[4], '第一段') === false, '不完整答案不能通过校验');
    await HW.Filler.fill(bound.questions[7], 'frame answer');
    ok(HW.Extractor.currentAnswer(bound.questions[7]) === 'frame answer', 'iframe 文本框读不回：' + JSON.stringify(HW.Extractor.currentAnswer(bound.questions[7])));
    ok(HW.AIDetection.isCurrent(s), 'answer edits invalidated structural snapshot');
  });
  await check('同题干的不同输入框不会去重，重叠批次相同结果可去重', () => {
    ok(HW.AIDetection.bind(s, [...specs, ...specs]).questions.length === 8);
    ok(bound.questions.filter((q) => q.meta.stem === '相同题干').length === 2);
  });
  await check('虚构编号、跨题位置、重叠位置和特殊题型保留为待确认', () => {
    const fake = { ...specs[0], options: [{ key: 'A', targetId: 'missing' }, specs[0].options[1]] };
    ok(HW.AIDetection.bind(s, [fake]).questions.length === 0);
    const cross = { ...specs[5], inputIds: specs[6].inputIds };
    ok(HW.AIDetection.bind(s, [cross]).questions.length === 0);
    const conflict = HW.AIDetection.bind(s, [specs[0], { ...specs[0], stem: '另一个题干' }]);
    ok(conflict.questions.length === 0);
    ok(HW.AIDetection.bind(s, [unknownSpec(s)]).pending.some((p) => p.reason.includes('排序')));
    ok(HW.AIDetection.bind(s, []).pending.length > 0, 'unassigned fields silently disappeared');
  });
  await check('题干变化和同版式节点重建均使旧结果失效', () => {
    const snapshot = HW.AIDetection.collect();
    const questions = makeSpecs(snapshot);
    HW.AIDetection.bind(snapshot, questions);
    const h = document.querySelector('#choice h3');
    const original = h.textContent;
    h.textContent = '替换后的题目';
    ok(!HW.AIDetection.isCurrent(snapshot));
    let failed = false;
    try { HW.AIDetection.bind(snapshot, questions); } catch { failed = true; }
    ok(failed);
    h.textContent = original;
    const el = document.querySelector('#ra');
    const clone = el.cloneNode(true);
    el.replaceWith(clone);
    ok(!HW.AIDetection.isCurrent(snapshot));
    clone.replaceWith(el);
  });
  await check('AI 不可通过选择整页容器混用两道题的输入位置', () => {
    const snap = HW.AIDetection.collect();
    const rootId = [...snap.refs].find(([, r]) => r.el.tagName === 'MAIN')[0];
    const q = { ...makeSpecs(snap)[5], type: 'blank', containerId: rootId,
      inputIds: [byId(snap, 'ta'), byId(snap, 'tb')] };
    const result = HW.AIDetection.bind(snap, [q]);
    ok(result.questions.length === 0 && result.pending.some((p) => p.reason.includes('不同')));
  });
  await check('无关区域的倒计时变化不会使已识别的题目失效', () => {
    const ticker = document.createElement('p');
    ticker.textContent = '剩余时间 10:00';
    document.querySelector('main').appendChild(ticker);
    const snap = HW.AIDetection.collect();
    const data = makeSpecs(snap);
    ticker.textContent = '剩余时间 09:59';
    ok(HW.AIDetection.bind(snap, data).questions.length === 8);
    ok(HW.AIDetection.isCurrent(snap));
    ticker.remove();
  });
  await check('长页面分批、保留编号和上下文；单段超限明确失败', () => {
    const extra = document.createElement('div');
    for (let i = 0; i < 70; i++) {
      const section = document.createElement('section');
      section.innerHTML = `<h3>第${i}道新题 ${'说明文字'.repeat(20)}</h3><textarea></textarea>`;
      extra.appendChild(section);
    }
    document.querySelector('main').appendChild(extra);
    const long = HW.AIDetection.collect();
    ok(long.batches.length > 1, 'no batching');
    ok(long.batches.every((b) => b.length <= 20000));
    extra.textContent = '很'.repeat(13000);
    let failed = false;
    try { HW.AIDetection.collect(); } catch { failed = true; }
    ok(failed);
    extra.remove();
  });
  await check('未读取的图片和不可访问的嵌入区域不进入填写队列', async () => {
    const extra = document.createElement('section');
    extra.id = 'imageQuestion';
    extra.innerHTML = '<h3>根据图片作答</h3><img width="20" height="20"><textarea id="imageAnswer"></textarea><iframe sandbox srcdoc="<textarea></textarea>"></iframe>';
    document.querySelector('main').appendChild(extra);
    await new Promise((resolve) => extra.querySelector('iframe').addEventListener('load', resolve, { once: true }));
    const snap = HW.AIDetection.collect();
    const result = HW.AIDetection.bind(snap, [{ type: 'subjective', stem: '根据图片作答', containerId: byId(snap, 'imageQuestion'), inputIds: [byId(snap, 'imageAnswer')], options: [] }]);
    ok(result.questions.length === 0);
    ok(result.pending.some((q) => q.reason.includes('图片')));
    ok(result.pending.some((q) => q.reason.includes('不可读取')));
    extra.remove();
  });

  await check('下拉、普通输入、富文本混排按页面顺序识别并填写，逐空回读严格一致', async () => {
    const extra = document.createElement('section');
    extra.className = 'TiMu'; extra.id = 'mixedBlanks';
    extra.innerHTML = '<h3>分别填写朝代、作者与要点</h3><fieldset><input id="mixedText"></fieldset><fieldset><select id="mixedSelect"><option value="">请选择</option><option value="PRIVATE_SELECT_VALUE">宋代</option><option value="other">唐代</option></select></fieldset><iframe id="mixedEditor" srcdoc="<body contenteditable=\'true\'></body>"></iframe>';
    document.querySelector('main').append(extra);
    await new Promise(resolve => extra.querySelector('iframe').addEventListener('load', resolve, { once: true }));
    try {
      const snap = HW.AIDetection.collect();
      ok(snap.batches.join('').includes('<option>宋代</option>'));
      ok(!snap.batches.join('').includes('PRIVATE_SELECT_VALUE'), '站点内部选项值被发送');
      const spec = { type: 'blank', containerId: byId(snap, 'mixedBlanks'), stem: '分别填写', options: [], inputIds: ['mixedText', 'mixedSelect', 'mixedEditor'].map(id => byId(snap, id)) };
      const result = HW.AIDetection.bind(snap, [spec]);
      ok(result.questions.length === 1, JSON.stringify(result.pending));
      const q = result.questions[0];
      ok(q.meta.slotOptions[1].join(',') === '宋代,唐代');
      let changes = 0;
      extra.querySelector('select').addEventListener('change', () => changes++);
      await HW.Filler.fill(q, '苏轼；宋代；有恒');
      ok(HW.Filler.verify(q, '苏轼；宋代；有恒') === true);
      ok(changes === 1 && HW.Extractor.currentAnswer(q) === '苏轼;宋代;有恒');
      extra.querySelector('input').value = '错误内容';
      ok(HW.Filler.verify(q, '苏轼；宋代；有恒') === false, '非空错误内容被当成成功');
      extra.querySelector('select').value = '';
      ok(HW.Extractor.currentAnswer(q) === '错误内容;;有恒', '空位回读发生错位');
      for (const answer of ['苏轼；宋代', '苏轼；；有恒', '苏轼；明代；有恒']) {
        let failed = false;
        try { await HW.Filler.fill(q, answer); } catch { failed = true; }
        ok(failed, '数量或选项错误未拒绝：' + answer);
        ok(extra.querySelector('input').value === '错误内容', '验证失败前发生部分填写');
      }
      ok(HW.AIDetection.bind(snap, [{ ...spec, inputIds: [...spec.inputIds].reverse() }]).questions.length === 0, '倒序填空未拒绝');
    } finally { extra.remove(); }
  });
  await check('共享材料按原文并入每个子题；材料变化失效，不混用两个子题位置', () => {
    const extra = document.createElement('div'); extra.id = 'materialSet';
    extra.innerHTML = '<div id="sharedMaterial"><h3>阅读材料</h3><table><tr><th>年份</th><th>收入</th></tr><tr><td>2020</td><td>200</td></tr></table></div><div class="TiMu" id="subOne"><h4>计算增长率</h4><input id="subInputOne"></div><div class="TiMu" id="subTwo"><h4>解释原因</h4><textarea id="subInputTwo"></textarea></div>';
    document.querySelector('main').append(extra);
    try {
      const snap = HW.AIDetection.collect();
      const specs = ['One', 'Two'].map((name, i) => ({ type: i ? 'subjective' : 'blank', stem: i ? '解释原因' : '计算增长率', containerId: byId(snap, 'sub' + name), contextIds: [byId(snap, 'sharedMaterial')], inputIds: [byId(snap, 'subInput' + name)], options: [] }));
      const result = HW.AIDetection.bind(snap, [...specs, ...specs]);
      ok(result.questions.length === 2, JSON.stringify(result.pending));
      ok(result.questions.every(q => q.meta.stem.includes('年份') && q.meta.stem.includes('2020') && q.meta.stem.includes('200')));
      extra.querySelector('td').textContent = '2021';
      ok(!HW.AIDetection.isCurrent(snap), '共享材料变化未使旧题失效');
      extra.querySelector('td').textContent = '2020';
      const cross = { ...specs[0], containerId: byId(snap, 'materialSet'), inputIds: specs.flatMap(q => q.inputIds) };
      ok(HW.AIDetection.bind(snap, [cross]).questions.length === 0);
      ok(HW.AIDetection.bind(snap, [{ ...specs[0], contextIds: [byId(snap, 'subTwo')] }]).questions.length === 0, '材料混入其他题的控件');
    } finally { extra.remove(); }
  });
  await check('共用十四选项十个空保持完整材料、逐空填写回读且不重复取消', async () => {
    const extra = document.createElement('div'); extra.className = 'TiMu'; extra.id = 'sharedChoice';
    const words = ['ambitious', 'blessed with', 'ruin', 'take on', 'cliff', 'breathtaking', 'eruption', 'splendor', 'formation', 'transparent', 'majestic', 'immemorial', 'daring', 'extraordinary'];
    extra.innerHTML = '<div class="Zy_TItle">Zhangjiajie: A Natural Wonder. The park is (6) both wildlife and vegetation.</div><ul class="mark_letter">' + words.map((word, i) => '<li>' + String.fromCharCode(65 + i) + '. <p>' + word + '</p></li>').join('') + '</ul>' + Array.from({ length: 10 }, (_, i) => '<div class="B-answerCon" id="sharedSlot' + i + '">' + words.map((word, j) => '<label><span class="num_option" data="' + String.fromCharCode(65 + j) + '">' + String.fromCharCode(65 + j) + '</span><input type="hidden" value="' + String.fromCharCode(65 + j) + '"></label>').join('') + '</div>').join('');
    document.querySelector('main').append(extra);
    let clicks = 0;
    extra.querySelectorAll('.num_option').forEach((span) => span.addEventListener('click', () => {
      clicks++;
      const selected = span.classList.contains('check_answer');
      span.closest('.B-answerCon').querySelectorAll('.num_option').forEach((el) => el.classList.remove('check_answer'));
      if (!selected) span.classList.add('check_answer');
    }));
    try {
      const snap = HW.AIDetection.collect();
      const result = HW.AIDetection.bind(snap, [{ type: 'blank', stem: '依次完成十空', containerId: byId(snap, 'sharedChoice'), inputIds: Array.from({ length: 10 }, (_, i) => byId(snap, 'sharedSlot' + i)), options: [] }]);
      ok(result.questions.length === 1, JSON.stringify(result.pending));
      const q = result.questions[0];
      ok(q.meta.blanks === 10 && q.meta.slotOptions.every((options) => options.length === 14));
      ok(q.meta.stem.includes('Zhangjiajie') && q.meta.slotOptions[0][13] === 'N. extraordinary');
      const answer = [...'KILEFBMNJH'].map((letter) => letter + '. ' + words[letter.charCodeAt(0) - 65]).join(';');
      await HW.Filler.fill(q, answer);
      ok(HW.Filler.verify(q, answer) === true);
      ok(HW.Extractor.currentAnswer(q) === answer);
      ok(HW.AIDetection.isCurrent(snap), '选中状态不应使结构失效');
      await HW.Filler.fill(q, answer);
      ok(clicks === 10, '已选答案被重复点击取消');
      let rejected = false;
      try { await HW.Filler.fill(q, answer.replace('K. majestic', 'K. 错误选项')); } catch { rejected = true; }
      ok(rejected && clicks === 10, '错位答案应在点击前拒绝');
      extra.querySelectorAll('.mark_letter li')[2].innerHTML = 'C. <p>rural scenery; rural landscape</p>';
      const punctuated = JSON.stringify(Array.from({ length: 10 }, () => 'C. rural scenery; rural landscape'));
      await HW.Filler.fill(q, punctuated);
      ok(HW.Filler.verify(q, punctuated) === true && HW.Extractor.currentAnswer(q) === punctuated, '选项内部的分号不应拆成两个空');
      extra.querySelector('.mark_letter li').textContent = 'A. altered';
      ok(!HW.AIDetection.isCurrent(snap), '共用选项变化未使结构失效');
    } finally { extra.remove(); }
  });
  await check('上传、拖拽、多选下拉不能伪装成文字题或在漏检时消失', () => {
    const extra = document.createElement('div');
    document.querySelector('main').append(extra);
    try {
      for (const control of ['<input type="file">', '<div draggable="true">拖动选项</div>', '<select multiple><option value="a">甲</option><option value="b">乙</option></select>']) {
        extra.innerHTML = '<section id="specialQuestion"><h3>完成特殊操作后说明</h3>' + control + '<textarea id="specialText"></textarea></section>';
        const snap = HW.AIDetection.collect();
        const result = HW.AIDetection.bind(snap, [{ type: 'subjective', stem: '完成操作', containerId: byId(snap, 'specialQuestion'), options: [], inputIds: [byId(snap, 'specialText')] }]);
        ok(result.questions.length === 0 && result.pending.length > 0, '特殊控件被当成普通文字题');
        ok(HW.AIDetection.bind(snap, []).pending.length > 0, '控件漏检后未提示');
      }
    } finally { extra.remove(); }
  });

  const surveyFrame = document.createElement('iframe');
  surveyFrame.src = '/page/questionnaire/answerQuestionChapter';
  document.body.append(surveyFrame);
  await new Promise(resolve => surveyFrame.addEventListener('load', resolve, { once: true }));
  const surveyDoc = surveyFrame.contentDocument;
  await check('问卷隐藏原生选项按题读取，不把选项内层当作另一题', () => {
    const questions = HW.Extractor.extract(surveyDoc);
    ok(questions.length === 3, JSON.stringify(questions.map(q => q.meta)));
    ok(questions[0].meta.stem === '您的性别？' && questions[0].meta.options[0].text === '男');
    ok(questions[1].meta.type === 'multi' && questions[2].meta.type === 'subjective');
  });
  await check('问卷选项绑定、填写和回读一致，内外层控件不重复报待确认', async () => {
    const snapshot = HW.AIDetection.collect(surveyDoc);
    const id = el => snapshot.ids.get(el);
    const items = [...surveyDoc.querySelectorAll('.question-item')].map((el, i) => ({
      type: ['choice', 'multi', 'subjective'][i], containerId: id(el), stem: el.querySelector('.topic-txt').textContent,
      options: [...el.querySelectorAll('.optionRadio,.optionCheckbox')].map((o, j) => ({ key: 'AB'[j], targetId: id(o) })),
      inputIds: [...el.querySelectorAll('textarea')].map(id),
    }));
    const boundSurvey = HW.AIDetection.bind(snapshot, items);
    ok(boundSurvey.questions.length === 3 && boundSurvey.pending.length === 0, JSON.stringify(boundSurvey.pending));
    for (const [i, answer] of ['B', 'AB', '问卷文字'].entries()) {
      await HW.Filler.fill(boundSurvey.questions[i], answer);
      for (let n = 0; n < 20 && HW.Filler.verify(boundSurvey.questions[i], answer) === false; n++) await wait(50);
      ok(HW.Filler.verify(boundSurvey.questions[i], answer) === true, '第 ' + i + ' 题回读失败');
    }
    ok(HW.AIDetection.isCurrent(snapshot), '填写使问卷题目失效');
    ok(surveyDoc.querySelectorAll('input:checked').length === 3);
  });
  await check('限定测验文档采集时不混入外层页面与残留问卷', () => {
    const quizDoc = document.querySelector('#nested').contentDocument;
    const snapshot = HW.AIDetection.collect(quizDoc);
    ok(snapshot.documents.size === 1 && snapshot.documents.has(quizDoc));
    ok(!snapshot.batches.join('').includes('您的性别') && !snapshot.batches.join('').includes('选一个正确选项'));
  });
  await check('同一份问卷跨题选项不能绑定，未识别区域按题去重', () => {
    const snapshot = HW.AIDetection.collect(surveyDoc);
    const items = [...surveyDoc.querySelectorAll('.question-item')];
    const result = HW.AIDetection.bind(snapshot, [{ type: 'choice', stem: '混题', containerId: snapshot.ids.get(surveyDoc.querySelector('#answer_form')),
      options: items.slice(0, 2).map((el, i) => ({ key: 'AB'[i], targetId: snapshot.ids.get(el.querySelector('.optionRadio,.optionCheckbox')) })), inputIds: [] }]);
    ok(!result.questions.length && result.pending.length <= 4, JSON.stringify(result.pending));
  });
  await check('已手动结束的问卷不作为待答题，也不触发章节测验分类', () => {
    surveyDoc.querySelector('.tip').textContent = '手动结束';
    ok(HW.Extractor.extract(surveyDoc).length === 0);
    const snapshot = HW.AIDetection.collect(surveyDoc);
    ok(!snapshot.batches.join('').includes('您的性别'));
    ok(!HW.AIDetection.bind(snapshot, []).pending.length);
    const original = document.querySelector('main');
    original.hidden = true;
    try { ok(!HW.Watch.quizDocument(), '问卷被当作章节测验'); }
    finally { original.hidden = false; }
  });
  surveyFrame.remove();
  const nativeFixture = document.createElement('div');
  nativeFixture.innerHTML = `<section class="questionLi" typename="单选题" id="question901"><h3 class="mark_name">原生单选无需检测</h3><label class="answerBg"><span class="num_option">A</span><span class="answer_p">甲</span></label><label class="answerBg"><span class="num_option">B</span><span class="answer_p">乙</span></label></section>
    <section class="questionLi" typename="多选题" id="question902"><h3 class="mark_name">原生多选无需检测</h3><label class="answerBg"><span class="num_option">A</span><span class="answer_p">甲</span></label><label class="answerBg"><span class="num_option">B</span><span class="answer_p">乙</span></label></section>
    <section class="questionLi" typename="判断题" id="question903"><h3 class="mark_name">原生判断无需检测</h3><label class="answerBg"><span class="num_option" data="true">A</span></label><label class="answerBg"><span class="num_option" data="false">B</span></label></section>
    <section class="questionLi" typename="填空题" id="question904"><h3 class="mark_name">原生填空无需检测____</h3><input type="text" name="unused" hidden><textarea id="nativeBlank"></textarea></section>
    <section class="questionLi" typename="简答题" id="question905"><h3 class="mark_name">原生简答无需检测</h3><textarea></textarea></section>
    <section class="questionLi" typename="陌生题型" id="question906"><h3 class="mark_name">未知题型不可默认成单选</h3><label class="answerBg"><span class="num_option">A</span>甲</label><label class="answerBg"><span class="num_option">B</span>乙</label></section>`;
  document.querySelector('main').append(nativeFixture);
  window.testApiKey = '';
  HW.Panel.init();
  const ui = document.querySelector('#hw-panel-host').shadowRoot;
  /* 悬浮球 0.9.9 起用 Pointer Events 拖动，展开/收起只认真正的 click（detail>0） */
  ui.querySelector('.fab').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  ok(!ui.querySelector('.panel').classList.contains('hidden'), 'panel was not actually opened');
  ok(!testCalls.includes('HW_DETECT_QUESTIONS'), 'opening panel must not send page data');
  ok(!testCalls.includes('HW_ISSUE_ADD'), '正常打开面板不应产生异常记录');
  const until = async (fn) => {
    for (let i = 0; i < 100; i++) { if (fn()) return; await wait(20); }
    throw new Error('UI wait timed out');
  };
  await check('面板与刷课复用中性灰选中态，输入聚焦不增加外圈', async () => {
    await until(() => ui.querySelector('.apisec').getBoundingClientRect().height > 0);
    const input = ui.querySelector('.keyinput');
    input.focus(); await wait(200);
    ok(getComputedStyle(input).outlineStyle === 'none' && getComputedStyle(input).boxShadow === 'none');
    input.blur();
    for (const selector of ['.modeslot .ddtrig', '.rateslot .ddtrig']) {
      setExternalConfig({ engine: 'api', panelMode: selector.includes('rateslot') ? 'watch' : 'homework' });
      const trigger = ui.querySelector(selector);
      await until(() => trigger.getBoundingClientRect().height > 0);
      trigger.click();
      const option = ui.querySelector('.ddlist:not(.hidden) [aria-selected="true"]');
      ok(option, '没有显示下拉选项');
      const color = getComputedStyle(option).backgroundColor.match(/\d+/g).map(Number);
      ok(Math.max(...color) - Math.min(...color) < 15, '下拉选中项仍是蓝色');
      ok(getComputedStyle(trigger).outlineStyle === 'none', '下拉框仍有外圈');
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    const color = getComputedStyle(ui.querySelector('.watchmute')).accentColor.match(/\d+/g).map(Number);
    ok(Math.max(...color) - Math.min(...color) < 40, '刷课勾选态仍是蓝色');
    setExternalConfig({ engine: 'api', panelMode: 'homework' });
  });
  await check('主面板保留 Key 和二次判断，低频项移入设置且首次保存仍提示风险', async () => {
    ok(!ui.querySelector('.engineslot, .keylist, .issuebtn'), '引擎、已保存 Key 列表或异常记录仍占据主面板');
    await until(() => ui.querySelector('.apisec').getBoundingClientRect().height > 0);
    ok(ui.querySelector('.keyinput') && ui.querySelector('.v2input'), '常用 API 操作被移出面板');
    ui.querySelector('.settingsbtn').click();
    await until(() => testMessages.some(m => m.type === 'OPEN_SETTINGS' && m.payload?.section === 'app'));
    ok(ui.querySelector('.modeslot .ddtrig'), '模式入口丢失');
    ui.querySelector('.keyinput').value = 'first-use-fixture';
    ui.querySelector('.savekey').click();
    await until(() => ui.querySelector('.keymodal').getBoundingClientRect().height > 0);
    ok(!testCalls.includes('KEY_SAVE') && !testApiKey, '首次风险确认前已保存或启用 Key');
    ui.querySelector('.mcancel').click();
    ui.querySelector('.keyinput').value = '';
    ui.querySelector('.keyinput').dispatchEvent(new Event('input'));
  });
  await check('打开即显示学习通原生五类题目，无 Key、无 AI 请求且不自动答题', async () => {
    await until(() => HW.questions.some(q => q.meta.stem.includes('原生单选')));
    const native = HW.questions.filter(q => q.meta.stem.startsWith('原生'));
    ok(native.length === 5, JSON.stringify(native.map(q => q.meta)));
    ok(native.map(q => q.meta.type).join() === 'choice,multi,judge,blank,subjective');
    ok(!ui.querySelector('.start').disabled);
    ok(!testCalls.includes('HW_DETECT_QUESTIONS') && !testCalls.includes('HW_START'));
    ok(ui.querySelectorAll('.pending').length > 0, '未知题型消失或被默认为单选');
    window.nativeUIReady = true;
    await new Promise(resolve => { window.resumeNativeUI = resolve; });
    ui.querySelector('.start').click(); await wait(30);
    ok(!testCalls.includes('HW_START'), '无 Key 时仍发送了答题请求');
    const blank = native.find(q => q.meta.type === 'blank');
    await HW.Filler.fill(blank, '本地填写');
    ok(HW.Filler.verify(blank, '本地填写'), '恢复后的原生填空不能填写');
  });
  await check('原生题目的嵌套题块、隐藏选项及隐藏附件不重复报漏题', async () => {
    const extra = document.createElement('div');
    extra.innerHTML = `<div class="TiMu"><section class="questionLi" typename="单选题" id="question911"><h3 class="mark_name">1. 总线原生题目</h3><label class="answerBg"><span class="num_option">A</span>甲</label><label class="answerBg"><span class="num_option">B</span>乙</label></section></div>
      <section class="questionLi" typename="单选题" id="question912"><h3 class="mark_name">2. 总线原生题目</h3><label class="answerBg"><span class="num_option">A</span>甲</label><label class="answerBg"><span class="num_option">B</span>乙</label></section>
      <section class="questionLi" typename="单选题" id="question913"><h3 class="mark_name">3. 总线原生题目</h3><label class="answerBg"><span class="num_option">A</span>甲</label><label class="answerBg"><span class="num_option">B</span>乙</label><div hidden><label class="answerBg"><span class="num_option">C</span>隐藏模板</label><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"><input type="file"><div draggable="true">隐藏工具</div></div></section>`;
    nativeFixture.append(extra);
    try {
      await until(() => HW.questions.filter(q => q.meta.stem.includes('总线原生题目')).length === 3);
      ok(![...ui.querySelectorAll('.pending .stem')].some(el => el.textContent.includes('总线原生题目')), '同一道原生题目又被报为待确认');
      const q = HW.questions.find(q => q.meta.stem.startsWith('3. 总线'));
      ok(q.meta.options.length === 2, '隐藏选项参与识题');
      ok(!testCalls.includes('HW_DETECT_QUESTIONS'));
      const image = document.createElement('img');
      image.width = 20; image.height = 20;
      image.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      extra.querySelector('#question913 .mark_name').append(image);
      await until(() => !HW.questions.some(q => q.meta.stem.startsWith('3. 总线')));
      const pending = [...ui.querySelectorAll('.pending')].filter(el => el.querySelector('.stem').textContent.includes('3. 总线'));
      ok(pending.length === 1 && pending[0].querySelector('.type').textContent === '单选', '图片待确认被误写为题型未知或重复计数');
      ok(pending[0].dataset.tip.includes('题型已识别') && pending[0].dataset.tip.includes('图片'));
    } finally { extra.remove(); }
  });
  await check('超星公式图读取已有LaTeX，原生题干、四个选项及AI采集均完整，不误报图片', async () => {
    const extra = document.createElement('div');
    extra.className = 'TiMu';
    const latex = value => `<img class="ans-latex-moudle" data="${encodeURIComponent(JSON.stringify(value))}" width="20" height="20" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">`;
    extra.innerHTML = `<section class="questionLi" typename="单选题" id="question918"><h3 class="mark_name">公式题：有 ${latex('n')} 个设备</h3>` +
      ['\\log_2 n', 'n', '2n', 'n^2'].map((value, i) => `<label class="answerBg"><span class="num_option">${'ABCD'[i]}</span><span class="answer_p">${latex(value)}${i === 0 ? '向上取整' : ''}</span></label>`).join('') + '</section>';
    nativeFixture.append(extra);
    try {
      await until(() => HW.questions.some(q => q.meta.stem.startsWith('公式题：')));
      const q = HW.questions.find(q => q.meta.stem.startsWith('公式题：'));
      ok(q.meta.stem.includes('$n$'), q.meta.stem);
      ok(q.meta.options.map(o => o.text).join('|') === 'A$\\log_2 n$向上取整|B$n$|C$2n$|D$n^2$', JSON.stringify(q.meta));
      ok(![...ui.querySelectorAll('.pending .stem')].some(el => el.textContent.includes('公式题：')), '有公式元数据仍误报图片待确认');
      ok(HW.AIDetection.collect().batches.join('').includes('\\log_2 n'), '手动 AI 检测资料丢失公式');
      extra.querySelector('img').setAttribute('data', encodeURIComponent(JSON.stringify('m')));
      await until(() => HW.questions.some(q => q.meta.stem.startsWith('公式题：') && q.meta.stem.includes('$m$')));
      extra.querySelector('img').setAttribute('data', '%broken');
      await until(() => !HW.questions.some(q => q.meta.stem.startsWith('公式题：')));
      ok([...ui.querySelectorAll('.pending')].some(el => el.dataset.tip.includes('公式题：') && el.dataset.tip.includes('图片')), '损坏公式数据被当作已读取');
      ok(!testCalls.includes('HW_DETECT_QUESTIONS'));
    } finally { extra.remove(); }
  });
  await check('延迟加载的章节 iframe 自动显示题目，换题后本地刷新且不调用 AI', async () => {
    const frame = document.createElement('iframe');
    nativeFixture.append(frame);
    frame.srcdoc = `<section class="questionLi" typename="单选题" id="question907"><h3 class="mark_name">内嵌原生题目</h3><label class="answerBg"><span class="num_option">A</span>甲</label><label class="answerBg"><span class="num_option">B</span>乙</label></section>`;
    await until(() => HW.questions.some(q => q.meta.stem === '内嵌原生题目'));
    frame.contentDocument.querySelector('h3').textContent = '内嵌原生新题';
    await until(() => HW.questions.some(q => q.meta.stem === '内嵌原生新题'));
    ok(!HW.questions.some(q => q.meta.stem === '内嵌原生题目'));
    ok(!testCalls.includes('HW_DETECT_QUESTIONS'));
  });
  await check('刷课 AI 补漏空答或失败不抹掉原生题目，仍填写并放行提交', async () => {
    const originalSend = chrome.runtime.sendMessage, originalKey = testApiKey;
    window.testApiKey = 'fixture-only';
    chrome.runtime.sendMessage = async message => {
      if (message.type !== 'HW_START') return originalSend(message);
      setTimeout(() => {
        HW.questions.forEach((q,index) => emitHWMessage({type:'HW_STATUS',payload:{index,status:'skipped'}}));
        emitHWMessage({type:'HW_DONE',payload:{total:HW.questions.length,filled:0,skipped:HW.questions.length,failed:0}});
      },20);
      testCalls.push(message.type);
      return {ok:true};
    };
    try {
      for (const mode of ['empty','error','mixed']) {
        window.testMode = mode;
        const before = testCalls.length;
        const result = await HW.Panel.runHomework();
        ok(result.includes('填了') && HW.questions.some(q => q.meta.stem.includes('原生单选')), '原生题目丢失');
        const targets=HW.questions.flatMap(q=>q.el.labels.length ? q.el.labels.map(label=>label.input||label.clickEl)
          : q.el.fields.length ? q.el.fields : q.el.iframe ? [q.el.iframe] : q.el.inputs);
        ok(new Set(targets).size===targets.length,'AI 补漏重复占用了原生答题位置：'+mode);
        ok(testCalls.slice(before).filter(type => type==='HW_DETECT_QUESTIONS').length===1, 'AI 补漏重复调用');
        ok(testCalls.slice(before).filter(type => type==='HW_START').length===1, '没有继续填写原生题');
      }
    } finally {chrome.runtime.sendMessage=originalSend;window.testApiKey=originalKey;}
  });
  await check('刷课所有题均无法识别时只补漏一次，继续原生提交且不虚报已提交', async () => {
    const frame=document.createElement('iframe'), originalWatch=HW.Watch, originalKey=testApiKey;
    window.testApiKey='fixture-only';
    frame.srcdoc='<section class="questionLi" typename="上传题"><h3 class="mark_name">无法自动上传的题目</h3><input type="file"></section>';
    document.body.append(frame);
    await new Promise(resolve=>frame.addEventListener('load',resolve,{once:true}));
    HW.Watch={...originalWatch,quizDocument:()=>frame.contentDocument};
    window.testMode='empty';
    try {
      const before=testCalls.length;
      const result=await HW.Panel.runHomework();
      ok(result.includes('继续原生提交') && !result.includes('已留空提交'),result);
      ok(testCalls.slice(before).filter(type=>type==='HW_DETECT_QUESTIONS').length===1);
      ok(!testCalls.slice(before).includes('HW_START'));
    } finally {HW.Watch=originalWatch;window.testApiKey=originalKey;frame.remove();}
  });
  await check('刷课等待答案时测验换页，迟到答案停止且不填写旧文档', async () => {
    const frame=document.createElement('iframe'), originalWatch=HW.Watch, originalSend=chrome.runtime.sendMessage, originalFill=HW.Filler.fill, originalKey=testApiKey;
    window.testApiKey='fixture-only';
    const html='<section class="questionLi" id="question900" typename="单选题"><h3 class="mark_name">页面切换回归题</h3><input name="answer900" type="hidden"><div class="answerBg"><span class="num_option">A.</span><span class="answer_p">甲</span></div><div class="answerBg"><span class="num_option">B.</span><span class="answer_p">乙</span></div></section>';
    frame.srcdoc=html;document.body.append(frame);await new Promise(resolve=>frame.onload=resolve);
    HW.Watch={...originalWatch,quizDocument:()=>frame.contentDocument};
    let writes=0, stops=0;
    HW.Filler.fill=async()=>{writes++;};
    chrome.runtime.sendMessage=async message=>{
      if(message.type==='HW_STOP')stops++;
      if(message.type!=='HW_START')return originalSend(message);
      setTimeout(()=>{frame.onload=()=>emitHWMessage({type:'HW_ANSWER',payload:{index:0,answer:'A',fillToken:'old-frame'}});frame.srcdoc=html;},20);
      return{ok:true};
    };
    try {
      let error;try{await HW.Panel.runHomework();}catch(e){error=e;}
      ok(error?.message.includes('测验页面已切换'),error?.message||'旧页答案未被停止');
      ok(writes===0&&stops>0,'仍尝试填写旧文档或未停止旧请求');
    } finally {HW.Watch=originalWatch;chrome.runtime.sendMessage=originalSend;HW.Filler.fill=originalFill;window.testApiKey=originalKey;frame.remove();}
  });
  nativeFixture.remove();
  window.testApiKey = 'fixture-only';
  window.setDetectionUI = async (mode) => {
    if (window.releaseDetection) {
      ui.querySelector('.stop').click();
      releaseDetection();
      await wait(30);
    }
    window.testMode = mode;
    ui.querySelector('.detect').click();
    if (mode === 'loading') await until(() => window.releaseDetection);
    else await until(() => !ui.querySelector('.detect').disabled);
    return { summary: ui.querySelector('.smsg').textContent, startDisabled: ui.querySelector('.start').disabled,
      detecting: ui.querySelector('.detect').disabled, pending: ui.querySelectorAll('.pending').length, ready: HW.questions.length };
  };
  await check('检测异步状态、重复点击、停止与迟到结果丢弃', async () => {
    const callsBefore = testCalls.filter((s) => s === 'HW_DETECT_QUESTIONS').length;
    const state = await setDetectionUI('loading');
    ok(state.startDisabled && state.detecting);
    ui.querySelector('.detect').click();
    ok(testCalls.filter((s) => s === 'HW_DETECT_QUESTIONS').length === callsBefore + 1);
    ui.querySelector('.stop').click();
    releaseDetection();
    await wait(30);
    ok(HW.questions.length === 0 && ui.querySelector('.start').disabled);
  });
  await check('答题轮次标记：每轮 requestId 独立，旧轮状态不再回写新列表', async () => {
    const state = await setDetectionUI('mixed');
    ok(state.ready === 8, JSON.stringify(state));
    const startIds = [];
    const realSend = chrome.runtime.sendMessage;
    window.testApiKey = 'round-key'; // 过 startAnswering 的 Key 检查
    chrome.runtime.sendMessage = async (msg) => {
      if (msg.type === 'HW_START') startIds.push(msg.payload.requestId);
      return realSend(msg);
    };
    try {
      // 第一轮：start（主观题若弹策略窗选「保留」继续）→ 拿到轮次 id → 停止
      ui.querySelector('.start').click();
      await until(() => startIds.length === 1 || !ui.querySelector('.subjmodal').classList.contains('hidden'));
      if (!ui.querySelector('.subjmodal').classList.contains('hidden')) ui.querySelector('.subjkeep').click();
      await until(() => startIds.length === 1);
      ui.querySelector('.stop').click();
      await wait(30);
      // 第二轮：重新检测并 start，requestId 必须与第一轮不同
      await setDetectionUI('mixed');
      ui.querySelector('.start').click();
      await until(() => startIds.length === 2 || !ui.querySelector('.subjmodal').classList.contains('hidden'));
      if (!ui.querySelector('.subjmodal').classList.contains('hidden')) ui.querySelector('.subjkeep').click();
      await until(() => startIds.length === 2);
      // 第二轮进行中验证：两轮 requestId 独立；旧轮状态不回写，当前轮状态正常更新（先验证再停止）
      ok(startIds.length === 2 && startIds[0] != null && startIds[0] !== startIds[1],
        '两轮 HW_START 的 requestId 应存在且不同：' + JSON.stringify(startIds));
      const row = ui.querySelector('.list .item');
      const before = row?.textContent || '';
      emitHWMessage({ type: 'HW_STATUS', payload: { requestId: startIds[0], index: 0, status: 'asking' } });
      ok((ui.querySelector('.list .item')?.textContent || '') === before, '旧轮次状态回写了新列表');
      emitHWMessage({ type: 'HW_STATUS', payload: { requestId: startIds[1], index: 0, status: 'asking' } });
      ok((ui.querySelector('.list .item')?.textContent || '') !== before, '当前轮次状态未更新');
      ui.querySelector('.stop').click();
      await wait(30);
    } finally { chrome.runtime.sendMessage = realSend; window.testApiKey = 'fixture-only'; ui.querySelector('.stop')?.click(); }
  });
  await check('可处理与待确认分列，检测完成不会自动开始作答', async () => {
    const starts = testCalls.filter(type => type === 'HW_START').length;
    const state = await setDetectionUI('mixed');
    ok(state.ready === 8 && state.pending === 1, JSON.stringify(state));
    ok(testCalls.filter(type => type === 'HW_START').length === starts);
    ok(ui.querySelector('.summary').getAttribute('aria-live') === 'polite');
    ui.querySelector('.pending').focus();
    ok(ui.activeElement === ui.querySelector('.pending'), 'pending item cannot be reached by keyboard');
  });
  await check('页面变化自动禁用旧题目；网络错误清空旧结果并解锁检测', async () => {
    const h = document.querySelector('#choice h3');
    h.textContent += '页面变化';
    await wait(250);
    ok(HW.questions.length === 0 && ui.querySelector('.start').disabled);
    h.textContent = '1. 选一个正确选项';
    const error = await setDetectionUI('error');
    ok(error.startDisabled && !error.detecting && /未检测出题目/.test(error.summary));
  });
  await check('点击后展开且一次只显示一空的填空编辑器可全部识别并逐空填写', async () => {
    const section = document.createElement('section');
    section.id = 'lazyBlanks';
    section.innerHTML = '<h3>读书第一要什么，第二要什么，第三要什么？</h3>' + [0, 1, 2].map(i =>
      `<div class="blankItemDiv">第${i + 1}空：<div class="blankItemInp" style="min-height:32px"><div class="InpDIV">点击填写</div><div class="textDIV" style="display:none"><iframe id="lazy${i}" srcdoc="<body contenteditable='true'></body>"></iframe></div></div></div>`).join('');
    document.querySelector('main').append(section);
    const frames = [...section.querySelectorAll('iframe')];
    await Promise.all(frames.map(f => new Promise(resolve => f.addEventListener('load', resolve, { once: true }))));
    const saved = [];
    frames.forEach((f, i) => f.contentDocument.body.addEventListener('blur', () => { saved[i] = f.contentDocument.body.textContent.trim(); }));
    section.querySelectorAll('.InpDIV').forEach(opener => opener.addEventListener('click', () => {
      section.querySelectorAll('.textDIV').forEach(e => { e.style.display = 'none'; });
      opener.nextElementSibling.style.display = 'block';
    }));
    try {
      const snap = HW.AIDetection.collect();
      const result = HW.AIDetection.bind(snap, [{ type: 'blank', containerId: byId(snap, 'lazyBlanks'), stem: '读书三要',
        options: [], inputIds: frames.map(f => byId(snap, f.id)) }]);
      ok(result.questions.length === 1 && result.questions[0].meta.blanks === 3, JSON.stringify(result.pending));
      await HW.Filler.fill(result.questions[0], '有志；有识；有恒');
      ok(HW.Filler.verify(result.questions[0], '有志；有识；有恒'));
      ok(frames.every((f, i) => f.contentDocument.body.textContent.trim() === ['有志', '有识', '有恒'][i]));
      ok(saved.join('；') === '有志；有识；有恒', '最后一空未失焦同步到站点提交载体：' + saved.join('；'));
      ok(HW.AIDetection.isCurrent(snap), '逐空展开导致已识别位置失效');
    } finally { section.remove(); }
  });
  await check('低分不再单独上报，由收尾的未完成记录携带分数', async () => {
    const original = HW.Watch;
    HW.Watch = { ...original, quizGrade: () => ({ score: 66.7, total: 100 }), nodes: () => [], activeChapterId: () => null };
    const count = () => testMessages.filter(m => m.type === 'HW_ISSUE_ADD').length;
    const before = count();
    try {
      ok(typeof HW.Panel.reportGrade !== 'function', '独立的低分上报入口应已移除（v0.9.35）');
      ok(count() === before, '低分本身不应单独产生异常记录');
    } finally { HW.Watch = original; }
  });
  window.setPanelMode = async mode => {
    ui.querySelector('.modeslot .ddtrig').click();
    ui.querySelector('.ddlist:not(.hidden) [data-id="' + mode + '"]').click();
    await wait(100);
  };
  await check('API 可切换写题和刷课独立界面，下拉支持键盘操作', async () => {
    await setPanelMode('watch');
    ok(ui.querySelector('.watchview').getBoundingClientRect().height > 0);
    ok(ui.querySelector('.btnrow').getBoundingClientRect().height === 0);
    ok(ui.querySelector('.list').getBoundingClientRect().height === 0);
    const trigger = ui.querySelector('.modeslot .ddtrig');
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(100);
    ok(!ui.querySelector('.panel').classList.contains('watchmode'));
    ok(ui.querySelector('.btnrow').getBoundingClientRect().height > 0);
    ok(ui.querySelector('.watchview').getBoundingClientRect().height === 0);
  });
  await check('模式直接在解题API、刷课API和豆包之间切换并保存引擎', async () => {
    await setPanelMode('bridge');
    ok(testStore.config.engine === 'bridge' && testStore.config.panelMode === 'homework');
    ok(ui.querySelector('.modeslot .ddname').textContent === '豆包');
    await setPanelMode('watch');
    ok(testStore.config.engine === 'api' && testStore.config.panelMode === 'watch');
    ok(ui.querySelector('.modeslot .ddname').textContent === '刷课（API）');
    await setPanelMode('homework');
    ok(ui.querySelector('.modeslot .ddname').textContent === '解题（API）');
    const input = ui.querySelector('.keyinput'), label = ui.querySelector('.keylabel');
    input.value = ''; input.blur(); await wait(220);
    const before = label.getBoundingClientRect().top;
    input.focus(); await wait(220);
    ok(label.getBoundingClientRect().bottom <= input.getBoundingClientRect().top + 1 && label.getBoundingClientRect().top < before);
    ok(getComputedStyle(input).boxShadow === 'none' && getComputedStyle(input).outlineStyle === 'none', 'Key聚焦不能增加外框或光晕');
    ok(parseFloat(getComputedStyle(input).borderTopLeftRadius) >= input.clientHeight / 2);
    input.blur();
  });
  await check('应用设置的引擎、Key 和二次判断即时回显，换 Key 不清除已识别题目', async () => {
    await setDetectionUI('mixed');
    const questions = [...HW.questions];
    ok(questions.length > 0, '缺少已识别题目，无法验证换 Key 的影响');
    try {
      setExternalConfig({ api: { apiKey: '' }, verify2: false });
      await until(() => ui.querySelector('.keylabel').textContent === '粘贴 API Key' && !ui.querySelector('.v2input').checked);
      ok(ui.querySelector('.keywarn').getBoundingClientRect().height > 0, '无 Key 时缺少准备提示');
      const drawer = ui.querySelector('.apitoggle');
      drawer.click(); await wait(30);
      ok(ui.querySelector('.apisec').getBoundingClientRect().height === 0, '抽屉未折叠');
      ok(ui.querySelector('.keywarn').getBoundingClientRect().height > 0, '折叠抽屉后缺少 DeepSeek 入口');
      ok(ui.querySelector('.keywarn a').href === 'https://platform.deepseek.com/api_keys');
      drawer.click(); await wait(30);
      setExternalConfig({ api: { apiKey: 'replacement-3eb1' }, verify2: true });
      await until(() => ui.querySelector('.keylabel').textContent.includes('3eb1') && ui.querySelector('.v2input').checked);
      ok(ui.querySelector('.keywarn').getBoundingClientRect().height === 0, '已启用 Key 后仍显示未配置提示');
      ok(HW.questions.length === questions.length && HW.questions.every((q, i) => q === questions[i]), '换 Key 清除了已有题目');
      setExternalConfig({ panelMode: 'watch' });
      await until(() => ui.querySelector('.watchview').getBoundingClientRect().height > 0);
      setExternalConfig({ engine: 'bridge', api: { apiKey: '' } });
      await until(() => ui.querySelector('.badge').textContent.includes('豆包'));
      ok(ui.querySelector('.watchview').getBoundingClientRect().height === 0, '豆包引擎仍显示仅 API 支持的刷课界面');
      ok(ui.querySelector('.moderow').getBoundingClientRect().height > 0);
      ok(ui.querySelector('.modeslot .ddname').textContent === '豆包');
      ok(ui.querySelector('.apisec').getBoundingClientRect().height === 0, '豆包引擎仍显示 API 配置');
      setExternalConfig({ engine: 'api', panelMode: 'homework', api: { apiKey: 'fixture-only' } });
      await until(() => ui.querySelector('.badge').textContent === 'API' && ui.querySelector('.moderow').getBoundingClientRect().height > 0);
      ok(ui.querySelector('.keylabel').textContent.includes('only') && ui.querySelector('.v2input').checked);
      ok(ui.querySelector('.btnrow').getBoundingClientRect().height > 0);
    } finally {
      setExternalConfig({ engine: 'api', panelMode: 'homework', api: { apiKey: 'fixture-only' } });
      await wait(50);
    }
  });
  await check('豆包模式可点击并排查看，失败有提示，不自动开始答题', async () => {
    await setPanelMode('bridge');
    const button=ui.querySelector('.bridgesplit');
    ok(!ui.querySelector('.bridgebar').classList.contains('hidden'));
    const before=testCalls.filter(type=>type==='HW_START').length;
    button.click();ok(button.disabled && button.getAttribute('aria-busy')==='true');
    await until(()=>!button.disabled);
    ok(testCalls.includes('HW_BRIDGE_SPLIT') && ui.querySelector('.bridgestatus').textContent.includes('已并排显示'));
    window.bridgeSplitResult={ok:false,error:'当前浏览器不支持一键分屏，请用 Edge 工具栏的分屏按钮选择豆包页面'};
    button.click();await until(()=>!button.disabled);
    ok(ui.querySelector('.bridgestatus').textContent.includes('工具栏'));
    ok(testCalls.filter(type=>type==='HW_START').length===before);
    delete window.bridgeSplitResult;
    await setPanelMode('homework');ok(ui.querySelector('.bridgebar').classList.contains('hidden'));
  });
  await check('课程名后显示预计用时，完成课程默认折叠；延迟进度和倍速变化保留勾选', async () => {
    const extra = document.createElement('div');
    extra.id = 'localCourseFixture';
    extra.innerHTML = [
      ['801', '待学习的长名称课程：传统文化与文学概论（第十期）', '任务点进度: 1/3'],
      ['802', '已经学完的课程', '任务点进度: 7/7'],
      ['803', '稍后加载进度的课程', ''],
    ].map(([id, name, progress]) => `<div class="course"><a href="https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=${id}&clazzid=901&cpi=101">${name}</a><p class="lateProgress">${progress}</p></div>`).join('');
    testStore['watchTime:801|901|101'] = { schema: 2, samples: [480,480,480] };
    document.body.append(extra);
    await until(() => ui.querySelectorAll('.crow[data-i]').length === 3);
    const row = i => ui.querySelector(`.crow[data-i="${i}"]`);
    await until(() => row(0).querySelector('.ctime').textContent.includes('8 分钟'));
    const completed = ui.querySelector('.ccompleted');
    ok(!completed.open && completed.contains(row(1)) && completed.contains(row(2)) && completed.querySelector('summary').textContent === '已完成（2 门）');
    ok(row(1).querySelector('.ctime').classList.contains('hidden') && !row(1).querySelector('input').disabled, '完成课程仍占勾选框（徽章渲染失败的课程要能手动勾上）；2026-10-25');
    ok(row(2).querySelector('.ctime').classList.contains('hidden'), '未知进度不应在列表显示虚假估算');
    const unknownKey = HW.Watch.courseTimeKey(HW.Watch.courseLinks()[2]);
    /* 卡片没给进度的课默认折叠进已完成区（青服团这类不开任务的课不再挂在未完成里）；
       本机刷课记录还留着未完成任务点时例外，仍留在未完成区等继续。 */
    await until(() => completed.contains(row(2)));
    testStore[unknownKey] = { remainingJobs: 2 };
    await setPanelMode('homework'); await setPanelMode('watch');
    await until(() => !completed.contains(row(2)));
    delete testStore[unknownKey];
    await setPanelMode('homework'); await setPanelMode('watch');
    await until(() => completed.contains(row(2)));
    ui.querySelector('.crow.all input').click();
    ok(row(0).querySelector('input').checked && !row(2).querySelector('input').checked && !row(1).querySelector('input').checked);
    completed.querySelector('summary').click();
    ok(completed.open, '完成课程不能展开');
    extra.querySelectorAll('.lateProgress')[2].textContent = '任务点进度: 1/2';
    await until(() => !completed.contains(row(2)));
    extra.querySelectorAll('.lateProgress')[2].textContent = '任务点进度: 5/5';
    await until(() => completed.contains(row(2)));
    ok(completed.open && row(0).querySelector('input').checked && !row(2).querySelector('input').checked);
    ok(ui.querySelector('.watchbtn').textContent === '开始刷 1 门');
    ui.querySelector('.rateslot .ddtrig').click();
    ui.querySelector('.ddlist:not(.hidden) [data-id="1"]').click();
    await until(() => row(0).querySelector('.ctime').textContent.includes('16 分钟'));
    const course = HW.Watch.courseLinks()[0], key = HW.Watch.courseTimeKey(course);
    await chrome.storage.local.set({ [key]: { schema: 2, samples: [120,120,120] } });
    testStorageListeners.forEach(fn => fn({ [key]: { newValue: testStore[key] } }, 'local'));
    await until(() => row(0).querySelector('.ctime').textContent.includes('4 分钟'));
    ok(row(0).querySelector('input').checked, '用时更新丢掉已选课程');
    completed.querySelector('summary').click();
    ok(!completed.open);
  });
  await check('设置里的限定节数只选进度低于 35% 的课程', async () => {
    await setPanelMode('watch');
    setWatchSections(4); // 页面上下文里直接改配置并触发 onChanged（面板已无勾选框）
    await until(() => ui.querySelector('.watchbtn').textContent.includes('前 4 节'));
    ok(ui.querySelector('.watchbtn').textContent.includes('前 4 节'), '启动按钮未说明模式');
    ok(ui.querySelector('.crow[data-i="0"] input').checked, '33% 的课程被错误排除');
    ok(ui.querySelector('.crow[data-i="2"] input').disabled, '限定节数模式下进度未知课程仍应禁选');
    setWatchSections(0);
    await until(() => !ui.querySelector('.watchbtn').textContent.includes('前 4 节'));
    await setPanelMode('homework');
  });
  await check('个人中心非固定地址的内嵌课程列表可读，保留勾选并更新进度', async () => {
    const first = HW.Watch.courseLinks()[0];
    testStore['watchTime:804|901|' + first.cpi] = { schema: 2, samples: [480,480,480] };
    window.frameCourseResults = [first, { ...first, key: '804|901', courseid: '804', name: '内嵌页面课程', done: 0, total: 2 }];
    document.getElementById('localCourseFixture').remove();
    const frame = document.createElement('iframe');
    frame.id = 'courseListFrame';
    frame.src = '/space/index';
    document.body.append(frame);
    await setPanelMode('watch');
    await until(() => ui.querySelectorAll('.crow[data-i]').length === 2);
    ok(testCalls.includes('HW_WATCH_COURSES'));
    ok(ui.querySelector('.crow[data-i="0"] input').checked, '内嵌刷新丢了勾选');
    ok(ui.querySelector('.crow[data-i="1"] .cname').textContent === '内嵌页面课程');
    ok(ui.querySelector('.crow[data-i="1"] .ctime').textContent.includes('16 分钟'));
    window.frameCourseResults[1] = { ...frameCourseResults[1], done: 2 };
    frame.dispatchEvent(new Event('load'));
    await until(() => ui.querySelector('.ccompleted').contains(ui.querySelector('.crow[data-i="1"]')));
    await setPanelMode('homework');
  });
  await check('刷新课程等待正在读取的结果，不重复请求且保留勾选', async () => {
    await setPanelMode('watch');
    const button = ui.querySelector('.courserefresh');
    ok(button && !button.disabled && button.textContent === '刷新课程', '没有可用的刷新课程按钮');
    window.holdCourseRead = true;
    document.getElementById('courseListFrame').dispatchEvent(new Event('load'));
    await until(() => !!window.releaseCourseRead);
    const calls = testCalls.filter(type => type === 'HW_WATCH_COURSES').length;
    button.click();
    ok(button.disabled && button.getAttribute('aria-busy') === 'true', '读取期间未禁用刷新按钮');
    button.click();
    ok(testCalls.filter(type => type === 'HW_WATCH_COURSES').length === calls, '重复发起课程读取');
    window.frameCourseResults.push({ ...frameCourseResults[0], key: '805|901', courseid: '805', name: '新加载的课程', done: 0, total: 3 });
    window.releaseCourseRead();
    await until(() => !button.disabled);
    ok(ui.querySelectorAll('.crow[data-i]').length === 3);
    ok(ui.querySelector('.crow[data-i="0"] input').checked, '刷新丢掉已有勾选');
    ok(ui.querySelector('.watchline').textContent === '已读取 3 门课程');
  });
  await check('自动读取尚未结束且返回空清单时，手动刷新仍补发强制读取', async () => {
    const button=ui.querySelector('.courserefresh'),saved=window.frameCourseResults;
    window.frameCourseResults=[];window.holdCourseRead=true;
    document.getElementById('courseListFrame').dispatchEvent(new Event('load'));
    await until(()=>window.holdCourseRead && !!window.releaseCourseRead);
    const before=testCalls.filter(type=>type==='HW_WATCH_COURSES').length;
    button.click();window.releaseCourseRead();window.frameCourseResults=saved;
    await until(()=>!button.disabled);
    ok(testCalls.filter(type=>type==='HW_WATCH_COURSES').length===before+1,'手动刷新丢失在已有空请求中');
    ok(window.lastCourseRefresh && ui.querySelectorAll('.crow[data-i]').length===3);
  });
  await check('刷新课程有失败提示，空结果仍可重试，再次读取能恢复', async () => {
    const button = ui.querySelector('.courserefresh');
    window.testCourseError = true;
    button.click(); await until(() => !button.disabled);
    ok(ui.querySelector('.watchline').textContent.includes('读取失败'), '失败被错误显示为成功');
    window.testCourseError = false;
    const courses = window.frameCourseResults;
    window.frameCourseResults = [];
    button.click(); await until(() => !button.disabled);
    ok(!ui.querySelector('.watchempty').classList.contains('hidden'));
    ok(!button.disabled && ui.querySelector('.watchline').textContent.includes('暂未读到课程'));
    window.frameCourseResults = courses;
    button.focus(); button.click(); await until(() => !button.disabled);
    ok(ui.querySelectorAll('.crow[data-i]').length === 3 && ui.activeElement === button, '刷新后键盘焦点丢失');
    await setPanelMode('homework');
  });
  await check('刷新通信同步失败后按钮解锁，再次点击仍能恢复，不陷入空结果循环', async () => {
    await setPanelMode('watch');
    const button=ui.querySelector('.courserefresh'),saved=window.frameCourseResults,original=chrome.runtime.sendMessage;
    window.frameCourseResults=[];button.click();await until(()=>!button.disabled);
    chrome.runtime.sendMessage=msg=>{if(msg.type==='HW_WATCH_COURSES')throw Error('模拟扩展上下文失效');return original(msg);};
    try{
      button.click();await until(()=>!button.disabled);button.click();await until(()=>!button.disabled);
      ok(ui.querySelector('.watchline').textContent.includes('读取失败'));
    }finally{chrome.runtime.sendMessage=original;window.frameCourseResults=saved;}
    button.click();await until(()=>!button.disabled);ok(ui.querySelectorAll('.crow[data-i]').length===3);
    await setPanelMode('homework');
  });
  await check('点击刷新先申请超星授权，拒绝不扫描也不丢勾选，授权后继续同次刷新', async () => {
    await setPanelMode('watch');const button=ui.querySelector('.courserefresh');
    window.courseAccessResult={ok:false,needsPermission:true,error:'未获得超星站点访问权限'};
    const scans=testCalls.filter(type=>type==='HW_WATCH_COURSES').length;
    const selected=ui.querySelector('.crow[data-i="0"] input').checked;
    button.click();await until(()=>!button.disabled);
    ok(testCalls.filter(type=>type==='HW_WATCH_COURSES').length===scans);
    ok(ui.querySelector('.watchline').textContent.includes('权限')&&ui.querySelector('.crow[data-i="0"] input').checked===selected);
    delete window.courseAccessResult;
    button.click();await until(()=>!button.disabled);
    ok(testCalls.filter(type=>type==='HW_WATCH_COURSES').length>scans);
    await setPanelMode('homework');
  });
  await check('授权期间旧读取返回缺权限时，继续重新读取，不把旧提示当作授权结果', async () => {
    await setPanelMode('watch');const button=ui.querySelector('.courserefresh'),original=chrome.runtime.sendMessage;
    const beforeIssues=testCalls.filter(type=>type==='HW_ISSUE_ADD').length;let release;
    chrome.runtime.sendMessage=msg=>msg.type==='HW_WATCH_COURSES'?new Promise(resolve=>{release=resolve;}):original(msg);
    document.getElementById('courseListFrame').dispatchEvent(new Event('load'));await until(()=>!!release);
    button.click();await wait(0);chrome.runtime.sendMessage=original;
    release({ok:false,needsPermission:true,error:'旧请求仍缺少超星站点权限'});await until(()=>!button.disabled);
    ok(ui.querySelector('.watchline').textContent==='已读取 3 门课程','刚获得授权却保留了旧权限错误');
    ok(testCalls.filter(type=>type==='HW_ISSUE_ADD').length===beforeIssues,'正常权限状态被当作异常重复记录');
    await setPanelMode('homework');
  });
  await check('开始刷课后标题下持续显示剩余时间，与任务状态行分别展示', async () => {
    const original = HW.Watch;
    let seconds = 720;
    HW.Watch = { ...original, running: true, nodes: () => [{ id: 'remaining', name: '当前章节' }], unfinishedOf: () => 3, remainingSeconds: () => seconds };
    try {
      await setPanelMode('watch');
      ok(ui.querySelector('.watchmeta').textContent.includes('剩余约 12 分钟'));
      seconds = 360;
      await setPanelMode('homework'); await setPanelMode('watch');
      ok(ui.querySelector('.watchmeta').textContent.includes('剩余约 6 分钟'));
      ok(ui.querySelector('.watchline') !== ui.querySelector('.watchmeta'));
    } finally { HW.Watch = original; await setPanelMode('homework'); }
  });
  await check('本门课程进度跟随真实任务或章节，未知及异常数量不伪报完成', async () => {
    const original = HW.Watch, head = document.createElement('div');
    head.className = 'chapter_head'; document.body.append(head);
    let state;
    HW.Watch = { ...original, running: false, currentCourse: () => state.current === false ? null : {key:'progress|901'},
      nodes: () => Object.keys(state.left || {}).map(id => ({id, name:'测试章节'})), unfinishedOf: id => state.left[id] };
    try {
      for (const next of [
        {native:'17/24', expected:'70% · 17/24 任务点', percent:'70'},
        {native:'24/24', expected:'100% · 24/24 任务点', percent:'100'},
        {native:'0/24', expected:'0% · 0/24 任务点', percent:'0'},
        {native:'25/24', expected:'暂未读取到进度', percent:null},
        {left:{a:0,b:2,c:0}, expected:'66% · 2/3 节', percent:'66'},
        {left:{a:0,b:null}, expected:'至少 50% · 1/2 节', percent:'50'},
        {native:'0/10', left:{a:0,b:3}, expected:'70% · 7/10 任务点', percent:'70'},
        {native:'199/200', expected:'99% · 199/200 任务点', percent:'99'},
        {expected:'暂未读取到进度', percent:null},
        {current:false, expected:'暂未读取到进度', percent:null, hidden:true},
      ]) {
        state = next; head.textContent = next.native ? '已完成任务点：' + next.native : '';
        await setPanelMode('homework'); await setPanelMode('watch');
        const progress = ui.querySelector('.watchprogress'), track = ui.querySelector('.wptrack');
        ok(ui.querySelector('.wpvalue').textContent === next.expected, ui.querySelector('.wpvalue').textContent);
        ok(track.getAttribute('aria-valuenow') === next.percent, '读屏数值与真实进度不一致');
        ok(progress.classList.contains('hidden') === !!next.hidden, '没有本门课程时应隐藏进度条');
        ok(ui.querySelector('.wpfill').style.width === (next.percent || '0') + '%');
      }
      const gradient = getComputedStyle(ui.querySelector('.wpfill')).backgroundImage;
      ok(gradient.includes('linear-gradient') && (gradient.match(/rgb\(/g) || []).length === 3, '进度条没有深蓝到浅蓝的渐变');
      ok([...gradient.matchAll(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/g)].every(rgb=>Number(rgb[3])>Number(rgb[2])), '进度条右端仍然偏绿');
    } finally { HW.Watch = original; head.remove(); await setPanelMode('homework'); }
  });
  await check('单课进度使用本门队列总数和实时剩余数，换课不串用其他课程进度', async () => {
    const original = HW.Watch, originalSend = chrome.runtime.sendMessage;
    let queued = {key:'progress|901',name:'进度测试课',done:0,total:10};
    chrome.runtime.sendMessage = message => message.type === 'HW_WATCH_QUEUE_GET'
      ? Promise.resolve({ok:true,queue:{index:0,courses:[queued]}}) : originalSend(message);
    HW.Watch = {...original,running:false,currentCourse:()=>({key:'progress|901'}),nodes:()=>[{id:'a'},{id:'b'}],unfinishedOf:id=>id==='a'?0:3};
    try {
      await setPanelMode('watch'); document.dispatchEvent(new Event('visibilitychange'));
      await until(()=>ui.querySelector('.wpvalue').textContent==='70% · 7/10 任务点');
      queued = {key:'another|902',name:'另一门课程',done:90,total:100};
      document.dispatchEvent(new Event('visibilitychange'));
      await until(()=>ui.querySelector('.wpvalue').textContent==='50% · 1/2 节');
    } finally {
      HW.Watch=original;chrome.runtime.sendMessage=originalSend;
      document.dispatchEvent(new Event('visibilitychange'));await wait(30);await setPanelMode('homework');
    }
  });
  await check('刷课单题失败后保留后续题、失败回执和真实留空提示', async () => {
    const originalSend = chrome.runtime.sendMessage;
    window.testMode = 'mixed';
    let automatic = false;
    chrome.runtime.sendMessage = async message => {
      if (message.type !== 'HW_START') return originalSend(message);
      automatic = message.payload.auto === true;
      setTimeout(() => {
        HW.questions.forEach((q, index) => emitHWMessage({ type: 'HW_STATUS', payload: { index,
          status: index ? 'skipped' : 'failed', error: index ? '' : '复核不一致', answerPreview: index ? '' : '初答 AB，复核 A' } }));
        emitHWMessage({ type: 'HW_DONE', payload: { total: HW.questions.length, filled: 0, skipped: HW.questions.length - 1, failed: 1 } });
      }, 20);
      return { ok: true };
    };
    try {
      await HW.Panel.runHomework();
      ok(automatic, '刷课未将自动模式标记传给后台');
      ok(ui.querySelector('.smsg').textContent.includes('1 题留空'), ui.querySelector('.smsg').textContent);
      ok(!testMessages.some(m => m.type === 'HW_ISSUE_ADD' && m.payload.stage === '填写未完成'),
        '临时填写失败不应单独上报：等刷课收尾的未完成记录统一携带原因（v0.9.35）');
      window.failureUIReady = true;
      await new Promise(resolve => { window.resumeFailureUI = resolve; });
    } finally { chrome.runtime.sendMessage = originalSend; }
  });
  await check('同页两份测验贯通真实读题、填写回读、完成回执和独立交卷', async () => {
    const root=document.createElement('iframe'), previous=document.getElementById('iframe'), originalSend=chrome.runtime.sendMessage, originalKey=testApiKey;
    if(previous)previous.id='previous-quiz-frame';root.id='iframe';root.srcdoc='<iframe src="/ananas/modules/work/index.html" srcdoc="加载中" data=\'{"jobid":"flow-one"}\'></iframe><iframe src="/ananas/modules/work/index.html" srcdoc="加载中" data=\'{"jobid":"flow-two"}\'></iframe>';
    document.body.append(root);await new Promise(resolve=>root.onload=resolve);
    const frames=[...root.contentDocument.querySelectorAll('iframe')], submissions=[], acknowledgements=[];
    for(const [index,frame] of frames.entries()){
      await new Promise(resolve=>{frame.onload=resolve;frame.srcdoc=`<section class="questionLi" id="question${index+1}" typename="单选题"><h3 class="mark_name">独立测验${index+1}</h3><input type="hidden" name="answer${index+1}"><div class="answerBg" aria-checked="false"><span class="num_option">A.</span><span class="answer_p">甲</span></div><div class="answerBg" aria-checked="false"><span class="num_option">B.</span><span class="answer_p">乙</span></div></section><button id="submit">提交</button><button id="popok" hidden>确定</button>`;});
      const doc=frame.contentDocument;
      for(const [option,row] of [...doc.querySelectorAll('.answerBg')].entries())row.onclick=()=>{
        doc.querySelectorAll('.answerBg').forEach(el=>el.setAttribute('aria-checked',String(el===row)));doc.querySelector('input').value='AB'[option];
      };
      doc.getElementById('submit').onclick=()=>{doc.getElementById('popok').hidden=false;};
      doc.getElementById('popok').onclick=()=>{submissions.push([index,doc.querySelector('input').value]);doc.body.innerHTML='<div class="TiMu">已交卷</div><p class="Finalresult">本次成绩 100 分 满分：100</p>';};
    }
    let starts=0;window.testApiKey='fixture-only';
    chrome.runtime.sendMessage=async message=>{
      if(message.type==='HW_START'){
        starts++;ok(message.payload.questions.length===1,'把两份卷子合成了一份填写队列');
        setTimeout(()=>emitHWMessage({type:'HW_ANSWER',payload:{index:0,answer:'A',fillToken:'flow-'+starts}}),20);return{ok:true};
      }
      if(message.type==='HW_FILLED'){
        acknowledgements.push(message.payload);ok(message.payload.ok,'真实填写回读失败');
        setTimeout(()=>emitHWMessage({type:'HW_DONE',payload:{total:1,filled:1,failed:0,skipped:0}}),20);return{ok:true};
      }
      return originalSend(message);
    };
    HW.Watch._completionTest.setOn(true);
    try {
      await Promise.race([HW.Watch._completionTest.runQuizzes(),wait(20000).then(()=>{throw Error('完整流程未结束：'+JSON.stringify({starts,acknowledgements,submissions,states:HW.questions?.map(q=>q._status),summary:ui.querySelector('.smsg').textContent}));})]);
      ok(starts===2&&acknowledgements.length===2,'第二份未经过真实答题／填写回执');
      ok(JSON.stringify(submissions)===JSON.stringify([[0,'A'],[1,'A']]),'交卷时有漏填或串卷：'+JSON.stringify(submissions));
    } finally {HW.Watch._completionTest.setOn(false);emitHWMessage({type:'HW_STOPPED'});chrome.runtime.sendMessage=originalSend;window.testApiKey=originalKey;root.remove();if(previous)previous.id='iframe';}
  });
  await check('异常记录保存失败显示持续提醒并停止答题和刷课', async () => {
    const original = HW.Watch;
    let stopped = false;
    window.testIssueFailure = true;
    HW.Watch = { ...original, stop: () => { stopped = true; }, nodes: () => [], activeChapterId: () => null };
    try {
      const before = testCalls.length;
      HW.Panel.reportIssue('测试失败', '磁盘写入检查');
      await wait(50);
      const notice = ui.querySelector('.issuewarn');
      ok(!notice.classList.contains('hidden') && notice.textContent.includes('写入失败'));
      ok(notice.getAttribute('role') === 'alert' && stopped);
      ok(testCalls.slice(before).includes('HW_STOP') && testCalls.slice(before).includes('HW_WATCH_STOP'));
      const count = testCalls.filter(v => v === 'HW_START').length;
      ui.querySelector('.start').click(); await wait(30);
      ok(testCalls.filter(v => v === 'HW_START').length === count, '记录失败后仍能继续自动答题');
    } finally { window.testIssueFailure = false; HW.Watch = original; ui.querySelector('.issuewarn').classList.add('hidden'); }
  });
  window.testResults = out;
  return out;
}

const fixture = `<!doctype html><meta charset="utf-8"><title>AI 识题模拟作业</title>
<style>body{font:14px system-ui;margin:32px;color:#253047;background:#f5f7fa}main{max-width:700px}section{margin:12px 0;padding:10px;background:white}label{display:block}iframe{width:95%;height:100px}[contenteditable]{min-height:45px;border:1px solid #ddd}textarea{width:90%;height:45px}</style>
<nav>SECRET_NAV<input value="SECRET_TOKEN"></nav><main>
<input id="searchChapterListByName" aria-label="CHAPTER_SEARCH"><div class="newTopic1">DISCUSSION_FORM<input><textarea></textarea></div>
<section id="choice"><h3 aria-hidden="true">1. 选一个正确选项</h3><label><input type="radio" id="ra" name="c">A.甲</label><label><input type="radio" id="rb" name="c">B.乙</label></section>
<section id="multi"><h3>2. 选择全部正确选项</h3><div role="checkbox" aria-checked="false" id="ma">A.甲</div><div role="checkbox" aria-checked="false" id="mb">B.乙</div><div role="checkbox" aria-checked="false" id="mc">C.丙</div></section>
<section class="questionLi" typename="陌生判断名称" id="judge"><h3>3. 判断命题是否成立</h3><input type="hidden" name="answer30"><div class="answerBg" id="jt" aria-checked="false"><span class="num_option" data="true">A</span></div><div class="answerBg" id="jf" aria-checked="false"><span class="num_option" data="false">B</span></div></section>
<section class="questionLi" typename="陌生填空名称" id="question41"><h3>4. 两处____，____仅需填写一个数值</h3><input type="hidden" name="tiankongsize41" value="1"><input type="hidden" name="answertype41" value="2"><textarea hidden>SECRET_EXISTING_ANSWER</textarea><iframe id="blankEditor" srcdoc="<body contenteditable='true'></body>"></iframe></section>
<section id="subjective"><h3>5. 解释概念并分段</h3><div id="editable" contenteditable="true">SECRET_EXISTING_ANSWER</div></section>
<section id="duplicateA"><h3>相同题干</h3><textarea id="ta">SECRET_EXISTING_ANSWER</textarea></section><section id="duplicateB"><h3>相同题干</h3><textarea id="tb"></textarea></section>
<iframe id="nested" srcdoc="<section id='frameQuestion'><h3>嵌入页面的问答题</h3><textarea id='frameText'></textarea></section>"></iframe>
<section id="sort"><h3>拖动完成排序</h3><button>甲</button><button>乙</button></section><input type="password" value="SECRET_PASSWORD"><input name="apiKey" value="SECRET_TOKEN">
</main><script>(${fixtureBoot.toString()})();</script>`;
const sources = ['adapters/chaoxing.js', 'dropdown.js', 'diagnostics.js', 'extractor.js', 'ai-extractor.js', 'filler.js', '../course/watch.js', 'panel.js']
  .map((p) => {
    const code=fs.readFileSync(path.join(root, 'content/homework', p), 'utf8');
    return p==='../course/watch.js'?code.replace('  HW.Watch = {','  HW.Watch = { _completionTest: { runQuizzes, setOn(value) { on=value; } },'):code;
  }).join('\n;\n');
const html = fixture + `<script>${sources}</script><script>window.runDetectionChecks=${browserChecks.toString()};</script>`;
const inbox = `<!doctype html><meta charset="utf-8"><title>学习通知</title><style>body{font:14px system-ui;margin:32px}main{max-width:650px}li{padding:18px}label{display:block}</style><nav>消息导航</nav><main><h2>学习通知</h2><ul><li><label><input type="checkbox">我发出的</label></li><li><label><input type="checkbox">未完成</label></li><li><label><input type="checkbox">已完成作业</label></li></ul><input type="text" placeholder="搜索通知"><select><option>全部课程</option><option>未读通知</option></select><textarea placeholder="快捷回复"></textarea><p>课程名称：计算机组成原理；作业通知，请点击进入查看。</p></main><script>(${fixtureBoot.toString()})();</script><script>${sources};HW.Panel.init();</script>`;
const questionnaire = `<!doctype html><meta charset="utf-8"><style>.optionRadio,.optionCheckbox{padding:8px}.optionRadio input,.optionCheckbox input{display:none}textarea{width:160px;height:45px}</style>
<div class="tip">进行中</div><form id="answer_form"><div class="question-lists">${['您的性别？', '您是通过什么途径了解马克思主义的？', '你对马克思主义的印象'].map((stem, i) =>
  `<div class="question-item"><input type="hidden" name="questionId"><div class="question-list"><span class="topic-txt">${stem}</span>${i === 2 ? '<textarea></textarea>' :
    ['男', '女'].map((word, j) => `<div class="${i ? 'optionCheckbox' : 'optionRadio'}" role="${i ? 'checkbox' : 'radio'}" aria-checked="false"><span class="ipt-radio"><input type="${i ? 'checkbox' : 'radio'}" name="answer${i}" value="${j}"></span><span class="optionName">${'AB'[j]}.</span><div class="optionContent">${word}</div></div>`).join('')}</div></div>`).join('')}</div></form>
<script>document.addEventListener('click', e => {if(!e.target.matches('input'))return;setTimeout(()=>document.querySelectorAll('.optionRadio,.optionCheckbox').forEach(el=>el.setAttribute('aria-checked',String(el.querySelector('input').checked))),100);});</script>`;
const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(req.url.startsWith('/page/questionnaire/') ? questionnaire : ['/visit/interaction', '/space/index'].includes(req.url) ? '<!doctype html><title>内嵌课程列表样例</title>' : req.url === '/no-questions' ? inbox : html); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-crash-reporter', '--disable-breakpad', '--remote-debugging-port=0', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
let socket;
try {
  let port;
  for (let i = 0; i < 150; i++) {
    const file = path.join(profile, 'DevToolsActivePort');
    if (fs.existsSync(file)) { port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]); break; }
    /* Edge 155 起启动器进程会先正常退出、浏览器由另一个进程承载，不再据此判失败（超时后由 assert.ok(port, 'Headless Edge unavailable') 兜底） */
    await pause(100);
  }
  assert.ok(port, 'Headless Edge unavailable');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://127.0.0.1:${server.address().port}/`)}`, { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, reject) => { socket.onopen = r; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('CDP timeout: ' + method)); }, 90000);
    pending.set(key, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: key, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  for (let i = 0; i < 100 && !(await evaluate('document.readyState === "complete" && !!window.runDetectionChecks')); i++) await pause(50);
  const checking = evaluate('runDetectionChecks()');
  try {
    for (let i = 0; i < 1500 && !(await evaluate('!!window.nativeUIReady || !!window.testResults')); i++) await pause(20);
    assert.ok(await evaluate('!!window.nativeUIReady'), '原生识题默认界面未出现');
    for (const width of [1280, 420]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
      await pause(250);
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(output, `ui-native-${width}.png`), Buffer.from(shot.data, 'base64'));
    }
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  } finally { await evaluate('window.resumeNativeUI?.()'); }
  try {
    for (let i = 0; i < 1500 && !(await evaluate('!!window.failureUIReady || !!window.testResults')); i++) await pause(20);
    if (await evaluate('!!window.failureUIReady')) {
      for (const width of [1280, 420]) {
        await call('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
        const shot = await call('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(output, `ui-watch-partial-${width}.png`), Buffer.from(shot.data, 'base64'));
      }
      await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    }
  } finally { await evaluate('window.resumeFailureUI?.()'); }
  const results = await checking;
  for (const r of results) console.log(r.ok ? 'PASS' : 'FAIL', r.name, r.error || '');
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  for (const mode of ['loading', 'mixed', 'error', 'empty']) {
    const state = await evaluate(`setDetectionUI(${JSON.stringify(mode)})`);
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, `ui-${mode}.png`), Buffer.from(shot.data, 'base64'));
    console.log('UI', mode, JSON.stringify(state));
  }
  const measurePanel = () => evaluate(`(() => {
    const s=document.querySelector('#hw-panel-host').shadowRoot,p=s.querySelector('.panel');
    const rect=selector=>s.querySelector(selector).getBoundingClientRect().toJSON();
    return {panel:rect('.panel'),list:rect('.list'),log:rect('.logwrap'),buttons:rect('.btnrow'),
      viewport:{width:innerWidth,height:innerHeight},overflow:p.scrollWidth>p.clientWidth+1||p.scrollHeight>p.clientHeight+1};
  })()`);
  const assertSlenderPanel = g => {
    assert.ok(g.panel.height / g.panel.width >= 2, '桌面面板未保持修长比例');
    assert.ok(g.log.height <= g.panel.height / 2, '日志留白超过面板一半');
    assert.ok(g.panel.left>=0 && g.panel.right<=g.viewport.width && g.panel.top>=0 && g.panel.bottom<=g.viewport.height && !g.overflow, '面板超出视口或内容溢出');
    assert.ok(g.list.height>=120 && g.log.height>=96 && g.buttons.height>0, '列表、日志或操作区被挤压');
    assert.ok(g.buttons.bottom<=g.list.top && g.list.bottom<=g.log.top && g.log.bottom<=g.panel.bottom, '操作、列表和日志区域重叠');
  };
  await pause(250);
  const apiGeometry = await measurePanel();
  assertSlenderPanel(apiGeometry);
  results.push({ name: '桌面面板保持修长比例，操作、题目和日志区域完整且无溢出', ok: true });
  const apiShot = await call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, 'ui-homework-api-1280.png'), Buffer.from(apiShot.data, 'base64'));
  try {
    await evaluate('setExternalConfig({engine:"bridge",panelMode:"homework",api:{apiKey:""}})');
    await pause(250);
    const bridge = await measurePanel();
    assertSlenderPanel(bridge);
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, 'ui-homework-bridge-1280.png'), Buffer.from(shot.data, 'base64'));
    results.push({ name: '豆包面板保持修长，日志留白不过半且无溢出', ok: true });
  } finally {
    await evaluate('setExternalConfig({engine:"api",panelMode:"homework",api:{apiKey:"fixture-only"}})');
    await pause(250);
  }
  const panelStyle = await evaluate('document.querySelector("#hw-panel-host").shadowRoot.querySelector(".panel").getAttribute("style")');
  const listStyle = await evaluate('document.querySelector("#hw-panel-host").shadowRoot.querySelector(".list").getAttribute("style")');
  for (const baseline of ['squat', 'blank']) {
    try {
      if (baseline === 'squat') {
        await evaluate('(()=>{const p=document.querySelector("#hw-panel-host").shadowRoot.querySelector(".panel");p.style.height="auto";p.style.minHeight="380px";})()');
      } else {
        await evaluate('(()=>{setExternalConfig({engine:"bridge",panelMode:"homework"});const s=document.querySelector("#hw-panel-host").shadowRoot,p=s.querySelector(".panel");s.querySelector(".bridgebar").classList.add("hidden");p.style.width="360px";p.style.height="792px";s.querySelector(".list").style.height="170px";})()');
      }
      await pause(250);
      const geometry = await measurePanel();
      assert.throws(() => assertSlenderPanel(geometry), baseline === 'squat' ? /未保持修长比例/ : /日志留白超过/, '诊断未拒绝矮胖或空白过多的旧布局');
    } finally {
      await evaluate(`(()=>{setExternalConfig({engine:'api',panelMode:'homework',api:{apiKey:'fixture-only'}});const s=document.querySelector('#hw-panel-host').shadowRoot,p=s.querySelector('.panel'),list=s.querySelector('.list');${panelStyle === null ? "p.removeAttribute('style')" : `p.setAttribute('style',${JSON.stringify(panelStyle)})`};${listStyle === null ? "list.removeAttribute('style')" : `list.setAttribute('style',${JSON.stringify(listStyle)})`};})()`);
      await pause(250);
    }
  }
  results.push({ name: '几何诊断能拒绝 auto 高度的矮胖布局及日志留白过半的空撑布局', ok: true });
  assertSlenderPanel(await measurePanel());
  await call('Emulation.setDeviceMetricsOverride', { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });
  await evaluate('setDetectionUI("mixed")');
  await pause(250); // 等待面板既有的高度过渡完成，避免测到中间态。
  const small = await call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, 'ui-compact.png'), Buffer.from(small.data, 'base64'));
  const geometry = await evaluate(`(() => { const s=document.querySelector('#hw-panel-host').shadowRoot; const p=s.querySelector('.panel'); const r=p.getBoundingClientRect(); const log=s.querySelector('.logwrap').getBoundingClientRect(); const watch=s.querySelector('.watchrow').getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,viewport:innerWidth,height:innerHeight,overflow:p.scrollWidth>p.clientWidth,logHeight:log.height,watchVisible:watch.height>0}; })()`);
  console.log('UI compact geometry', geometry);
  assert.ok(geometry.right > geometry.left && !geometry.overflow && geometry.left >= 0 && geometry.right <= geometry.viewport);
  assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.height);
  // 刷课那一行是加在固定高度的面板里的，必须确认它没把日志区压没
  assert.ok(!geometry.watchVisible && geometry.logHeight >= 96, 'writing view contains watch controls or squeezed logs');
  try {
    await evaluate('setExternalConfig({engine:"bridge",panelMode:"homework",api:{apiKey:""}})');
    await pause(250);
    const bridge = await measurePanel();
    assert.ok(bridge.panel.left>=0 && bridge.panel.right<=bridge.viewport.width && bridge.panel.top>=0 && bridge.panel.bottom<=bridge.viewport.height && !bridge.overflow);
    assert.ok(bridge.log.height>=96 && bridge.buttons.bottom<=bridge.list.top && bridge.list.bottom<=bridge.log.top && bridge.log.bottom<=bridge.panel.bottom);
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, 'ui-homework-bridge-420.png'), Buffer.from(shot.data, 'base64'));
    results.push({ name: '豆包修长面板在窄屏完整可见，操作和日志无重叠', ok: true });
  } finally {
    await evaluate('setExternalConfig({engine:"api",panelMode:"homework",api:{apiKey:"fixture-only"}})');
    await pause(250);
  }
  for (const width of [1280, 420]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await evaluate('setPanelMode("watch")');
    await evaluate('setWatchSections(4)');
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, `ui-watch-${width}.png`), Buffer.from(shot.data, 'base64'));
    const watch = await evaluate(`(() => {const s=document.querySelector('#hw-panel-host').shadowRoot,p=s.querySelector('.panel'),r=p.getBoundingClientRect(),button=s.querySelector('.watchbtn').getBoundingClientRect(),log=s.querySelector('.logwrap').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:innerHeight,width:innerWidth,overflow:p.scrollHeight>p.clientHeight,log:log.height,buttonBottom:button.bottom,logTop:log.top};})()`);
    console.log('UI watch geometry', width, watch);
    assert.ok(watch.left>=0 && watch.right<=watch.width && watch.top>=0 && watch.bottom<=watch.height && !watch.overflow && watch.log>=96);
    assert.ok(watch.buttonBottom <= watch.logTop, 'watch button overlaps the log area');
    await evaluate('setWatchSections(0)');
    await evaluate('setPanelMode("homework")');
  }
  await evaluate(`window.progressOriginalWatch=HW.Watch;window.progressRemaining=7;HW.Watch={...HW.Watch,running:true,currentCourse:()=>({key:'progress|901'}),courseLinks:()=>[],nodes:()=>[{id:'p1',name:'课程导学'},{id:'p2',name:'2.4 阅读与章节测验'},{id:'p3',name:'课程练习'}],activeChapterId:()=> 'p2',unfinishedOf:id=>progressRemaining===null?null:id==='p2'?progressRemaining:0,remainingSeconds:()=>progressRemaining>0?600:null};window.frameCourseResults=[];document.getElementById('localCourseFixture')?.remove();window.progressHead=document.createElement('div');progressHead.className='chapter_head';document.body.append(progressHead);document.querySelector('#hw-panel-host').shadowRoot.querySelector('.log').textContent='';setPanelMode('watch');`);
  await evaluate(`document.querySelector('#hw-panel-host').shadowRoot.querySelector('.courserefresh').click()`);
  await pause(300);
  for (const width of [1280, 420]) {
    await call('Emulation.setDeviceMetricsOverride', {width, height:800, deviceScaleFactor:1, mobile:false});
    for (const [state, text] of [['partial','17/24'],['complete','24/24'],['empty','0/24'],['unknown','']]) {
      await evaluate(`progressHead.textContent=${JSON.stringify(text ? '已完成任务点：' + text : '')};progressRemaining=${text ? 24-Number(text.split('/')[0]) : 'null'};setPanelMode('homework').then(()=>setPanelMode('watch'));`);
      await pause(260);
      const geometry = await evaluate(`(()=>{const s=document.querySelector('#hw-panel-host').shadowRoot,p=s.querySelector('.panel'),r=p.getBoundingClientRect(),track=s.querySelector('.wptrack').getBoundingClientRect(),button=s.querySelector('.watchbtn').getBoundingClientRect(),log=s.querySelector('.logwrap').getBoundingClientRect();return {inside:track.left>=r.left&&track.right<=r.right&&track.top>=r.top&&track.bottom<=button.top,overflow:p.scrollHeight>p.clientHeight,buttonBottom:button.bottom,logTop:log.top,logHeight:log.height};})()`);
      assert.ok(geometry.inside && !geometry.overflow && geometry.buttonBottom <= geometry.logTop && geometry.logHeight >= 96, '课程进度条挤压操作或日志区：' + JSON.stringify(geometry));
      const shot = await call('Page.captureScreenshot', {format:'png'});
      fs.writeFileSync(path.join(output, `ui-course-progress-${state}-${width}.png`), Buffer.from(shot.data,'base64'));
    }
  }
  results.push({name:'单课进度条在宽窄窗口及未开始、进行中、完成、未知状态布局完整',ok:true});
  await evaluate('HW.Watch=progressOriginalWatch;progressHead.remove();setPanelMode("homework")');
  const aiEmpty = await evaluate('setDetectionUI("empty")');
  assert.equal(aiEmpty.summary, '未检测出题目');
  assert.equal(aiEmpty.ready, 0); assert.equal(aiEmpty.pending, 0); assert.equal(aiEmpty.startDisabled, true);
  results.push({ name: 'AI返回空列表显示未检测出题目，不从普通控件补造待确认项', ok: true });
  await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/no-questions` });
  for (let i = 0; i < 100 && !(await evaluate('document.title === "学习通知" && !!document.querySelector("#hw-panel-host")?.shadowRoot')); i++) await pause(50);
  const inboxState = await evaluate(`(() => {
    const ui=document.querySelector('#hw-panel-host').shadowRoot;
    ui.querySelector('.panel').classList.remove('hidden');
    return {ready:HW.questions.length,pending:ui.querySelectorAll('.pending').length,summary:ui.querySelector('.smsg').textContent,issue:testCalls.includes('HW_ISSUE_ADD')};
  })()`);
  assert.deepEqual(inboxState, { ready: 0, pending: 0, summary: '未检测出题目', issue: false });
  results.push({ name: '通知页勾选框、搜索、筛选和回复不当作题目或待确认', ok: true });
  for (const width of [1280,420]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height:800, deviceScaleFactor:1, mobile:false });
    const shot=await call('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(output, `ui-no-questions-${width}.png`),Buffer.from(shot.data,'base64'));
  }
  await call('Emulation.setDeviceMetricsOverride', { width:1280, height:900, deviceScaleFactor:1, mobile:false });
  for (const preview of [{ id:'api-no-key', engine:'api', key:'' }, { id:'api', engine:'api', key:'fixture-3eb1' }, { id:'bridge', engine:'bridge', key:'' }]) {
    await evaluate(`(()=>{localStorage.setItem('hwApiOpen','1');setExternalConfig({engine:${JSON.stringify(preview.engine)},panelMode:'homework',verify2:true,api:{apiKey:${JSON.stringify(preview.key)}}});const s=document.querySelector('#hw-panel-host').shadowRoot;s.querySelector('.keyinput').value='';s.querySelector('.keyinput').dispatchEvent(new Event('input'));s.querySelector('.log').textContent='';})()`);
    await pause(250);
    const geometry=await measurePanel();
    assertSlenderPanel(geometry);
    const p=geometry.panel;
    const shot=await call('Page.captureScreenshot',{format:'png',clip:{x:p.x,y:p.y,width:p.width,height:p.height,scale:2}});
    fs.writeFileSync(path.join(output, `panel-${preview.id}-clean.png`),Buffer.from(shot.data,'base64'));
  }
  await evaluate('setExternalConfig({engine:"api",panelMode:"homework",api:{apiKey:"fixture-only"}})');
  for (const asyncFailure of [false,true]) {
    const state=await evaluate(`(async()=>{
      const errors=[];window.addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
      chrome.runtime.sendMessage=()=>${asyncFailure ? 'Promise.reject(new Error("Extension context invalidated."))' : '{throw new Error("Extension context invalidated.");}'};
      const ui=document.querySelector('#hw-panel-host').shadowRoot;ui.querySelector('.detect').click();
      for(let i=0;i<100&&ui.querySelector('.detect').disabled;i++)await new Promise(r=>setTimeout(r,20));
      await new Promise(r=>setTimeout(r,30));
      return {summary:ui.querySelector('.smsg').textContent,errors,issueWarning:!ui.querySelector('.issuewarn').classList.contains('hidden'),disabled:ui.querySelector('.detect').disabled};
    })()`);
    assert.match(state.summary,/未检测出题目.*刷新页面（F5）/);
    assert.ok(!state.summary.includes('Extension context invalidated'));
    assert.equal(state.issueWarning,false);assert.equal(state.disabled,false);assert.deepEqual(state.errors,[]);
  }
  results.push({ name: '同步与异步扩展上下文失效都显示中文刷新提示，不误报磁盘或留下未处理异常', ok: true });
  const contextShot=await call('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(output,'ui-context-invalid.png'),Buffer.from(contextShot.data,'base64'));
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log('Additional UI checks:', JSON.stringify(inboxState));
  assert.ok(results.every((r) => r.ok), 'Browser checks failed; see .tmp-ai-tests/results.json');
  console.log(`\n${results.length} browser groups passed. Screenshots: ${output}`);
} finally {
  socket?.close();
  /* Edge 155：child 是已退出的启动器进程，要用 CDP 关掉真正持有 profile 的浏览器，否则进程残留、profile 删不掉 */
  try {
    const pf = path.join(profile, 'DevToolsActivePort');
    if (fs.existsSync(pf)) {
      const p = Number(fs.readFileSync(pf, 'utf8').split('\n')[0]);
      const v = await (await fetch(`http://127.0.0.1:${p}/json/version`)).json();
      const bw = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((res) => { bw.onopen = () => { bw.send(JSON.stringify({ id: 1, method: 'Browser.close' })); setTimeout(res, 1200); }; bw.onerror = res; });
    }
  } catch { /* 浏览器已退出 */ }
  child.kill();
  server.closeAllConnections();
  server.close();
  await pause(300);
  const relative = path.relative(output, profile);
  if (!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('edge-')) {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
    catch { console.warn('Temporary browser profile is still locked:', profile); }
  }
}
