import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(process.env.SURVEY_SOURCE||new URL('../content/course/survey.js',import.meta.url),'utf8');
let opened=false,clicks=0;
const tip={textContent:'进行中',getClientRects:()=>[{}]},modal={textContent:'提交成功',getClientRects:()=>opened?[{}]:[]};
const confirm={textContent:'确定',getClientRects:()=>opened?[{}]:[],getBoundingClientRect:()=>({width:100}),click(){opened=false;}};
const submit={textContent:'提交',getClientRects:()=>[{}],click(){clicks++;opened=true;}};
const item={querySelector:sel=>sel.includes(':checked')?{}:null};
const location={href:'https://example.invalid/not-survey'};
const ctx=vm.createContext({window:{},location,Date,Math,getComputedStyle:()=>({display:'block',visibility:'visible'}),setTimeout:fn=>fn(),
 document:{querySelector:()=>tip,querySelectorAll:sel=>sel==='.question-item'?[item]:sel.includes('.tip,.maskDiv')?[tip,modal]:sel.includes('.popBottom')?[confirm]:[submit]},
 chrome:{runtime:{onMessage:{addListener(){}},sendMessage:async()=>({ok:true,queue:{paused:false}})}}});
vm.runInContext(source,ctx);location.href='https://mobilelearn.chaoxing.com/page/questionnaire/answerQuestionChapter';await ctx.window.HW.Survey.run();
assert.equal(clicks,1);assert.equal(opened,false);assert.equal(tip.textContent,'进行中');assert.equal(ctx.window.HW.Survey.last.state,'submitted');
console.log('PASS 已保存答案正常交卷，且仅弹窗中的真实成功回执在关闭后仍被保留');
