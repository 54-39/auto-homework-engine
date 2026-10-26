import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(process.env.BBS_SOURCE||new URL('../content/course/bbs.js',import.meta.url),'utf8');
const priorReply='学习这份材料时，可以先梳理关键概念，再结合实例逐步实践，并通过结果验证理解。遇到问题时记录现象和解决过程，便于后续复习与交流。';
async function fixture({existing=false,sends=true,pauseAfterSend=false}={}){
 const posts=existing?[priorReply]:[],messages=[],values=new Map();let paused=false,closed=0;
 const input={value:'',focus(){},dispatchEvent(){},getClientRects:()=>[{}]};
 const button={textContent:'回复',getClientRects:()=>[{}],click(){if(sends)posts.push(input.value);if(pauseAfterSend)paused=true;}};
 const body={get innerText(){return '课程讨论正文\n'+posts.join('\n');}};
 const location={href:'https://groupweb.chaoxing.com/not-topic'};
 const ctx=vm.createContext({window:{},location,document:{body,querySelectorAll:sel=>sel==='textarea'?[input]:[button]},
  getComputedStyle:()=>({display:'block',visibility:'visible'}),setTimeout:fn=>fn(),Event:class{},Math,Date,
  sessionStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},
  chrome:{runtime:{sendMessage:async message=>{messages.push(message);return{ok:true,queue:{paused}};}}}});
 ctx.window.close=()=>closed++;vm.runInContext(source,ctx);
 location.href='https://groupweb.chaoxing.com/course/topic/test';await ctx.window.HW.Bbs.run();
 return{posted:messages.some(message=>message.type==='HW_BBS_REPLIED'),closed,replied:values.has('hwBbsReplied'),last:ctx.window.HW.Bbs.last};
}
{
 const r=await fixture({existing:true,sends:false});assert.equal(r.posted,false);assert.equal(r.closed,0);assert.equal(r.replied,false);assert.equal(r.last,null);
 console.log('PASS 已有同文回复且本次发送失败时，不冒充回帖成功或补发任务记账');
}
{
 const r=await fixture({existing:true});assert.equal(r.posted,true);assert.equal(r.closed,1);assert.equal(r.replied,true);
 console.log('PASS 已有同文回复时，本次确实新增回帖仍正常确认');
}
{
 const r=await fixture();assert.equal(r.posted,true);assert.equal(r.closed,1);
 console.log('PASS 首次回帖成功按原流程通知并关闭辅助话题页');
}
{
 const r=await fixture({pauseAfterSend:true});assert.equal(r.posted,false);assert.equal(r.closed,0);assert.equal(r.replied,false);
 console.log('PASS 回帖等待中暂停队列后不再补发完成通知');
}
