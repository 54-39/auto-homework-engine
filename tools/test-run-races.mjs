import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
const source=fs.readFileSync(process.env.SW_SOURCE||new URL('../background/service-worker.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('async function fillAnswer('),source.indexOf('chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {'));
const stopStart=source.indexOf("} else if (type === 'HW_STOP') {")+"} else if (type === 'HW_STOP') {".length;
const stopCode=source.slice(stopStart,source.indexOf('} else if (type ===',stopStart));
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return{promise,resolve,reject};};
const flush=()=>new Promise(r=>setImmediate(r));
const runOf=(name='old',tabId=7)=>({tabId,sourceUrl:name,cancelled:false,items:[{q:{stem:name},status:'filled'}]});
function fixture(){
 const messages=[],cache=[];let asks=0;
 const context=vm.createContext({run:null,Date,crypto:{randomUUID},setTimeout,
  getConfig:async()=>({engine:'api'}),cacheKeyOf:async q=>q.stem,cached:async()=>({answer:'B'}),cacheSet:async(...args)=>cache.push(args),
  askEngine:async()=>{asks++;return{answer:'A'};},AUTH_RE:/401/,RISKY_RE:/captcha/,notify(){},pauseRun(){throw Error('unexpected pause');},
  sendTab:(tabId,message)=>{messages.push({tabId,...message});return Promise.resolve();},detectingTabs:new Map()});
 vm.runInContext(code+'\nfunction stop(tabId){const sendResponse=value=>value;'+stopCode+'\n}',context);
 return{context,messages,cache,asks:()=>asks};
}
{
 const f=fixture(),config=deferred();f.context.getConfig=()=>config.promise;
 const start=f.context.startRun([{_decision:'skip'}],7,'old');
 f.context.stop(7);config.resolve({engine:'api'});assert.equal((await start).ok,false);await flush();assert.equal(f.messages.length,0);
 console.log('PASS 读取配置期间停止不会迟到启动答题');
}
{
 const f=fixture(),view=deferred();let opened=0;
 f.context.getConfig=async()=>({engine:'bridge',bridge:{viewMode:'split'}});
 f.context.openBridgeView=async(tabId,cfg)=>{assert.equal(tabId,7);assert.equal(cfg.viewMode,'split');opened++;await view.promise;};
 const start=f.context.startRun([{_decision:'skip'}],7,'bridge');await flush();
 assert.equal(opened,1);assert.equal(f.messages.length,0);
 f.context.stop(7);view.resolve();assert.equal((await start).ok,false);assert.equal(f.messages.length,0);
 console.log('PASS 点击开始先准备豆包布局，等待期间停止不迟到启动答题');
}
{
 const f=fixture();f.context.getConfig=async()=>({engine:'bridge'});
 f.context.openBridgeView=async()=>{throw Error('布局未打开');};
 const result=await f.context.startRun([{_decision:'skip'}],7,'bridge');
 assert.equal(result.ok,false);assert.equal(result.error,'布局未打开');assert.equal(f.messages.length,0);
 console.log('PASS 豆包布局打开失败返回可见启动错误，不残留运行中队列');
}
{
 const f=fixture(),config=deferred();let reads=0;f.context.getConfig=()=>++reads===1?config.promise:Promise.resolve({engine:'api'});
 const older=f.context.startRun([{_decision:'skip'}],7,'old');await f.context.startRun([{_decision:'skip'}],7,'new');
 config.resolve({engine:'api'});assert.equal((await older).ok,false);assert.equal(f.context.run.sourceUrl,'new');
 assert.equal(f.messages.filter(m=>m.type==='HW_DONE').length,1);
 console.log('PASS 并发启动按最新操作运行，旧配置结果不覆盖新队列');
}
{
 const f=fixture();f.context.run=runOf('new',8);f.context.stop(7);assert.equal(f.context.run.cancelled,false);f.context.stop(8);assert.equal(f.context.run.cancelled,true);
 console.log('PASS 旧标签页停止请求不能取消另一标签页的新答题');
}
{
 const f=fixture(),config=deferred();f.context.run=runOf();f.context.getConfig=()=>config.promise;
 const result=f.context.rerunOne(0,7);f.context.run=runOf('new');config.resolve({engine:'api'});
 assert.equal((await result).ok,false);assert.equal(f.asks(),0);assert.equal(f.messages.length,0);
 console.log('PASS 重问读取配置期间换题，不会重问新题同一序号');
}
{
 const f=fixture(),key=deferred();f.context.run=runOf();f.context.cacheKeyOf=()=>key.promise;
 const result=f.context.rerunOne(0,7);await flush();f.context.run=runOf('new');key.resolve('old');
 assert.equal((await result).ok,false);assert.equal(f.cache.length,0);assert.ok(!f.messages.some(m=>m.type==='HW_ANSWER'));
 console.log('PASS 重问等待缓存键时换题，不写旧缓存或回填新页面');
}
{
 const f=fixture(),write=deferred();f.context.run=runOf();f.context.cacheSet=()=>write.promise;
 const result=f.context.rerunOne(0,7);await flush();f.context.run=runOf('new');write.resolve();
 assert.equal((await result).ok,false);assert.ok(!f.messages.some(m=>m.type==='HW_ANSWER'));
 console.log('PASS 已发出的缓存写入结束后仍检查当前队列，不迟到回填');
}
{
 const f=fixture(),answer=deferred();f.context.run=runOf();f.context.askEngine=()=>answer.promise;
 const result=f.context.rerunOne(0,7);await flush();const before=f.messages.length;f.context.run=runOf('new');answer.reject(Error('old request failed'));
 assert.equal((await result).ok,false);assert.equal(f.messages.length,before);assert.equal(f.context.run.items[0].status,'filled');
 console.log('PASS 旧重问的迟到异常不把新题标成失败');
}
{
 const f=fixture();f.context.run=runOf();const a=f.context.rerunOne(0,7),b=f.context.rerunOne(0,7);
 assert.equal((await a).ok,false);assert.equal((await b).ok,true);assert.equal(f.asks(),1);assert.equal(f.messages.filter(m=>m.type==='HW_ANSWER').length,1);
 console.log('PASS 连续点击重问只采用最新操作，不并发回填同一道题');
}
{
 const f=fixture();await f.context.startRun([{type:'choice'}],7,'page',false,'round-1');await flush();
 assert.equal(f.messages.find(m=>m.type==='HW_ANSWER').payload.requestId,'round-1');f.context.run.cancelled=true;
 console.log('PASS 正常答题回显面板发起轮次，迟到消息可按轮次丢弃');
}
{
 const f=fixture();f.context.run=runOf();f.context.run.requestId='old-round';
 assert.equal((await f.context.rerunOne(0,7,'retry-round')).ok,true);
 assert.equal(f.messages.find(m=>m.type==='HW_ANSWER').payload.requestId,'retry-round');
 console.log('PASS 重问回显本次请求轮次，不误用原答题轮次');
}
