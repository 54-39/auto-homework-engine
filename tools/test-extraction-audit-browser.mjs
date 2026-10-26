/* 只运行本地 DOM；覆盖提取去重、主观题回读和诊断脱敏的真实浏览器回归。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sourceRoot=process.env.EXTRACTION_SOURCE_ROOT?path.resolve(process.env.EXTRACTION_SOURCE_ROOT):root;
const output=path.join(root,'.tmp-extraction-audit-tests');fs.mkdirSync(output,{recursive:true});
const profile=fs.mkdtempSync(path.join(output,'edge-')),pause=ms=>new Promise(r=>setTimeout(r,ms));
const scripts=['extractor.js','filler.js','diagnostics.js'].map(name=>fs.readFileSync(path.join(sourceRoot,'content/homework',name),'utf8')).join('\n;\n');
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><main></main><script>window.chrome={runtime:{onMessage:{addListener(){}}}};'+scripts+'</script>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const child=spawn(process.env.EDGE_BIN||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
let ws,close;
try{
 let port;for(let i=0;i<150;i++){const f=path.join(profile,'DevToolsActivePort');if(fs.existsSync(f)){port=Number(fs.readFileSync(f,'utf8').split('\n')[0]);break;}await pause(100);}assert.ok(port,'隔离 Edge 未启动');
 const tab=await(await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://127.0.0.1:${server.address().port}/`)}`,{method:'PUT'})).json();
 ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 let seq=0;const pending=new Map();ws.onmessage=({data})=>{const m=JSON.parse(data),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(Error(method+' timeout')),15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 close=()=>call('Browser.close');const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
 for(let i=0;i<100&&!await evaluate('!!window.HW?.Filler');i++)await pause(30);
 const results=[];const check=async(name,fn)=>{try{await fn();results.push({name,ok:true});console.log('PASS',name);}catch(error){results.push({name,ok:false,error:error.message});console.log('FAIL',name,error.message);}};
 const setup=html=>evaluate(`document.querySelector('main').innerHTML=${JSON.stringify(html)}`);
 await check('同题干、同name的独立文本框不再被去重漏题',async()=>{
  await setup('<section class="question"><h3>请填写相同问题的答案</h3><input name="answer"></section><section class="question"><h3>请填写相同问题的答案</h3><input name="answer"></section>');
  assert.equal(await evaluate('HW.Extractor.extract().length'),2);
 });
 await check('题干前40字相同的独立题目仍全部提取',async()=>{
  const prefix='用于验证长题目公共开头的文字'.repeat(4);
  await setup([1,2].map(n=>`<section class="question"><h3>${prefix}第${n}问</h3><textarea name="answer"></textarea></section>`).join(''));
  assert.equal(await evaluate('HW.Extractor.extract().length'),2);
 });
 await check('相同题目内部嵌套标记不会重复提取同一答题框',async()=>{
  await setup('<section class="question"><div class="question"><h3>嵌套题目正文</h3><textarea></textarea></div></section>');assert.equal(await evaluate('HW.Extractor.extract().length'),1);
 });
 await check('问卷单个题干节点缺失不会让其余题目提取崩溃',async()=>{
  await evaluate(fs.readFileSync(path.join(sourceRoot,'content/homework/adapters/chaoxing.js'),'utf8'));
  await setup('<form id="answer_form"><div class="question-item"><textarea></textarea></div><div class="question-item"><span class="topic-txt">完整问卷题目</span><textarea></textarea></div></form>');
  const result=await evaluate(`HW.CXAdapter.extract().map(q=>q.meta.stem)`);assert.deepEqual(result,['完整问卷题目']);
 });
 await check('富文本fallback逐段写入且保留空行，不重复整篇答案',async()=>{
  await setup('<iframe srcdoc="<body contenteditable=true></body>"></iframe>');
  const result=await evaluate(`(async()=>{const f=document.querySelector('iframe');if(!f.contentDocument?.body)await new Promise(r=>f.onload=r);f.contentDocument.execCommand=()=>false;window.q={meta:{type:'subjective'},el:{inputs:[],labels:[],iframe:f}};const answer=${JSON.stringify('第一段 & <内容>\n\n第二段')};await HW.Filler.fill(q,answer);return{paragraphs:[...f.contentDocument.body.querySelectorAll('p')].map(p=>p.textContent),verified:HW.Filler.verify(q,answer)};})()`);
  assert.deepEqual(result.paragraphs,['第一段 & <内容>','','第二段']);assert.equal(result.verified,true);
 });
 await check('主观题旧答案非空但与新答案不同，不能假报填写成功',async()=>{
  await setup('<textarea>旧答案</textarea>');
  assert.equal(await evaluate(`HW.Filler.verify({meta:{type:'subjective'},el:{inputs:[document.querySelector('textarea')],labels:[]}},'新答案')`),false);
  assert.equal(await evaluate(`HW.Filler.verify({meta:{type:'subjective'},el:{inputs:[document.querySelector('textarea')],labels:[]}},'旧答案')`),true);
 });
 await check('富文本保留旧内容或被重复写入，也不能通过回读',async()=>{
  await setup('<iframe srcdoc="<body contenteditable=true>旧的编辑器正文</body>"></iframe>');
  assert.equal(await evaluate(`(async()=>{const f=document.querySelector('iframe');if(!f.contentDocument?.body)await new Promise(r=>f.onload=r);return HW.Filler.verify({meta:{type:'subjective'},el:{inputs:[],labels:[],iframe:f}},'完全不同的新答案');})()`),false);
 });
 await check('脱离DOM的旧题控件即使保留目标答案也回读失败',async()=>{
  await setup('<input value="正确答案">');
  assert.equal(await evaluate(`(()=>{const e=document.querySelector('main input'),q={meta:{type:'blank'},el:{inputs:[e],labels:[]}};e.remove();return HW.Filler.verify(q,'正确答案');})()`),false);
 });
 await check('隐藏data认证载体不进入诊断，判断题真值data仍保留',async()=>{
  await setup('<input type="hidden" id="markDataStr" data=\'{"token":"SYNTHETIC_AUTH_PAYLOAD_94"}\'><span class="num_option" data="true">对</span><div data="SYNTHETIC_OPAQUE_PAYLOAD_94">题目正文</div>');
  const result=await evaluate(`(()=>{const s=HW.Diagnostics.capture(),h=s.documents[0].html;return{auth:h.includes('SYNTHETIC_AUTH_PAYLOAD_94'),opaque:h.includes('SYNTHETIC_OPAQUE_PAYLOAD_94'),truth:h.includes('data="true"'),body:h.includes('题目正文')};})()`);
  assert.equal(result.auth,false);assert.equal(result.opaque,false);assert.equal(result.truth,true);assert.equal(result.body,true);
 });
 fs.writeFileSync(path.join(output,process.env.EXTRACTION_SOURCE_ROOT?'baseline-results.json':'results.json'),JSON.stringify(results,null,2));assert.ok(results.every(r=>r.ok),'提取/填写审查回归未全部通过');console.log(results.length+' extraction audit browser groups passed (offline).');
}finally{
 if(close&&ws?.readyState===WebSocket.OPEN)await close().catch(()=>{});ws?.close();child.kill();server.closeAllConnections();server.close();await pause(200);
 const rel=path.relative(output,profile);assert.ok(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:4,retryDelay:100});}catch{}
}
