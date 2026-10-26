import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const sw=fs.readFileSync(new URL('../background/service-worker.js',import.meta.url),'utf8');
const panel=fs.readFileSync(new URL('../content/homework/panel.js',import.meta.url),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
for(const action of ['stop','replace','normal']){
  let queue={tabId:7,index:0,courses:[{key:'a',scUrl:'https://example.test/a'},{key:'b',scUrl:'https://example.test/b'}]};
  const navigations=[];let release;
  const access=new Promise(resolve=>{release=resolve;});
  const ctx=vm.createContext({watchNavigationEpoch:0,loadQueue:async()=>structuredClone(queue),
    ensureWatchHostAccess:()=>access,saveQueue:async q=>{queue=q;},
    chrome:{tabs:{update:async(...args)=>navigations.push(args)}}});
  vm.runInContext(sw.slice(sw.indexOf('async function watchGo(index)'),sw.indexOf('async function detectPage(')),ctx);
  const pending=ctx.watchGo(1);await flush();
  if(action!=='normal'){ctx.watchNavigationEpoch++;queue=action==='stop'?null:{tabId:8,index:0,courses:[]};}
  release(true);await pending;
  assert.equal(navigations.length,action==='normal'?1:0);
  assert.equal(queue?.tabId,action==='stop'?undefined:action==='replace'?8:7);
  console.log('PASS 换课等待期间队列状态：'+action);
}
const marker="      } else if (type === 'HW_WATCH_QUEUE_GET') {";
const at=sw.indexOf(marker)+marker.length;
const body=sw.slice(at,sw.indexOf("      } else if (type === 'HW_WATCH_COURSE_DONE')",at));
const topic='https://groupweb.chaoxing.com/course/topic/expected';
for(const [tabId,url,allowed] of [[7,'https://mooc1.chaoxing.com/study',true],[8,topic,true],[9,topic,false],[8,topic+'-different',false]]){
  let response;
  const ctx=vm.createContext({URL,tabId,sender:{url},loadQueue:async()=>({tabId:7,topic:{tabId:8,url:topic}}),sendResponse:r=>{response=r;}});
  vm.runInContext('async function query(){'+body+'\n}',ctx);await ctx.query();
  assert.equal(!!response.queue,allowed);
  console.log('PASS 队列仅返回属主及登记话题页：'+tabId+' / '+allowed);
}
const start=panel.indexOf('    async function rerun(i) {');
const rerun=panel.slice(start,panel.indexOf('    chrome.runtime.onMessage.addListener((msg) => {',start));
for(const busy of [true,false]){
  const calls=[];const ctx=vm.createContext({detecting:false,autoRun:false,els:{stop:{disabled:!busy}},answerEpoch:1,stopRequested:false,
    requireCurrentPage:()=>true,setRow(){},log(){},send:async(type,payload)=>{calls.push({type,payload});return{ok:true};}});
  vm.runInContext(rerun,ctx);await ctx.rerun(0);
  assert.equal(calls.length,busy?0:1);assert.equal(ctx.answerEpoch,busy?1:2);
  console.log('PASS 单题重问不干扰整页队列：busy='+busy);
}
