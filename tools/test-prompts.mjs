/* 写作题/主观题提示词与解析 mock 测试：只测 engine.js 纯函数（无 chrome 依赖）。
   用法: node tools/test-prompts.mjs（本地保留，不入库，同 test-update-check.mjs 惯例） */
import { buildMessages, parseAnswer, buildJudgeVerify, parseJudgeVerify } from '../background/engines/engine.js';
import { readFileSync } from 'node:fs';

let bad = 0;
const check = (name, cond, extra = '') => {
  console.log(cond ? 'PASS' : 'FAIL', name, extra);
  if (!cond) bad++;
};

const retryQuestion = { type: 'choice', stem: '选择正确答案', options: [{ key: 'A', text: '甲' }], _retry: true };
check('平台要求的重做独立核对答案，仅限刷课策略', buildMessages(retryQuestion, { bestEffort: true })[1].content.includes('唯一一次重做') && !buildMessages(retryQuestion)[1].content.includes('唯一一次重做'));
/* —— 写作题提示词（q.writing = true）—— */
const wq = { type: 'subjective', writing: true, stem: '请以 My Unforgettable Trip 为题写一篇英语作文，用课文生词词组至少5个。' };
const wm = buildMessages(wq);
check('写作题走专用分支（不出现【简答题】）', !wm[1].content.includes('【简答题】') && wm[1].content.includes('【写作题】'));
check('写作题禁止 Markdown', wm[1].content.includes('Markdown'));
check('写作题要求标题独占一行+行首空格', wm[1].content.includes('标题') && wm[1].content.includes('空格'));
check('写作题要求分段', wm[1].content.includes('分段'));
check('写作题字数按题干/默认', wm[1].content.includes('字数') && wm[1].content.includes('120~150'));
check('写作题不用 80~200 字套路', !wm[1].content.includes('80~200'));
check('写作题禁止"答："前缀与解释', wm[1].content.includes('不要"答："') && wm[1].content.includes('不要任何解释'));
check('写作题先审题再作答（三分类）', wm[1].content.includes('先审题再作答') && wm[1].content.includes('A. 要求写正文') && wm[1].content.includes('B. 要求上传截图') && wm[1].content.includes('C. 题干明确说只需在输入框输入指定文字'));
check('B 类外部材料：生成文字版+批改要点+修改后的作文', wm[1].content.includes('供截图或誊抄使用') && wm[1].content.includes('逐条输出') && wm[1].content.includes('修改后的作文'));
check('C 类指定文字：只输出那几个字', wm[1].content.includes('只输出那几个字'));
check('正文不混入提交确认词', wm[1].content.includes('不要混入') && wm[1].content.includes('提交确认词'));
check('审题拿不准按最小可交付输出', wm[1].content.includes('最小可交付内容'));

/* —— 简答题提示词（不 writing）—— */
const sm = buildMessages({ type: 'subjective', stem: '什么是光合作用？' });
check('简答题保留 80~200 字定位', sm[1].content.includes('80~200'));
check('简答题禁止 Markdown', sm[1].content.includes('Markdown'));
check('简答题不走写作分支', !sm[1].content.includes('【写作题】'));

/* —— parseAnswer：主观题保留换行与行首空格 —— */
const raw = '\n\n  My Trip  \n\n**Day 1** set off.\n\n## Header\n\n\n\nEnd.\n';
const parsed = parseAnswer({ type: 'subjective' }, raw);
check('主观题保留换行', parsed.includes('\n'), JSON.stringify(parsed));
check('标题行首空格保留（近似居中）', /^[ ]+My Trip$/m.test(parsed));
check('去 ** 标记', !parsed.includes('**'));
check('去行首 # 标题', !parsed.includes('##'));
check('3+ 连续空行压成一个空行', !parsed.includes('\n\n\n'));
check('去首尾空行', !parsed.startsWith('\n') && !parsed.endsWith('\n'));
check('正文内容无损（Day 1 set off / End 都在）', parsed.includes('Day 1 set off.') && parsed.includes('End.'));

/* —— parseAnswer：客观题/填空仍压成单行（norm 语义不变）—— */
/* —— 填空题提示词：空数必须下发（第22题事故：题干两个下划线、页面只有 1 个空）—— */
const b1 = buildMessages({ type: 'blank', stem: 'P(A)=0.3，P(B)=____，P(A∩B)=0.12。当且仅当两事件独立时，应填入的P(B)值为____。', blanks: 1 });
check('单空下发空数', b1[1].content.includes('只有 1 个空'));
check('单空要求只输出一个值', b1[1].content.includes('answers 数组只放这 1 个值'));
const b2 = buildMessages({ type: 'blank', stem: 'P(A∩B)=___，P(A∪B)=___', blanks: 2 });
check('双空下发空数并要求数组逐空输出', b2[1].content.includes('共 2 个空') && b2[1].content.includes('2 个值，一个空一个元素'));
const b0 = buildMessages({ type: 'blank', stem: '1+1=____' });
const automatic = buildMessages({ type:'choice', stem:'信息不足的题目', options:[{key:'B',text:'乙'}] }, {bestEffort:true});
/* 提示词在 1.0.4 收紧成「最可能正确的有效选项」；断言跟着当前措辞走，意图不变：
   必须逼出答案、保留题面选项范围、不许拿「无法确定」当借口。 */
check('仅刷课提示词要求尽力给出最可能答案，保留选项范围', automatic[1].content.includes('最可能正确') && automatic[1].content.includes('不能输出空数组') && automatic[1].content.includes('B. 乙') && !automatic[1].content.includes('无法确定答案时输出'));
check('空数未知时不下发、不误报单空', !b0[1].content.includes('共 0 个空') && !b0[1].content.includes('只有 1 个空') && b0[1].content.includes('一个空一个元素'));
check('填空题仍禁止解释', b1[0].content.includes('不输出任何解释'));
const blank = parseAnswer({ type: 'blank' }, '  答案A\n\n答案B  ');
check('填空仍压成单行', blank === '答案A 答案B', JSON.stringify(blank));
const choice = parseAnswer({ type: 'choice' }, ' blah\n\n答案：B\n');
check('选择仍取字母', choice === 'B', JSON.stringify(choice));

/* —— 判断题二次复核：构建 + 解析（第12题事故：模型把「A与B独立 ⇒ P(A|B̄)=P(A)」答成错）—— */
const jq = { type: 'judge', stem: '若事件A与B独立，则P(A|B̄)=P(A)' };
const jv = buildJudgeVerify(jq, '错');
check('判断题复核带上题干与初答', jv[1].content.includes('P(A|B̄)=P(A)') && jv[1].content.includes('初答：错'));
check('判断题复核要求独立核对分句与限定词', jv[1].content.includes('独立核对') && jv[1].content.includes('限定词'));
check('判断题复核只接受 JSON 结论（正确/错误）', jv[1].content.includes('{"answers":["正确"]}') && jv[1].content.includes('{"answers":["错误"]}'));
check('判断题复核不能可靠核实时留空', jv[1].content.includes('{"answers":[]}'));
check('复核解析：末行"对"', parseJudgeVerify('因为独立，所以结论成立。\n对') === '对');
check('复核解析：结论带前缀与句号', parseJudgeVerify('这样推下来\n结论：错。') === '错');
check('复核解析：理由里的"错"不算结论', parseJudgeVerify('独立不代表互斥，这个说法没有错。\n对') === '对');
check('复核解析：夹在句中的结论词不误判', parseJudgeVerify('这个说法是对的，因为独立可推出条件概率不变。') === '', JSON.stringify(parseJudgeVerify('这个说法是对的，因为独立可推出条件概率不变。')));
check('复核解析：√ 与 × 也认', parseJudgeVerify('理由若干\n√') === '对' && parseJudgeVerify('理由若干\n×') === '错');
check('复核解析：末行短语结论也认', parseJudgeVerify('推理若干\n所以该命题不正确') === '错' && parseJudgeVerify('推理若干\n这个说法正确') === '对');
check('复核解析：否定式不误判为正', parseJudgeVerify('推理若干\n不对') === '错' && parseJudgeVerify('推理若干\n该说法不正确。') === '错');
check('复核解析：跑题回答返回空（保持初答）', parseJudgeVerify('我不确定这道题。') === '');

/* —— api-engine 写作题 token 预算（源码断言，避免为它搭 chrome 桩）—— */
const src = readFileSync(new URL('../background/engines/api-engine.js', import.meta.url), 'utf8');
check('写作题 max_tokens 4096', src.includes('q.writing ? 4096'));
check('API 引擎对判断题跑复核', src.includes("['multi', 'judge'].includes(q.type) && answer && opts.verify2 !== false") && src.includes('buildJudgeVerify(q, answer)'));
check('API 引擎多选复核受 verify2 开关控制', src.includes("['multi', 'judge'].includes(q.type)") && src.includes('verify2 !== false'));
check('复核开关默认开启（verify2: true）', readFileSync(new URL('../background/service-worker.js', import.meta.url), 'utf8').includes('verify2: true, // 多选/判断题二次复核开关'));

process.exit(bad ? 1 : 0);
