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
  window.testStore = {};
  window.testStorageListeners = [];
  const listeners = [];
  window.chrome = {
    storage: { local: { get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, testStore[key]])), set: async value => Object.assign(testStore, value) },
      onChanged: { addListener: fn => testStorageListeners.push(fn) } },
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: async (msg) => {
        testCalls.push(msg.type);
        testMessages.push(msg);
        if (msg.type === 'GET_CONFIG') return { ok: true, config: { engine: 'api', api: { apiKey: window.testApiKey }, verify2: true } };
        if (msg.type === 'KEY_LIST') return { ok: true, list: [] };
        if (msg.type === 'CHECK_UPDATE') return { ok: false };
        if (msg.type === 'HW_WATCH_COURSES') return { ok: true, courses: window.frameCourseResults };
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
  document.querySelectorAll('[role="checkbox"]').forEach((el) => el.addEventListener('click', () => el.setAttribute('aria-checked', String(el.getAttribute('aria-checked') !== 'true'))));
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
    ok(HW.Extractor.currentAnswer(bound.questions[4]).includes('第二段'));
    ok(HW.Filler.verify(bound.questions[4], '第一段') === true);
    await HW.Filler.fill(bound.questions[7], 'frame answer');
    ok(HW.Extractor.currentAnswer(bound.questions[7]) === 'frame answer');
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
    const h = document.querySelector('#choice h3');
    const original = h.textContent;
    h.textContent = '替换后的题目';
    ok(!HW.AIDetection.isCurrent(s));
    let failed = false;
    try { HW.AIDetection.bind(s, specs); } catch { failed = true; }
    ok(failed);
    h.textContent = original;
    const el = document.querySelector('#ra');
    const clone = el.cloneNode(true);
    el.replaceWith(clone);
    ok(!HW.AIDetection.isCurrent(s));
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
  ui.querySelector('.fab').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 1200, clientY: 800 }));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  ok(!ui.querySelector('.panel').classList.contains('hidden'), 'panel was not actually opened');
  ok(!testCalls.includes('HW_DETECT_QUESTIONS'), 'opening panel must not send page data');
  ok(!testCalls.includes('HW_ISSUE_ADD'), '正常打开面板不应产生异常记录');
  const until = async (fn) => {
    for (let i = 0; i < 100; i++) { if (fn()) return; await wait(20); }
    throw new Error('UI wait timed out');
  };
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
  await check('刷课遇到待确认题目暂停，AI 识题仍需用户手动点击', async () => {
    const before = testCalls.filter(t => t === 'HW_DETECT_QUESTIONS').length;
    let error;
    try { await HW.Panel.runHomework(); } catch (e) { error = e.message; }
    ok(/待确认/.test(error || ''), error);
    ok(testCalls.filter(t => t === 'HW_DETECT_QUESTIONS').length === before, '刷课擅自调用 AI 检测');
    ok(!testCalls.includes('HW_START'));
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
  await check('可处理与待确认分列，检测完成不会自动开始作答', async () => {
    const state = await setDetectionUI('mixed');
    ok(state.ready === 8 && state.pending === 1, JSON.stringify(state));
    ok(!testCalls.includes('HW_START'));
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
    ok(error.startDisabled && !error.detecting && /识别失败/.test(error.summary));
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
  await check('只记录丢分回执，满分测验不产生异常记录', async () => {
    const original = HW.Watch;
    let score = 100;
    HW.Watch = { ...original, quizGrade: () => ({ score, total: 100 }), nodes: () => [], activeChapterId: () => null };
    const count = () => testMessages.filter(m => m.type === 'HW_ISSUE_ADD').length;
    const before = count();
    try {
      HW.Panel.reportGrade(); await wait(30);
      ok(count() === before, '满分被记成异常');
      score = 66.7;
      HW.Panel.reportGrade(); await wait(30);
      ok(count() === before + 1);
      ok(testMessages.filter(m => m.type === 'HW_ISSUE_ADD').at(-1).payload.score === 66.7);
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
  await check('课程名后显示预计用时，完成课程默认折叠；延迟进度和倍速变化保留勾选', async () => {
    const extra = document.createElement('div');
    extra.id = 'localCourseFixture';
    extra.innerHTML = [
      ['801', '待学习的长名称课程：传统文化与文学概论（第十期）', '任务点进度: 1/3'],
      ['802', '已经学完的课程', '任务点进度: 7/7'],
      ['803', '稍后加载进度的课程', ''],
    ].map(([id, name, progress]) => `<div class="course"><a href="https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=${id}&clazzid=901&cpi=101">${name}</a><p class="lateProgress">${progress}</p></div>`).join('');
    document.body.append(extra);
    await until(() => ui.querySelectorAll('.crow[data-i]').length === 3);
    const row = i => ui.querySelector(`.crow[data-i="${i}"]`);
    await until(() => row(0).querySelector('.ctime').textContent.includes('8 分钟'));
    const completed = ui.querySelector('.ccompleted');
    ok(!completed.open && completed.contains(row(1)) && completed.querySelector('summary').textContent === '已完成（1 门）');
    ok(row(1).querySelector('.ctime').classList.contains('hidden') && row(1).querySelector('input').disabled);
    ok(row(2).querySelector('.ctime').classList.contains('hidden'), '未知进度不应在列表显示虚假估算');
    const unknownKey = HW.Watch.courseTimeKey(HW.Watch.courseLinks()[2]);
    testStore[unknownKey] = { remainingJobs: 0 };
    await setPanelMode('homework'); await setPanelMode('watch');
    await until(() => completed.contains(row(2)));
    delete testStore[unknownKey];
    await setPanelMode('homework'); await setPanelMode('watch');
    await until(() => !completed.contains(row(2)));
    ui.querySelector('.crow.all input').click();
    ok(row(0).querySelector('input').checked && row(2).querySelector('input').checked && !row(1).querySelector('input').checked);
    completed.querySelector('summary').click();
    ok(completed.open, '完成课程不能展开');
    extra.querySelectorAll('.lateProgress')[2].textContent = '任务点进度: 5/5';
    await until(() => completed.contains(row(2)));
    ok(completed.open && row(0).querySelector('input').checked && !row(2).querySelector('input').checked);
    ok(ui.querySelector('.watchbtn').textContent === '开始刷 1 门');
    ui.querySelector('.rateslot .ddtrig').click();
    ui.querySelector('.ddlist:not(.hidden) [data-id="1"]').click();
    await until(() => row(0).querySelector('.ctime').textContent.includes('16 分钟'));
    const course = HW.Watch.courseLinks()[0], key = HW.Watch.courseTimeKey(course);
    await chrome.storage.local.set({ [key]: { jobs: 2, seconds: 240 } });
    testStorageListeners.forEach(fn => fn({ [key]: { newValue: testStore[key] } }, 'local'));
    await until(() => row(0).querySelector('.ctime').textContent.includes('4 分钟'));
    ok(row(0).querySelector('input').checked, '用时更新丢掉已选课程');
    completed.querySelector('summary').click();
    ok(!completed.open);
  });
  await check('个人中心内嵌课程列表可读，切换列表后保留勾选，进度异步更新用时', async () => {
    const first = HW.Watch.courseLinks()[0];
    window.frameCourseResults = [first, { ...first, key: '804|901', courseid: '804', name: '内嵌页面课程', done: 0, total: 2 }];
    document.getElementById('localCourseFixture').remove();
    const frame = document.createElement('iframe');
    frame.src = '/visit/interaction';
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
const sources = ['adapters/chaoxing.js', 'dropdown.js', 'extractor.js', 'ai-extractor.js', 'filler.js', '../course/watch.js', 'panel.js']
  .map((p) => fs.readFileSync(path.join(root, 'content/homework', p), 'utf8')).join('\n;\n');
const html = fixture + `<script>${sources}</script><script>window.runDetectionChecks=${browserChecks.toString()};</script>`;
const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(req.url === '/visit/interaction' ? '<!doctype html><title>内嵌课程列表样例</title>' : html); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-crash-reporter', '--disable-breakpad', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
let socket;
try {
  let port;
  for (let i = 0; i < 150; i++) {
    const file = path.join(profile, 'DevToolsActivePort');
    if (fs.existsSync(file)) { port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]); break; }
    if (child.exitCode !== null) throw new Error('Headless Edge exited before opening DevTools');
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
  const results = await checking;
  for (const r of results) console.log(r.ok ? 'PASS' : 'FAIL', r.name, r.error || '');
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  for (const mode of ['loading', 'mixed', 'error', 'empty']) {
    const state = await evaluate(`setDetectionUI(${JSON.stringify(mode)})`);
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, `ui-${mode}.png`), Buffer.from(shot.data, 'base64'));
    console.log('UI', mode, JSON.stringify(state));
  }
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
  for (const width of [1280, 420]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await evaluate('setPanelMode("watch")');
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, `ui-watch-${width}.png`), Buffer.from(shot.data, 'base64'));
    const watch = await evaluate(`(() => {const s=document.querySelector('#hw-panel-host').shadowRoot,p=s.querySelector('.panel'),r=p.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:innerHeight,width:innerWidth,overflow:p.scrollHeight>p.clientHeight,log:s.querySelector('.logwrap').getBoundingClientRect().height};})()`);
    console.log('UI watch geometry', width, watch);
    assert.ok(watch.left>=0 && watch.right<=watch.width && watch.top>=0 && watch.bottom<=watch.height && !watch.overflow && watch.log>=96);
    await evaluate('setPanelMode("homework")');
  }
  assert.ok(results.every((r) => r.ok), 'Browser checks failed; see .tmp-ai-tests/results.json');
  console.log(`\n${results.length} browser groups passed. Screenshots: ${output}`);
} finally {
  socket?.close();
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
