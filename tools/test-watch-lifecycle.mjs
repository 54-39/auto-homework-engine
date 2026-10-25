import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=fs.readFileSync(process.env.WATCH_SOURCE||new URL('../content/course/watch.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('  function start(opts)'),source.indexOf('  HW.Watch = {'));
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(){
  const pending=[],messages=[];let stopped=0;
  const context=vm.createContext({on:false,gen:0,scopeChapters:null,rate:2,autoRate:false,rateNoted:false,
    failedChapters:new Set(),bbsTried:new Set(),quizRetrySignals:new Set(),quizGrades:new Map(),
    live(){},note(){},onStop(){},STOP:Symbol('stop'),multi:null,
    stop:()=>{if(context.on)stopped++;context.on=false;context.gen++;},
    courseLoop:()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),
    recordWatchSkip:async()=>{},reportCourseDone:async()=>{},
    chrome:{runtime:{sendMessage:async message=>{messages.push(message);return{ok:true};}}},
  });
  vm.runInContext(code,context);
  return{context,pending,messages,start:()=>context.start({rate:2}),stopped:()=>stopped};
}
{
  const f=fixture();f.start();assert.equal(f.context.on,true);
  f.pending[0].resolve();await flush();
  assert.equal(f.context.on,false,'课程循环已经返回，运行标记仍为真');
  assert.equal(f.stopped(),1);
  console.log('PASS 循环结束即复位运行标记，导航没有发生时也不假装运行');
}
{
  const f=fixture();f.start();f.start();const generation=f.context.gen;
  f.pending[0].resolve();await flush();
  assert.equal(f.context.on,true);assert.equal(f.context.gen,generation,'旧循环收尾停止了新循环');
  f.pending[1].resolve();await flush();assert.equal(f.context.on,false);
  console.log('PASS 旧循环迟到收尾不影响新一轮');
}
{
  const f=fixture();f.start();
  f.pending[0].reject(Object.assign(Error('请人工验证'),{code:'HW_VERIFICATION_REQUIRED'}));await flush();
  assert.equal(f.context.on,false);
  assert.ok(f.messages.some(message=>message.type==='HW_WATCH_PAUSE'));
  console.log('PASS 验证暂停仍持久化，不自动恢复验证操作');
}
