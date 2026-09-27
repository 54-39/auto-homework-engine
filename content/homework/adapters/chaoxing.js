/* 超星学习通专用适配器（真实 DOM 结构于 2026-09-26 在 mooc2 作业页实测确认）：
   - 题块 .questionLi[id=question{id}][typename=单选题/多选题/判断题/填空题/简答题]
   - 答案状态载体 = 隐藏 input[name="answer{id}"] 的 value（"A"/"ABC"/对错，""=未答，提交读它）
   - 题型另有隐藏 input[name="answertype{id}"]（0 单选 1 多选 2 填空 3 判断 4 简答）
   - 可见选项 = .answerBg 行，点击行即写入状态；选中标记 = 字母圈 span 的 check_answer 类
   - 简答 = textarea / UEditor iframe */
(function () {
  'use strict';
  window.HW = window.HW || {}; // 必须先建命名空间（适配器是第一个加载的内容脚本）
  if (window.HW.CXAdapter) return;
  const TYPE_MAP = { '单选题': 'choice', '多选题': 'multi', '判断题': 'judge', '填空题': 'blank', '简答题': 'subjective' };
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
          const ta = q.querySelector('textarea');
          const iframe = q.querySelector('iframe');
          return {
            meta: { index: i, type, stem },
            el: { inputs: ta ? [ta] : [], iframe: type === 'subjective' && iframe ? iframe : null, labels: [], stateInput },
          };
        }
        const rows = [...q.querySelectorAll('.answerBg')];
        const labels = rows.map((row, idx) => {
          const letterEl = row.querySelector('[class*="num_option"]');
          let key = norm((letterEl ? letterEl.textContent : '')).toUpperCase()[0] || 'ABCDEFGH'[idx] || 'A';
          if (type === 'judge') key = row.querySelector('b.ri') ? 'T' : row.querySelector('b.wr') ? 'F' : key;
          return { key, text: norm((row.querySelector('.answer_p') || row).textContent), input: null, clickEl: row };
        });
        return {
          meta: { index: i, type, stem, options: labels.map((l) => ({ key: l.key, text: l.text })) },
          el: { inputs: [], labels, stateInput },
        };
      });
    },
    /* 当前页面答案（权威来源：隐藏 answer input 的 value） */
    answerOf(q) {
      return q.el.stateInput ? String(q.el.stateInput.value || '').trim() : null;
    },
  };
  window.HW.CXAdapter = CX;
})();
