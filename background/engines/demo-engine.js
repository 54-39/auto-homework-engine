/* 演示引擎：内置小型题库（与 test/mock-homework.html 对应），
   零配置即可验证"提取 → 答题 → 填写"全流程。未收录的题返回占位答案。 */

const KB = [
  { re: /一周有.*天.*一年有.*个月/, type: 'blank', ans: '7;12' },
  { re: /最长的河流/, type: 'blank', ans: '长江' },
  { re: /3\s*[×x*]\s*7/, type: 'blank', ans: '21' },
  { re: /一年有多少个月|一年有.*个月/, type: 'choice', ans: 'C' },
  { re: /首都/, type: 'choice', ans: 'B' },
  { re: /偶数/, type: 'choice', ans: 'C' },
  { re: /静夜思/, type: 'choice', ans: 'C' },
  { re: /化学式/, type: 'choice', ans: 'B' },
  { re: /四大发明/, type: 'multi', ans: 'ABCD' },
  { re: /哺乳动物/, type: 'multi', ans: 'AC' },
  { re: /地球是太阳系/, type: 'judge', ans: '对' },
  { re: /1\s*\+\s*1\s*=\s*3/, type: 'judge', ans: '错' },
  {
    re: /光合作用/,
    type: 'subjective',
    ans: '光合作用是绿色植物利用光能，把二氧化碳和水转化为储存能量的有机物（主要是淀粉），并释放氧气的过程。它的意义在于：为植物自身和其他生物提供有机物和能量，是生态系统中物质循环和能量流动的起点；同时释放氧气，维持大气中氧气与二氧化碳的平衡，为绝大多数生命的生存提供基础。',
  },
  {
    re: /学而不思则罔/,
    type: 'subjective',
    ans: '"学而不思则罔"指只读书学习而不思考，就会迷惑而无所得。学习不能停留在被动接受，要对知识进行理解、质疑和消化，把别人的结论变成自己的认识；同时"思而不学则殆"提醒我们空想而不学习也会陷入危险。只有学思结合、举一反三，才能真正掌握知识并灵活运用到实践中。',
  },
];

export async function answerWithDemo(q) {
  await new Promise((r) => setTimeout(r, 400 + Math.random() * 800)); // 模拟网络延迟
  const hit = KB.find((k) => k.re.test(q.stem || '') && (!k.type || k.type === q.type));
  if (hit) return { answer: hit.ans, demo: true };
  if (q.type === 'choice' || q.type === 'multi') return { answer: 'A', demo: true, note: '演示引擎未收录该题，默认返回 A' };
  if (q.type === 'judge') return { answer: '对', demo: true, note: '演示引擎未收录该题' };
  return { answer: '（演示引擎占位答案，仅供流程测试。）', demo: true };
}
