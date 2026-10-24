/* 超星学习通专用适配器（真实 DOM 结构于 2026-09-26 在 mooc2 作业页实测确认）：
   - 题块 .questionLi[id=question{id}][typename=单选题/多选题/判断题/填空题/简答题/写作题]
   - 答案状态载体 = 隐藏 input[name="answer{id}"] 的 value（"A"/"ABC"/对错，写作题存 JSON；""=未答，提交读它）
   - 题型另有隐藏 input[name="answertype{id}"]（0 单选 1 多选 2 填空 3 判断 4 简答；2026-10-11 实测写作题 = 26）
   - 可见选项 = .answerBg 行，点击行即写入状态；选中标记 = 字母圈 span 的 check_answer 类
   - 简答 = textarea / UEditor iframe；写作题 = 可见 textarea（.textarea26，页面 input 事件把正文写进隐藏 input） */
(function () {
  'use strict';
  window.HW = window.HW || {}; // 必须先建命名空间（适配器是第一个加载的内容脚本）
  if (window.HW.CXAdapter) return;
  const TYPE_MAP = { '单选题': 'choice', '多选题': 'multi', '判断题': 'judge', '填空题': 'blank', '简答题': 'subjective', '写作题': 'subjective' };
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const textOf = el => window.HW.AIDetection?.textOf?.(el) || norm(el.textContent);

  const CX = {
    discussion(doc = document) {
      const title = doc.querySelector('.topicDetail_detail .topicDetail_title');
      const box = doc.querySelector('.topicDetail_editContainer textarea[placeholder="回复话题"]');
      if (!title || !box) return null;
      // 按用户指定的页面状态：出现同学回复记录后，不再列为待答讨论题。
      const completed = !!doc.querySelector('.topicDetail_replyList .topicDetail_replyItem');
      return { title, box, completed, body: title.closest('.topicDetail_detail')?.querySelector('.richText') };
    },
    match(doc = document) {
      return !!doc.querySelector('.questionLi[typename],#answer_form .question-item') || !!CX.discussion(doc);
    },
    extract(doc = document) {
      if (doc.querySelector('#answer_form .question-item')) {
        if (/手动结束|已结束/.test(doc.querySelector('.tip')?.textContent || '')) return [];
        return [...doc.querySelectorAll('#answer_form .question-item')].map((q, index) => {
          const stem = textOf(q.querySelector('.topic-txt'));
          const inputs = [...q.querySelectorAll('textarea,input[type="text"]')].filter(el => !el.disabled && !el.readOnly);
          const labels = [...q.querySelectorAll('.optionRadio,.optionCheckbox')].map((row, i) => ({
            key: 'ABCDEFGH'[i], text: textOf(row.querySelector('.optionContent') || row),
            input: row.querySelector('input[type="radio"],input[type="checkbox"]'), clickEl: row,
          })).filter(label => label.input && !label.input.disabled);
          const type = labels.length ? labels[0].input.type === 'checkbox' ? 'multi' : 'choice' : 'subjective';
          return stem && (labels.length || inputs.length) ? {
            meta: { index, type, stem, options: labels.map(({ key, text }) => ({ key, text })) }, el: { inputs, labels },
          } : null;
        }).filter(Boolean);
      }
      const topic = CX.discussion(doc);
      if (topic) {
        if (topic.completed || !topic.box.getClientRects().length || topic.box.disabled || topic.box.readOnly) return [];
        const stem = [textOf(topic.title), topic.body && textOf(topic.body)].filter(Boolean).join('\n');
        return [{ meta: { index: 0, type: 'subjective', stem, options: [], blanks: 0 },
          el: { inputs: [topic.box], labels: [], contexts: [topic.title, topic.body].filter(Boolean) } }];
      }
      return [...doc.querySelectorAll('.questionLi')].map((q, i) => {
        const id = (q.id || '').replace(/^question/, '');
        const code = q.querySelector('input[name="answertype' + id + '"]')?.value;
        const type = TYPE_MAP[q.getAttribute('typename')] || { 0: 'choice', 1: 'multi', 2: 'blank', 3: 'judge', 4: 'subjective' }[code];
        if (!type) return null;
        const stem = textOf(q.querySelector('.mark_name, .Zy_TItle') || q).slice(0, 300);
        const stateInput = q.querySelector('input[name="answer' + id + '"]');
        if (type === 'subjective' || type === 'blank') {
          const tas = [...q.querySelectorAll('textarea')];
          const iframe = q.querySelector('iframe');
          // 填空题：一个空一个 UEditor（交卷时页面用 UE.getEditor("answerEditor{id}{j}").getContent()
          // 现取正文，隐藏 textarea 只是源码容器，写它无效）；写作题仍走那个可见 textarea
          const eds = type === 'blank' ? [...q.querySelectorAll('[class*="edui-editor"] iframe')] : [];
          // 空数以页面声明为准（隐藏 input[name=tiankongsize{id}]），读不到才退回编辑器/文本框数量。
          // 题干里的 "____" 个数不等于空数：第22题题干两个下划线，页面只有 1 个空。
          const sizeEl = type === 'blank' ? q.querySelector('input[name="tiankongsize' + id + '"]') : null;
          const blanks = type === 'blank' ? parseInt(sizeEl && sizeEl.value, 10) || eds.length || tas.length : 0;
          return {
            meta: { index: i, type, stem, blanks, writing: type === 'subjective' && q.getAttribute('typename') === '写作题' },
            el: {
              inputs: type === 'blank' ? tas : tas.slice(0, 1),
              iframe: type === 'subjective' && iframe ? iframe : null,
              iframes: eds,
              labels: [],
              stateInput,
            },
          };
        }
        const rows = [...q.querySelectorAll('.answerBg')];
        const labels = rows.map((row, idx) => {
          const letterEl = row.querySelector('[class*="num_option"]');
          let key = norm((letterEl ? letterEl.textContent : '')).toUpperCase()[0] || 'ABCDEFGH'[idx] || 'A';
          // 判断题真值在字母圈 span 的 data 上（true=对 / false=错，2026-10-14 导出页实测）；
          // b.ri/b.wr 是旧版式的图标标记，保留兼容
          if (type === 'judge') {
            const d = (letterEl ? letterEl.getAttribute('data') : '') || '';
            key = /^true$/i.test(d) || row.querySelector('b.ri') ? 'T' : /^false$/i.test(d) || row.querySelector('b.wr') ? 'F' : key;
          }
          return { key, text: textOf(row.querySelector('.answer_p') || row), input: null, clickEl: row };
        });
        return {
          meta: { index: i, type, stem, options: labels.map((l) => ({ key: l.key, text: l.text })) },
          el: { inputs: [], labels, stateInput },
        };
      }).filter(Boolean);
    },
  };
  window.HW.CXAdapter = CX;
})();
