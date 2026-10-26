import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(process.env.PANEL_SOURCE||new URL('../content/homework/panel.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('    function renderCourseProgress('),source.indexOf('    function renderQueue()'));
function fixture(){
 let state={};const attrs={},els={watchprogress:{classList:{toggle(){}}},wpvalue:{textContent:'',dataset:{}},wpfill:{style:{}},wptrack:{setAttribute:(k,v)=>attrs[k]=v,removeAttribute:k=>delete attrs[k]}};
 const ctx=vm.createContext({Number,Math,document:{querySelector:()=>({textContent:state.native||''})},els,setText:(el,text)=>{el.textContent=text;},
  HW:{Watch:{currentCourse:()=>state.current===false?null:{key:'1|2'},nodes:()=>Object.keys(state.left||{}).map(id=>({id})),unfinishedOf:id=>state.left[id]}}});
 vm.runInContext(code,ctx);
 return {render(next,queued){state=next;ctx.renderCourseProgress(queued);return {text:els.wpvalue.textContent,percent:attrs['aria-valuenow']??null,tip:els.wpvalue.dataset.tip,width:els.wpfill.style.width};}};
}
const f=fixture();
{
 const result=f.render({left:{a:0,b:3,c:null}});
 assert.equal(result.text,'至少 33% · 1/3 节');assert.equal(result.percent,'33');assert.ok(result.tip.includes('1 节状态待核对'));
 console.log('PASS 单个未知章节不再阻断整门课程进度，未知不算完成');
}
{
 const result=f.render({left:{a:0,b:0,c:null}});assert.equal(result.percent,'66');assert.ok(result.text.startsWith('至少 '));assert.notEqual(result.percent,'100');
 const loaded=f.render({left:{a:0,b:0,c:0}});assert.equal(loaded.text,'100% · 3/3 节');assert.equal(loaded.tip,'');
 console.log('PASS 未知章节未确认前不显示满进度，状态加载后恢复正常进度');
}
{
 const result=f.render({left:{a:0,b:2,c:null}}, {key:'1|2',done:3,total:10});
 assert.equal(result.text,'至少 33% · 1/3 节');
 console.log('PASS 有实时章节状态时持续更新已确认进度，不用旧队列覆盖');
}
{
 const result=f.render({left:{a:null,b:null}},{key:'1|2',done:4,total:10});
 assert.equal(result.text,'40% · 4/10 任务点（上次读取）');
 const other=f.render({left:{a:null,b:null}},{key:'3|4',done:10,total:10});assert.equal(other.percent,null);
 console.log('PASS 全部章节状态未知可回显同一门课程上次读取，不串用其他课程');
}
{
 const result=f.render({left:{a:null,b:null}});assert.equal(result.percent,null);assert.equal(result.text,'暂未读取到进度');assert.equal(result.width,'0%');
 console.log('PASS 没有任何可靠数据时明确说明未读到，不能无限显示读取中或伪报0%');
}
{
 const result=f.render({native:'已完成任务点：17/24',left:{a:0,b:null}});assert.equal(result.text,'70% · 17/24 任务点');
 const live=f.render({native:'已完成任务点：0/10',left:{a:0,b:3}});assert.equal(live.text,'70% · 7/10 任务点');
 console.log('PASS 原生任务总数和完整章节剩余数仍优先，保留实时任务进度');
}
{
 const result=f.render({native:'已完成任务点：25/24'});assert.equal(result.percent,null);
 console.log('PASS 异常任务数量仍不冒充真实百分比');
}
