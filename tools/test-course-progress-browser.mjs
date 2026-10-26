import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),output=path.join(root,'.tmp-course-progress-tests');
fs.mkdirSync(output,{recursive:true});const profile=fs.mkdtempSync(path.join(output,'edge-')),pause=ms=>new Promise(r=>setTimeout(r,ms));
const scripts=['adapters/chaoxing.js','dropdown.js','diagnostics.js','extractor.js','ai-extractor.js','filler.js','../course/watch.js','panel.js'].map(p=>fs.readFileSync(path.join(root,'content/homework',p),'utf8')).join('\n;\n');
const boot=`window.progress={a:0,b:2,c:null};window.queue=null;window.currentKey='1|2';localStorage.setItem('hwApiOpen','0');
window.chrome={runtime:{onMessage:{addListener(){}},sendMessage:async m=>m.type==='GET_CONFIG'?{ok:true,config:{engine:'api',panelMode:'watch',api:{apiKey:''},watchSections:0}}:m.type==='HW_WATCH_QUEUE_GET'?{ok:true,queue}:m.type==='HW_WATCH_COURSES'?{ok:true,courses:[]}:{ok:true}},storage:{onChanged:{addListener(){}},local:{get:async()=>({}),set:async()=>{}}}};`;
const setup=`HW.Watch={...HW.Watch,currentCourse:()=>({key:currentKey}),nodes:()=>Object.keys(progress).map(id=>({id,name:'章节'+id})),unfinishedOf:id=>progress[id],resumeQueued:async()=>false,pageKind:()=> 'study',observeProgress:async()=>{}};HW.Panel.init();`;
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><style>body{font:14px system-ui;background:#f8fafc}</style><main><h1>课程进度验证</h1></main><script>'+boot+scripts+'\n;'+setup+'</script>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const child=spawn(process.env.EDGE_BIN||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
let ws,close;
try{
 let port;for(let i=0;i<150;i++){const f=path.join(profile,'DevToolsActivePort');if(fs.existsSync(f)){port=Number(fs.readFileSync(f,'utf8').split('\n')[0]);break;}await pause(100);}assert.ok(port,'隔离 Edge 未启动');
 const tab=await(await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://127.0.0.1:${server.address().port}/`)}`,{method:'PUT'})).json();ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 let seq=0;const pending=new Map();ws.onmessage=({data})=>{const m=JSON.parse(data),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(Error(method+' timeout')),15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 close=()=>call('Browser.close');const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
 for(let i=0;i<100&&!await evaluate('!!document.querySelector("#hw-panel-host")');i++)await pause(30);
 await evaluate(`window.ui=document.querySelector('#hw-panel-host').shadowRoot;ui.querySelector('.fab').dispatchEvent(new MouseEvent('click',{detail:1,bubbles:true}));`);await pause(150);
 const results=[];const check=async(name,fn)=>{await fn();results.push({name,ok:true});console.log('PASS',name);};
 await check('实际面板显示部分已确认进度，并标注未知章节',async()=>{
  assert.equal(await evaluate(`ui.querySelector('.wpvalue').textContent`),'至少 33% · 1/3 节');
  assert.ok((await evaluate(`ui.querySelector('.watchmeta').textContent`)).includes('1 节状态待核对'));
  assert.equal(await evaluate(`ui.querySelector('.wptrack').getAttribute('aria-valuenow')`),'33');
 });
 await check('未填Key时折叠API抽屉仍有DeepSeek入口',async()=>{
  assert.equal(await evaluate(`ui.querySelector('.apisec').getBoundingClientRect().height`),0);
  assert.ok(await evaluate(`ui.querySelector('.keywarn').getBoundingClientRect().height>0`));
  assert.equal(await evaluate(`ui.querySelector('.keywarn a').href`),'https://platform.deepseek.com/api_keys');
 });
 await check('桌面和窄窗口进度文字、蓝色渐变与日志区均不裁切',async()=>{
  for(const width of [1280,420]){
   await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await pause(120);
   const geometry=await evaluate(`(()=>{const p=ui.querySelector('.panel').getBoundingClientRect(),v=ui.querySelector('.wpvalue').getBoundingClientRect(),track=ui.querySelector('.wptrack').getBoundingClientRect();return{inside:v.left>=p.left&&v.right<=p.right&&track.bottom<=p.bottom,overflow:ui.querySelector('.panel').scrollWidth>ui.querySelector('.panel').clientWidth};})()`);
   assert.equal(geometry.inside,true);assert.equal(geometry.overflow,false);
   const shot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,`partial-${width}.png`),Buffer.from(shot.data,'base64'));
  }
 });
 await check('迟到的章节状态自动刷新，无需折叠面板或刷新网页',async()=>{
  await evaluate('progress={a:0,b:0,c:0}');await pause(3300);
  assert.equal(await evaluate(`ui.querySelector('.wpvalue').textContent`),'100% · 3/3 节');
 });
 await check('全部未知保留同一门课程上次进度，其他课程不能冒用',async()=>{
  await evaluate(`progress={a:null,b:null};queue={index:0,courses:[{key:'1|2',done:4,total:10}]};document.dispatchEvent(new Event('visibilitychange'));`);await pause(100);
  assert.equal(await evaluate(`ui.querySelector('.wpvalue').textContent`),'40% · 4/10 任务点（上次读取）');
  await evaluate(`queue.courses[0].key='3|4';document.dispatchEvent(new Event('visibilitychange'));`);await pause(100);
  assert.equal(await evaluate(`ui.querySelector('.wpvalue').textContent`),'暂未读取到进度');
  assert.equal(await evaluate(`ui.querySelector('.wptrack').getAttribute('aria-valuenow')`),null);
 });
 await check('豆包面板移除单独分屏按钮，保留开始入口且宽窄布局无溢出',async()=>{
  await evaluate(`ui.querySelector('.modeslot button').click();`);
  await evaluate(`ui.querySelector('.ddlist [data-id="bridge"]').click();`);await pause(100);
  assert.equal(await evaluate(`!!ui.querySelector('.bridgesplit,.bridgebar')`),false);
  assert.equal(await evaluate(`ui.querySelector('.panel').classList.contains('bridgemode')`),true);
  assert.equal(await evaluate(`ui.querySelector('.start').getBoundingClientRect().height>0`),true);
  for(const width of [1280,420]){
   await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await pause(100);
   assert.equal(await evaluate(`(()=>{const p=ui.querySelector('.panel');return p.scrollWidth>p.clientWidth;})()`),false);
   const shot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,`bridge-${width}.png`),Buffer.from(shot.data,'base64'));
  }
 });
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));console.log(results.length+' course progress browser groups passed (offline).');
}finally{
 if(close&&ws?.readyState===WebSocket.OPEN)await close().catch(()=>{});ws?.close();child.kill();server.closeAllConnections();server.close();await pause(200);
 const rel=path.relative(output,profile);assert.ok(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:4,retryDelay:100});}catch{}
}
