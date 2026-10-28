/* 被动回放用户导出的作业 DOM；不执行导出页脚本，不访问超星或 AI 服务。 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),output=path.join(root,'.tmp-formula-encoding');
fs.mkdirSync(output,{recursive:true});const profile=fs.mkdtempSync(path.join(output,'edge-')),pause=ms=>new Promise(r=>setTimeout(r,ms));
const sourceFile=process.env.FORMULA_SOURCE_HTML;
const scripts=['adapters/chaoxing.js','dropdown.js','diagnostics.js','extractor.js','ai-extractor.js','filler.js','../course/watch.js','panel.js'].map(p=>fs.readFileSync(path.join(root,'content/homework',p),'utf8')).join('\n;\n');
function boot(){
 window.calls=[];window.listeners=[];window.modelPages=[];
 window.chrome={runtime:{onMessage:{addListener:f=>listeners.push(f)},sendMessage:async m=>{
  calls.push(m.type);
  if(m.type==='GET_CONFIG')return{ok:true,config:{engine:'api',api:{apiKey:'fixture'},subjMode:'rewrite'}};
  if(m.type==='KEY_LIST')return{ok:true,list:[]};
  if(m.type==='HW_WATCH_QUEUE_GET')return{ok:true,queue:null};
  if(m.type==='HW_DETECT_QUESTIONS'){
   modelPages.push(...m.payload.batches);
   const snap=HW.AIDetection.collect();
   return{ok:true,questions:makeItems(snap)};
  }
  return{ok:true};
 }},storage:{onChanged:{addListener(){}},local:{get:async()=>({}),set:async()=>{}}}};
 window.makeItems=snap=>HW.Extractor.extract().map(q=>{
  const labels=(q.el.labels||[]).filter(l=>snap.ids.has(l.input||l.clickEl));
  const fields=q.el.fields?.length?q.el.fields:q.el.iframes?.length?q.el.iframes:q.el.iframe?[q.el.iframe]:q.el.inputs||[];
  const target=labels[0]?.input||labels[0]?.clickEl||fields[0],container=HW.AIDetection.questionRoot(target);
  return{...q.meta,containerId:snap.ids.get(container),options:labels.map(l=>({key:l.key,targetId:snap.ids.get(l.input||l.clickEl)})),inputIds:labels.length?[]:fields.map(el=>snap.ids.get(el))};
 });
}
const server=http.createServer((req,res)=>{
 if(req.url==='/source'){res.setHeader('Content-Type','text/plain; charset=utf-8');res.end(sourceFile?fs.readFileSync(sourceFile):'');return;}
 res.setHeader('Content-Type','text/html; charset=utf-8');
 res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-src 'self' about:; connect-src 'self'");
 res.end('<!doctype html><meta charset="utf-8"><style>body{font:14px system-ui}img{min-width:22px;min-height:18px}textarea,iframe{width:250px;height:60px}</style><main></main><script>('+boot.toString()+')();'+scripts+'</script>');
});
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
 await until('!!window.makeItems');
 if(sourceFile){
  await evaluate(`(async()=>{const d=new DOMParser().parseFromString(await(await fetch('/source')).text(),'text/html');
   d.querySelectorAll('script,style,link,meta,base,object,embed,nav,header,footer,#hw-panel-host').forEach(e=>e.remove());
   for(const e of d.querySelectorAll('*'))for(const a of [...e.attributes])if(/^on/i.test(a.name)||['action','formaction','href'].includes(a.name))e.removeAttribute(a.name);
   for(const img of d.querySelectorAll('img')){img.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';img.removeAttribute('srcset');}
   // 导出器将编辑器 iframe 展开成 data-iframe 容器；仅恢复空白可编辑宿主，不执行原地址。
   for(const e of d.querySelectorAll('[data-iframe]')){const f=d.createElement('iframe');f.srcdoc='<body contenteditable="true"></body>';e.replaceWith(f);}
   for(const f of d.querySelectorAll('iframe')){f.removeAttribute('src');f.srcdoc='<body contenteditable="true"></body>';}
   document.querySelector('main').replaceChildren(...d.body.childNodes);
  })()`);await pause(300);
 } else {
  await evaluate(`document.querySelector('main').innerHTML='<section class="questionLi" typename="填空题" id="question1"><h3 class="mark_name">求 <img class="ans-latex-moudle" data="%22%u03BB%3D%22"> 的值</h3><textarea></textarea></section>'`);
 }
 const initial=await evaluate(`(()=>{const s=HW.AIDetection.collect(),b=HW.AIDetection.bind(s,makeItems(s));return{total:makeItems(s).length,ready:b.questions.map(q=>q.meta.stem),pending:b.pending.map(q=>({stem:q.stem,reason:q.reason})),pages:s.batches.join(' ')};})()`);
 console.log(JSON.stringify({total:initial.total,ready:initial.ready.length,pending:initial.pending}));
 assert.equal(initial.pending.length,0,'公式编码导致题目仍被标成图片不可读');
 assert.ok(initial.pages.includes('λ='));
 if(sourceFile){assert.ok(initial.pages.includes('x∈[1,2)'));assert.ok(initial.pages.includes('(k=0,1,…,5)'));}
 console.log('PASS 原生读取与绑定恢复完整公式，不再因旧式编码漏题');
 await evaluate('HW.Panel.init();window.ui=document.querySelector("#hw-panel-host").shadowRoot');
 await until('!!HW.questions?.length&&!ui.querySelector(".detect").disabled');
 assert.equal(await evaluate('HW.questions.length'),initial.total);assert.equal(await evaluate('ui.querySelectorAll(".pending").length'),0);
 await evaluate('ui.querySelector(".detect").click()');await until('modelPages.length>0&&!ui.querySelector(".detect").disabled');
 assert.equal(await evaluate('HW.questions.length'),initial.total);assert.equal(await evaluate('ui.querySelectorAll(".pending").length'),0);
 const pages=await evaluate('modelPages.join(" ")');assert.ok(pages.includes('λ='));if(sourceFile)assert.ok(pages.includes('x∈[1,2)'));
 console.log('PASS AI识题输入包含完整公式，固定模型结构返回后仍全部绑定成功');
 const bad=await evaluate(`(()=>{const img=document.createElement('img');img.className='ans-latex-moudle';img.setAttribute('data','%zzbroken');return HW.AIDetection.imageText(img);})()`);assert.equal(bad,'');
 console.log('PASS 真正损坏的公式元数据不伪造内容');
 const variants=await evaluate(`(()=>{const read=(cls,data)=>{const i=document.createElement('img');i.className=cls;i.setAttribute('data',data);return HW.AIDetection.imageText(i);};return[
  read('ans-latex-moudle',encodeURIComponent(JSON.stringify('λ∈[1,2)'))),
  read('ans-latex-moudle','%22x%U2208%5B1%2C2%29%22'),
  read('ans-edrawmath-moudle','%22%3Cmath%3E%3Cmi%3E%u03BB%3C%2Fmi%3E%3Cmo%3E%u2208%3C%2Fmo%3E%3C%2Fmath%3E%22'),
  read('ans-latex-moudle',encodeURIComponent(JSON.stringify('literal %u2208')))
 ];})()`);
 assert.deepEqual(variants,['$λ∈[1,2)$','$x∈[1,2)$','λ∈','$literal %u2208$']);
 console.log('PASS 标准UTF-8、旧Unicode、MathML及字面百分号编码兼容');
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({groups:4,total:initial.total,ready:initial.ready.length,pending:initial.pending,source:sourceFile?'user-export':'fixture'},null,2));
}finally{
 if(ws?.readyState===WebSocket.OPEN)await call('Browser.close').catch(()=>{});ws?.close();child.kill();server.closeAllConnections();server.close();
}
