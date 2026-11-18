import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),output=path.join(root,'.tmp-question-actions');
fs.mkdirSync(output,{recursive:true});const profile=fs.mkdtempSync(path.join(output,'edge-')),pause=ms=>new Promise(r=>setTimeout(r,ms));
const scripts=['adapters/chaoxing.js','dropdown.js','diagnostics.js','extractor.js','ai-extractor.js','question-images.js','filler.js','../course/watch.js','panel.js'].map(p=>fs.readFileSync(path.join(root,'content/homework',p),'utf8')).join('\n;\n');
function boot(){
 window.calls=[];window.starts=[];window.config={engine:'api',panelMode:'homework',api:{apiKey:'fixture'},subjMode:'rewrite',rewriteConfirm:false};window.listeners=[];window.acks=new Map();
 window.emit=m=>listeners.forEach(f=>f(m));
 window.chrome={runtime:{onMessage:{addListener:f=>listeners.push(f)},sendMessage:async m=>{
  calls.push(m);
  if(m.type==='GET_CONFIG')return{ok:true,config};
  if(m.type==='SET_CONFIG'){Object.assign(config,m.payload);return{ok:true,config};}
  if(m.type==='HW_WATCH_QUEUE_GET')return{ok:true,queue:null};
  if(m.type==='KEY_LIST')return{ok:true,list:[]};
  if(m.type==='HW_START'){
   starts.push(m.payload);
   const fallback=!!window.nextFallback;window.nextFallback=false;
   setTimeout(async()=>{
    if(window.holdNext){window.holdNext=false;await new Promise(r=>window.resumeQueue=r);}
    for(let i=0;i<m.payload.questions.length;i++){
     const q=m.payload.questions[i],token=String(i)+'-'+m.payload.requestId;
     emit({type:'HW_STATUS',payload:{index:i,status:'asking',requestId:m.payload.requestId}});
     const ack=new Promise(r=>acks.set(token,r));
     emit({type:'HW_ANSWER',payload:{index:i,answer:window.testAnswer||(config.engine==='bridge'?'豆包本题的完整测试答案':'本题的完整测试答案'),forceAsk:q._refresh===true,fillToken:token,requestId:m.payload.requestId,fallback,note:fallback?'AI 无法作答，猜选兜底（未确认）':undefined}});
     const result=await ack;if(!result.ok)return;
    }
    emit({type:'HW_DONE',payload:{total:m.payload.questions.length,filled:m.payload.questions.length,requestId:m.payload.requestId,guessedIndexes:fallback?[0]:[]}});
   },10);return{ok:true};
  }
  if(m.type==='HW_FILLED'){acks.get(m.payload.fillToken)?.(m.payload);return{ok:true};}
  return{ok:true};
 }},storage:{onChanged:{addListener(){}},local:{get:async()=>({}),set:async()=>{}}}};
}
async function auditChecks() {
 const ui=document.querySelector('#hw-panel-host').shadowRoot, results=[];
 if(ui.querySelector('.guessmodal').open)ui.querySelector('.guessmodal').close();
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async predicate=>{for(let i=0;i<120;i++){if(predicate())return;await wait(50);}throw Error('回归条件超时');};
 const ok=(condition,message)=>{if(!condition)throw Error(message);};
 const row=i=>ui.querySelectorAll('.item:not(.pending)')[i];
 const ask=async i=>{const before=starts.length;row(i).click();await until(()=>starts.length>before&&ui.querySelector('.stop').disabled);};
 config.engine='api';config.rewriteConfirm=true;
 const textarea=document.querySelector('#question6 textarea');textarea.value='';window.testAnswer='原有答案';
 await ask(5);window.testAnswer='新答案甲';
 await ask(5);ok(textarea.value==='原有答案','第一次重问覆盖了原答案');
 await ask(5);ok(textarea.value==='新答案甲','再次重问未采用已确认答案');
 window.testAnswer='新答案乙';await ask(5);ok(textarea.value==='新答案甲','变化的新答案未重新确认');
 textarea.value='用户重新修改';await ask(5);ok(textarea.value==='用户重新修改','用户修改后旧确认仍生效');
 await ask(5);ok(textarea.value==='新答案乙','重新确认后未填写');
 results.push('重问确认：首次保留、再次采用、新答案和手工修改重新确认');
 config.rewriteConfirm=false;window.testAnswer='本题的完整测试答案';
 await ask(7);ok(document.querySelector('#question8 textarea').value===testAnswer,'关闭确认后未正常填写');
 results.push('关闭重问确认后直接填写');
 const collect=HW.QuestionImages.collect, send=chrome.runtime.sendMessage;
 HW.QuestionImages.collect=async()=>['data:image/png;base64,AA=='];
 let received;
 chrome.runtime.sendMessage=async m=>{if(m.type==='HW_ANALYZE'){received=m.payload;return{ok:true,text:'带图解析成功'};}return send(m);};
 ui.querySelector('.abtn').click();await until(()=>ui.querySelector('.abtn').textContent==='解析本题');
 ok(received?.question._images?.length===1,'解析遗漏图片');ok(ui.querySelector('.aresult').textContent==='带图解析成功','解析未展示');
 HW.QuestionImages.collect=async()=>{throw Error('模拟图片读取失败');};received=null;
 ui.querySelector('.abtn').click();await until(()=>ui.querySelector('.abtn').textContent==='解析本题');
 ok(!received&&ui.querySelector('.aline').textContent.includes('模拟图片读取失败'),'图片失败仍发送解析');
 HW.QuestionImages.collect=collect;chrome.runtime.sendMessage=send;
 results.push('单题解析携带图片，读取失败不发送不完整题目');
 window.holdNext=true;row(8).click();await until(()=>!!window.resumeQueue);
 const beforeStop=calls.filter(m=>m.type==='HW_STOP').length;
 document.querySelector('#question9').outerHTML='<section class="questionLi" typename="简答题" id="question9"><h3 class="mark_name">9. 新页面的另一题</h3><textarea></textarea></section>';
 await until(()=>calls.filter(m=>m.type==='HW_STOP').length>beforeStop);
 resumeQueue();window.resumeQueue=null;await wait(350);
 ok(!document.querySelector('#question9 textarea').value,'迟到的旧答案写入了新题');
 ok(ui.querySelector('.stop').disabled,'换题后未停止旧队列');
 results.push('题目节点更换后停止旧队列，迟到答案不回填');
 ok(!window.uiErrors?.length,'页面发生未处理错误：'+(window.uiErrors||[]).join(';'));
 return results;
}
const questions=Array.from({length:52},(_,i)=>`<section class="questionLi" typename="简答题" id="question${i+1}"><h3 class="mark_name">${i+1}. 解释第${i+1}题</h3>${i>=48?'<iframe srcdoc="<body contenteditable=true></body>"></iframe>':'<textarea></textarea>'}</section>`).join('');
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><style>body{font:14px system-ui}textarea,iframe{width:300px;height:70px}section{margin-bottom:10px}</style><main>'+questions+'</main><script>('+boot.toString()+')();window.auditChecks='+auditChecks.toString()+';'+scripts+';HW.Panel.init();</script>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const child=spawn(process.env.EDGE_BIN||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
let ws,call;
try{
 let port;for(let i=0;i<150;i++){const p=path.join(profile,'DevToolsActivePort');if(fs.existsSync(p)){port=Number(fs.readFileSync(p,'utf8').split('\n')[0]);break;}await pause(100);}assert.ok(port);
 const tab=await(await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('http://127.0.0.1:'+server.address().port)}`,{method:'PUT'})).json();
 ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});let seq=0;const pending=new Map();
 ws.onmessage=({data})=>{const m=JSON.parse(data),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
 call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(Error(method+' timeout')),20000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
 const until=async expression=>{for(let i=0;i<150;i++){if(await evaluate(expression))return;await pause(50);}throw Error('Condition missing: '+expression);};
 await until('!!document.querySelector("#hw-panel-host")');
 await evaluate(`window.ui=document.querySelector('#hw-panel-host').shadowRoot;ui.querySelector('.fab').dispatchEvent(new MouseEvent('click',{detail:1,bubbles:true}));`);
 await until('HW.questions.length===52&&!ui.querySelector(".start").disabled');
 for(const engine of ['api','bridge']){
  await evaluate(`config.engine='${engine}';ui.querySelectorAll('.item:not(.pending)')[5].click()`);
  await until(`starts.length===${engine==='api'?1:2}&&ui.querySelector('.stop').disabled`);
  const state=await evaluate(`({stems:starts.at(-1).questions.map(q=>q.stem),first:document.querySelector('#question1 textarea').value,target:document.querySelector('#question6 textarea').value,row:ui.querySelectorAll('.item:not(.pending)')[5].querySelector('.st').textContent})`);
  assert.equal(state.stems.length,1);assert.ok(state.stems[0].includes('第6题'));assert.equal(state.first,'');assert.equal(state.target,engine==='bridge'?'豆包本题的完整测试答案':'本题的完整测试答案');assert.equal(state.row,'填入');
  console.log('PASS '+engine+' 未开始整页时单击第6题，只填写第6题且状态映射正确');
 }
 await evaluate(`config.engine='api';ui.querySelectorAll('.item:not(.pending)')[48].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);
 await until(`starts.length===3&&ui.querySelector('.stop').disabled`);
 const tail=await evaluate(`({stems:starts.at(-1).questions.map(q=>q.stem),values:[49,50,51,52].map(n=>document.querySelector('#question'+n+' iframe').contentDocument.body.textContent),acks:calls.filter(m=>m.type==='HW_FILLED').slice(-4).map(m=>m.payload.index)})`);
 assert.equal(tail.stems.length,4);assert.ok(tail.stems[0].includes('第49题'));assert.deepEqual(tail.acks,[0,1,2,3]);assert.ok(tail.values.every(v=>v==='本题的完整测试答案'));
 console.log('PASS 右键第49题连续完成49～52题富文本，不漏最后三题、不误改前面题目');
 await evaluate(`ui.querySelectorAll('.item:not(.pending)')[51].dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true}))`);
 await until(`starts.length===4&&ui.querySelector('.stop').disabled`);
 assert.equal(await evaluate('starts.at(-1).questions.length'),1);console.log('PASS Shift+Enter 从最后一题开始只处理最后一题');
 await evaluate(`window.holdNext=true;ui.querySelector('.start').click()`);
 await until('starts.length===5&&!!window.resumeQueue');
 await evaluate(`emit({type:'HW_DONE',payload:{total:1,filled:1,requestId:starts[0].requestId}})`);
 assert.equal(await evaluate(`ui.querySelector('.stop').disabled`),false);console.log('PASS 旧轮次完成消息不会提前停止新队列');
 await evaluate('resumeQueue();window.resumeQueue=null');await until(`ui.querySelector('.stop').disabled`);
 assert.equal(await evaluate('starts.at(-1).questions.length'),52);
 assert.equal(await evaluate(`calls.filter(m=>m.type==='HW_FILLED'&&m.payload.fillToken.endsWith('-'+starts.at(-1).requestId)).length`),52);
 assert.equal(await evaluate(`calls.some(m=>m.type==='HW_ISSUE_ADD')`),false);
 console.log('PASS 整页52题完成全部回执，经过第49题后继续到52题，无异常中断');
 await evaluate(`window.nextFallback=true;ui.querySelectorAll('.item:not(.pending)')[6].click()`);
 await until(`starts.length===6&&ui.querySelector('.stop').disabled&&ui.querySelector('.guessmodal').open`);
 assert.equal(await evaluate(`ui.querySelectorAll('.item:not(.pending)')[6].querySelector('.st').textContent`),'猜选');
 assert.match(await evaluate(`ui.querySelector('.guessbody').textContent`),/第 7 题/);
 assert.equal(await evaluate(`ui.activeElement===ui.querySelector('.guessmodal button')`),true);
 console.log('PASS 原答案与猜选相同时不声称正确，完成回执后弹窗提示页面第7题，按钮自动获得焦点');
 await evaluate(`ui.querySelector('.guessmodal button').click();document.querySelector('#question8 textarea').value='';window.nextFallback=true;ui.querySelectorAll('.item:not(.pending)')[7].click()`);
 await until(`starts.length===7&&ui.querySelector('.guessmodal').open`);
 assert.equal(await evaluate(`ui.querySelectorAll('.item:not(.pending)')[7].querySelector('.st').textContent`),'猜选');
 assert.match(await evaluate(`ui.querySelector('.guessbody').textContent`),/第 7、8 题/);
 console.log('PASS 兜底填写标记猜选，分次作答仍提醒本页尚未确认的第7、8题，弹窗可关闭');
 const auditResults=await evaluate('auditChecks()');
 for(const result of auditResults)console.log('PASS '+result);
 await evaluate(`ui.querySelector('.list').scrollTop=0;window.scrollTo(0,0)`);
 for(const width of [1280,420]){await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await pause(100);const shot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'questions-'+width+'.png'),Buffer.from(shot.data,'base64'));}
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({groups:8,tail},null,2));
}finally{
 if(ws?.readyState===WebSocket.OPEN)await call('Browser.close').catch(()=>{});ws?.close();child.kill();server.closeAllConnections();server.close();
}
