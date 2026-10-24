import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source=fs.readFileSync(new URL('../content/course/watch.js',import.meta.url),'utf8');
const monitor=source.slice(source.indexOf('  const STALL_TIMEOUT ='),source.indexOf('  async function courseLoop()'));
function fixture(){
  let now=0,chapter='2.4',remaining=1,task='dct1',page='1',scroll=0;
  const media=[],questions=[],writes=[],notes=[];
  class Clock extends Date{static now(){return now;}}
  const doc={URL:'https://mooc1.chaoxing.com/mooc-ans/screen/file',readyState:'complete',scrollingElement:{scrollTop:0},
    querySelectorAll: selector=>selector.includes('pageNum')?[{get value(){return page;}}]:selector.includes('viewerContainer')?[{get scrollTop(){return scroll;}}]:[]};
  const context=vm.createContext({on:true,Date:Clock,URL,Math,Number,JSON,
    document:{title:'测试课程',hidden:false},location:{href:'https://mooc1.chaoxing.com/mycourse/studentstudy?token=fixture'},
    activeChapterId:()=>chapter,unfinishedOf:()=>remaining,tabList:()=>[{id:task,textContent:'学理'}],tabActive:()=>true,
    allVideos:()=>media,docs:()=>[doc],nodes:()=>[{id:chapter,name:'2.4 测试章节'}],currentCourse:()=>({name:'测试课程'}),
    HW:{questions,Watch:{stopTrace:[]},Diagnostics:{capture:()=>({status:'captured',documents:[{html:'已脱敏现场'}]})}},
    note:text=>notes.push(text),chrome:{runtime:{sendMessage:async message=>{writes.push(message);return{ok:true};}}},
  });
  vm.runInContext(monitor,context);
  return{context,media,questions,writes,notes,doc,advance:ms=>{now+=ms;},chapter:value=>{chapter=value;},remaining:value=>{remaining=value;},task:value=>{task=value;},page:value=>{page=value;},scroll:value=>{scroll=value;},check:(active)=>context.observeProgress(active)};
}
{
  const f=fixture();await f.check();f.advance(299999);await f.check();assert.equal(f.writes.length,0);
  f.advance(1);await f.check();assert.equal(f.writes.length,1);
  const payload=f.writes[0].payload;assert.equal(payload.stage,'刷课停滞');assert.equal(payload.chapter,'2.4 测试章节');
  assert.equal(JSON.parse(payload.details).idleSeconds,300);assert.equal(payload.scene.status,'captured');
  for(let i=0;i<10;i++){f.advance(30000);await f.check();}assert.equal(f.writes.length,1);assert.equal(f.context.on,true);
  console.log('PASS 5分钟无进展自动记录现场，同次只记一次，保持队列运行');
}
{
  const f=fixture();const v={currentTime:0,duration:7200,paused:false,ended:false,readyState:4};f.media.push(v);
  for(let i=0;i<120;i++){await f.check();f.advance(30000);v.currentTime+=30;}
  assert.equal(f.writes.length,0);console.log('PASS 同一章节正常播放一小时不误报');
}
{
  const f=fixture();const v={currentTime:0,duration:7200,paused:true,ended:false,readyState:2};f.media.push(v);
  await f.check();for(let i=0;i<10;i++){f.advance(30000);v.paused=!v.paused;v.readyState=v.readyState===2?4:2;f.doc.readyState=i%2?'complete':'loading';await f.check();}
  assert.equal(f.writes.length,1);console.log('PASS 播放按钮和加载状态反复变化不冒充真实进展');
}
for(const type of ['page','scroll','task','chapter','remaining','answers']){
  const f=fixture();await f.check();f.advance(240000);
  if(type==='answers')f.questions.push({_status:'filled'});else f[type](type==='remaining'?0:'2');
  await f.check();f.advance(240000);await f.check();assert.equal(f.writes.length,0,type);
  f.advance(60000);await f.check();assert.equal(f.writes.length,1,type);
  console.log('PASS 实际进展重新计时：'+type);
}
{
  const f=fixture();await f.check();f.advance(240000);await f.check(false);f.advance(3600000);
  await f.check(false);assert.equal(f.writes.length,0);await f.check(true);assert.equal(f.writes.length,0);
  f.advance(300000);await f.check(true);assert.equal(f.writes.length,1);
  f.page('2');await f.check(true);f.advance(300000);await f.check(true);assert.equal(f.writes.length,2);
  console.log('PASS 停止或暂停时不计时，继续后重新计时，恢复进展后可记录新一轮停滞');
}
{
  const f=fixture();f.context.on=false;await f.check(true);f.advance(300000);await f.check(true);
  assert.equal(f.writes.length,1);assert.equal(JSON.parse(f.writes[0].payload.details).running,false);
  console.log('PASS 队列仍活动但循环已退出时，也能记录空转现场');
}
{
  const f=fixture();f.context.chrome.runtime.sendMessage=async()=>({ok:false,error:'写入失败'});
  await f.check();f.advance(300000);await f.check();assert.ok(f.notes[0].includes('保存失败'));assert.equal(f.context.on,true);
  console.log('PASS 记录保存失败明确提示，不中断任务');
}
{
  const panel=fs.readFileSync(new URL('../content/homework/panel.js',import.meta.url),'utf8');
  const start=panel.indexOf('    if (window.top === window) setInterval(async () => {');
  const end=panel.indexOf('    }, 30000);',start)+'    }, 30000);'.length;
  let tick,queue=null;const observations=[];const win={};win.top=win;
  const context=vm.createContext({window:win,userStopped:false,reviveCount:2,reviveMark:'old',reviveAt:Infinity,Date,
    setInterval:fn=>{tick=fn;},send:async()=>({queue}),HW:{Watch:{running:true,pageKind:()=> 'study',observeProgress:async(active=true)=>observations.push(active)}}});
  vm.runInContext(panel.slice(start,end),context);await tick();assert.deepEqual(observations,[true]);
  context.HW.Watch.running=false;queue={paused:false};await tick();assert.equal(observations.at(-1),true);
  queue.paused=true;await tick();assert.equal(observations.at(-1),false);
  queue=null;await tick();assert.equal(observations.at(-1),false);
  context.userStopped=true;await tick();assert.equal(observations.at(-1),false);
  console.log('PASS 看门狗运行中与接续退避期间均检查进展，暂停、无队列和用户停止时停用检测');
}
