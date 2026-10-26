import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'), output=path.join(root,'.tmp-survey-tests');
fs.mkdirSync(output,{recursive:true});const profile=fs.mkdtempSync(path.join(output,'edge-'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const source=fs.readFileSync(process.env.SURVEY_SOURCE||path.join(root,'content/course/survey.js'),'utf8');
const sample='<div class="tip">手动结束</div><form>'+[1,2].map(n=>`<div class="question-item"><span class="topic-txt">题${n}：是否支持？</span><div class="optionRadio"><input type="radio" name="q${n}" value="A">支持</div><div class="optionRadio"><input type="radio" name="q${n}" value="B">不支持</div></div>`).join('')+'</form><a id="submitSuccess">提交</a><div class="maskDiv"><div class="popBottom"><a>确定</a></div></div>';
const html=process.env.SURVEY_FIXTURE?fs.readFileSync(process.env.SURVEY_FIXTURE,'utf8'):sample;
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'");res.end('<style>.maskDiv{display:none}.maskDiv.show{display:block}</style>'+html);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const child=spawn(process.env.EDGE_BIN||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
let ws,close;
try{
 let port;for(let i=0;i<150;i++){const f=path.join(profile,'DevToolsActivePort');if(fs.existsSync(f)){port=Number(fs.readFileSync(f,'utf8').split('\n')[0]);break;}await pause(100);}assert.ok(port,'隔离 Edge 未启动');
 const tab=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 let seq=0;const pending=new Map();ws.onmessage=({data})=>{const m=JSON.parse(data),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(Error(method+' timeout')),20000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 close=()=>call('Browser.close');const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
 const results=[];async function check(name,fn){await fn();results.push({name,ok:true});console.log('PASS',name);}
 async function setup({ended=false,active=true,filled=false,success=false,confirm=false,popupSuccess=false,unknown=false,stop=false}={}){
  await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/page/questionnaire/answerQuestionChapter?case=${Date.now()}`});await pause(100);
  await evaluate(`window.queueActive=${active};window.submitClicks=0;window.confirmClicks=0;window.listeners=[];window.chrome={runtime:{onMessage:{addListener:f=>listeners.push(f)},sendMessage:async()=>({ok:true,queue:queueActive?{paused:false}:null})}};
   for(const a of document.querySelectorAll('a'))a.removeAttribute('href');
   document.querySelector('.tip').textContent=${JSON.stringify(ended?'手动结束':'进行中')};
   for(const e of document.querySelectorAll('.maskDiv'))e.style.display='none';
   window.pop=document.createElement('div');pop.className='maskDiv';pop.innerHTML='<div class="popBottom"><a>确定</a></div>';document.body.append(pop);
   pop.querySelector('a').onclick=()=>{confirmClicks++;pop.style.display='none';${popupSuccess?'':"document.querySelector('.tip').textContent='提交成功';"}};
   window.submit=document.querySelector('#submitSuccess');submit.onclick=()=>{submitClicks++;${success?"document.querySelector('.tip').textContent='提交成功';":''}${popupSuccess?"pop.insertAdjacentHTML('afterbegin','<p>提交成功</p>');pop.style.display='block';":''}${confirm?"pop.style.display='block';":''}};
   ${unknown?"document.querySelector('.question-item').innerHTML='<textarea></textarea>';":''}
   for(const item of document.querySelectorAll('.question-item')){const input=item.querySelector('input[type="radio"]');if(input){input.disabled=false;${filled?'input.checked=true;':''}${stop?'input.onclick=()=>{queueActive=false;};':''}}}
   ${source}`);
  await evaluate('HW.Survey.run()');
 }
 await check('记录中的手动结束问卷立即识别，不点击提交',async()=>{await setup({ended:true});assert.equal(await evaluate('HW.Survey.last.state'),'expired');assert.equal(await evaluate('submitClicks'),0);});
 await check('活动问卷正常勾选并等待真实提交成功',async()=>{await setup({success:true});assert.equal(await evaluate('HW.Survey.last.state'),'submitted');assert.equal(await evaluate('submitClicks'),1);});
 await check('已有保存答案仍走提交，不因本轮零新增漏交',async()=>{await setup({filled:true,success:true});assert.equal(await evaluate('submitClicks'),1);assert.equal(await evaluate('HW.Survey.last.state'),'submitted');});
 await check('无回执不伪报提交成功，不重复点主提交按钮',async()=>{await setup();assert.equal(await evaluate('HW.Survey.last.state'),'pending');assert.equal(await evaluate('submitClicks'),1);});
 await check('确认仅点击站点弹窗按钮',async()=>{await setup({confirm:true});assert.equal(await evaluate('submitClicks'),1);assert.equal(await evaluate('confirmClicks'),1);assert.equal(await evaluate('HW.Survey.last.state'),'submitted');});
 await check('成功回执仅存在弹窗时，关闭弹窗后仍保留真实提交结果',async()=>{await setup({popupSuccess:true});assert.equal(await evaluate('confirmClicks'),1);assert.equal(await evaluate('HW.Survey.last.state'),'submitted');assert.equal(await evaluate("document.querySelector('.tip').textContent"),'进行中');});
 await check('无题干的未知输入题不能因空字符串被误认为已作答',async()=>{await setup({unknown:true});assert.equal(await evaluate('submitClicks'),0);assert.equal(await evaluate('HW.Survey.last.state'),'blocked');});
 await check('预加载问卷可在队列开始后重新启动，重复启动不重复交卷',async()=>{await setup({active:false,success:true});assert.equal(await evaluate('submitClicks'),0);await evaluate(`queueActive=true;listeners[0]({type:'HW_WATCH_SURVEY',payload:{start:true}}, {},()=>{});HW.Survey.run()`);assert.equal(await evaluate('submitClicks'),1);});
 await check('填写途中停止队列后不继续提交',async()=>{await setup({stop:true});assert.equal(await evaluate('submitClicks'),0);});
 await check('旧版误记已提交的缓存不再阻止正常提交',async()=>{await setup({active:false,success:true});await evaluate(`sessionStorage.setItem('hwSurveySubmitted',location.search);queueActive=true;HW.Survey.run()`);assert.equal(await evaluate('submitClicks'),1);});
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));console.log(results.length+' survey browser groups passed (offline).');
}finally{
 if(close&&ws?.readyState===WebSocket.OPEN)await close().catch(()=>{});ws?.close();child.kill();server.closeAllConnections();server.close();await pause(200);
 const rel=path.relative(output,profile);assert.ok(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:4,retryDelay:100});}catch{}
}
