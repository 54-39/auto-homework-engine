import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(process.env.WATCH_SOURCE||new URL('../content/course/watch.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('  function surveyCard()'),source.indexOf('  /* 万能兜底'));
function fixture(state,{foreign=false,verification=false,deferred=false,alreadyReloaded=false,storageFailure=false}={}){
 let ticks=0,reloads=0,topReloads=0,listener,queries=0,remaining=1,chapter='1';const notes=[],timers=[], STOP=Symbol('stop'),frameWindow={};
 const frame={contentWindow:frameWindow,get src(){return 'https://mobilelearn.chaoxing.com/page/questionnaire/answerQuestionChapter?test=1';},set src(v){reloads++;}};
 const overlay={style:{display:'block'},contains:f=>f===frame};
 const doc={URL:'https://mooc1.chaoxing.com/ananas/modules/zt/vote/index.html',querySelector:()=>({click(){}})};
 const ctx=vm.createContext({on:true,gen:1,STOP,URL,JSON,String,sessionStorage:{getItem:()=>alreadyReloaded?'1':null,setItem(){if(storageFailure)throw Error('存储失败');}},
  docs:()=>[doc],activeChapterId:()=>chapter,unfinishedOf:()=>remaining,live(){},note:t=>notes.push(t),
  document:{querySelector:sel=>sel==='#voteIframe'?frame:overlay},
  window:{addEventListener:(type,fn)=>{listener=fn;},removeEventListener:()=>{listener=null;}},
  checkVerification(){if(verification)throw Object.assign(Error('验证'),{code:'HW_VERIFICATION_REQUIRED'});},
  step:async()=>{ticks++;if(state==='stop')throw STOP;if(foreign&&listener)listener({origin:'https://example.invalid',source:{},data:{cmd:'callBackFinishJob'}});},
  chrome:{runtime:{sendMessage:async message=>{queries++;return {ok:true,state:state==='stale'?'pending':state};}}},
  setTimeout:fn=>deferred?timers.push(fn):fn(),location:{reload:()=>topReloads++}});
 vm.runInContext(code,ctx);return{run:()=>ctx.openSurveyCard(),frame,overlay,STOP,ticks:()=>ticks,reloads:()=>reloads,topReloads:()=>topReloads,queries:()=>queries,listener:()=>listener,
  stop:()=>{ctx.on=false;ctx.gen++;},restart:()=>{ctx.gen++;},changeChapter:()=>{chapter='2';},flush:()=>timers.splice(0).forEach(fn=>fn())};
}
{
 const f=fixture('expired');await assert.rejects(f.run(),/已被教师结束|已截止/);assert.equal(f.ticks(),1);assert.equal(f.overlay.style.display,'none');assert.equal(f.reloads(),0);assert.equal(f.listener(),null);console.log('PASS 已截止问卷及时收起弹层，记录未完成，不阻塞后续章节');
}
{
 const f=fixture('stale',{foreign:true});assert.equal(await f.run(),false);assert.equal(f.reloads(),1);assert.equal(f.topReloads(),0);assert.equal(f.overlay.style.display,'none');assert.equal(f.ticks(),90);console.log('PASS 无回执问卷仅重载自身一次，伪造来源消息不能算完成');
}
{
 const f=fixture('submitted');assert.equal(await f.run(),true);assert.equal(f.topReloads(),1);assert.equal(f.reloads(),0);assert.equal(f.overlay.style.display,'none');console.log('PASS 真实提交结果刷新一次目录核对，不重复作答');
}
{
 const f=fixture('stop');await assert.rejects(f.run(),e=>e===f.STOP);assert.equal(f.queries(),0);assert.equal(f.reloads(),0);assert.equal(f.listener(),null);console.log('PASS 用户停止立即退出问卷等待并移除监听');
}
{
 const f=fixture('stale',{verification:true});await assert.rejects(f.run(),e=>e.code==='HW_VERIFICATION_REQUIRED');assert.equal(f.reloads(),0);console.log('PASS 问卷重载前检查真实验证，不解除验证暂停');
}
for(const action of ['stop','restart','changeChapter']){
 const f=fixture('submitted',{deferred:true});assert.equal(await f.run(),true);f[action]();f.flush();assert.equal(f.topReloads(),0);
 console.log('PASS 问卷已提交后的延迟刷新尊重 '+action+'，不刷新后续操作');
}
{
 const f=fixture('submitted',{alreadyReloaded:true});assert.equal(await f.run(),true);assert.equal(f.ticks(),2);assert.equal(f.topReloads(),0);
 console.log('PASS 已提交且刷新过目录的问卷及时继续，不重复等待同一回执');
}
{
 const f=fixture('submitted',{storageFailure:true});assert.equal(await f.run(),true);assert.equal(f.topReloads(),0);
 console.log('PASS 无法保存刷新标记时不盲目刷新，避免刷新循环');
}
