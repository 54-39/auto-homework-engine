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

  const CX = {
    match() {
      return !!document.querySelector('.questionLi[typename]');
    },
    extract() {
      return [...document.querySelectorAll('.questionLi')].map((q, i) => {
        const id = (q.id || '').replace(/^question/, '');
        const type = TYPE_MAP[q.getAttribute('typename')] || 'choice';
        const stem = norm((q.querySelector('.mark_name, .Zy_TItle') || q).textContent).slice(0, 300);
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
          return { key, text: norm((row.querySelector('.answer_p') || row).textContent), input: null, clickEl: row };
        });
        return {
          meta: { index: i, type, stem, options: labels.map((l) => ({ key: l.key, text: l.text })) },
          el: { inputs: [], labels, stateInput },
        };
      });
    },
  };
  window.HW.CXAdapter = CX;
})();
