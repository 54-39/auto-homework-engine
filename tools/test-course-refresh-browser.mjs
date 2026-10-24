/* 真 MV3 扩展：模拟旧页面内层读取器丢失，不靠整页 F5 恢复课程清单。 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=process.env.EXTENSION_ROOT||project;
const output=path.join(project,process.env.EXTENSION_ROOT?'.tmp-course-refresh-baseline':'.tmp-course-refresh-tests');
fs.mkdirSync(output,{recursive:true});const folder=fs.mkdtempSync(path.join(output,'run-'));
const stage=path.join(folder,'extension'),profile=path.join(folder,'profile');fs.mkdirSync(stage);
for(const name of ['_locales','background','content','icons','options'])fs.cpSync(path.join(source,name),path.join(stage,name),{recursive:true});
for(const name of ['manifest.json','settings.html','settings.js'])fs.copyFileSync(path.join(source,name),path.join(stage,name));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function connect(url,onEvent=()=>{}){
  const ws=new WebSocket(url);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});let seq=0;const pending=new Map();
  ws.onmessage=({data})=>{const m=JSON.parse(data);if(m.method)onEvent(m);const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
  return{close:()=>ws.close(),send:(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'));},20000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));})};
}
async function evaluate(cdp,expression){const r=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
async function until(cdp,expression){for(let i=0;i<120;i++){if(await evaluate(cdp,expression))return;await pause(50);}throw Error('课程刷新未达到预期：'+expression);}
const edge=process.env.EDGE_BIN||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const child=spawn(edge,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--enable-unsafe-extension-debugging','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
let browser,page,worker;
try{
  let port;for(let i=0;i<150;i++){const file=path.join(profile,'DevToolsActivePort');if(fs.existsSync(file)){port=Number(fs.readFileSync(file,'utf8').split('\n')[0]);break;}await pause(100);}assert.ok(port,'Edge未启动');
  const version=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();browser=await connect(version.webSocketDebuggerUrl);
  const tab=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();
  page=await connect(tab.webSocketDebuggerUrl,event=>{
    if(event.method!=='Fetch.requestPaused')return;
    const inside=new URL(event.params.request.url).pathname==='/course-frame';
    const html=inside?'<html><body>课程容器</body></html>':'<!doctype html><meta charset="utf-8"><title>个人空间课程清单回放</title><h1>我学的课</h1><iframe id="courseFrame" src="/course-frame" style="width:800px;height:600px;border:0"></iframe>';
    page.send('Fetch.fulfillRequest',{requestId:event.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'}],body:Buffer.from(html).toString('base64')}).catch(()=>{});
  });
  await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await page.send('Fetch.enable',{patterns:[{urlPattern:'*'}]});
  await page.send('Page.navigate',{url:'https://i.chaoxing.com/base?ws=1&t=1792814483878'});
  await until(page,'document.title === "个人空间课程清单回放" && document.querySelector("iframe")?.contentDocument?.readyState === "complete"');
  const extension=await browser.send('Extensions.loadUnpacked',{path:stage});
  await until(page,'!!document.querySelector("#hw-panel-host")?.shadowRoot');
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  worker=await connect(targets.find(t=>t.type==='service_worker'&&t.url.includes(extension.id)).webSocketDebuggerUrl);
  await evaluate(worker,'chrome.storage.local.set({config:{engine:"api",panelMode:"watch",watchSections:0,api:{apiKey:""}}})');
  for(let i=0;i<100;i++){
    const ready=await evaluate(worker,'(async()=>{const [tab]=await chrome.tabs.query({url:"https://i.chaoxing.com/*"});return (await chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:true},func:()=>({child:window.top!==window,reader:typeof globalThis.HW?.Watch?.courseLinks})})).some(f=>f.result.child&&f.result.reader==="function");})()');
    if(ready)break;if(i===99)throw Error('初始内层读取脚本未加载');await pause(50);
  }
  console.log('PASS 已打开页面安装扩展时，主页面与内层课程框架均补上脚本，无需 F5');
  const cards='<div class="course"><a href="https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=801&clazzid=901&cpi=101">课程一</a><p>任务点进度: 0/3</p></div><div class="course"><a href="https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=802&clazzid=901&cpi=102">课程二</a><p>任务点进度: 1/4</p></div>';
  await evaluate(worker,`(async()=>{const [tab]=await chrome.tabs.query({url:'https://i.chaoxing.com/*'});await chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:true},args:[${JSON.stringify(cards)}],func:html=>{globalThis.__refreshMarker='原有页面';if(window.top!==window){document.body.innerHTML=html;delete globalThis.HW.Watch;}}});})()`);
  const empty=await evaluate(worker,"(async()=>{const [tab]=await chrome.tabs.query({url:'https://i.chaoxing.com/*'});return(await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},func:()=>chrome.runtime.sendMessage({type:'HW_WATCH_COURSES',payload:{}})}))[0].result;})()");
  assert.equal(empty.ok,true);assert.equal(empty.courses.length,0);
  console.log('PASS 复现：课程卡片可见但内层读取器缺失，仅查已有对象返回空清单');
  await evaluate(page,'document.querySelector("#hw-panel-host").shadowRoot.querySelector(".panel").classList.remove("hidden")');
  await until(page,'!document.querySelector("#hw-panel-host").shadowRoot.querySelector(".watchview").classList.contains("hidden")');
  async function clickRefresh(){
    const point=await evaluate(page,'(()=>{const r=document.querySelector("#hw-panel-host").shadowRoot.querySelector(".courserefresh").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()');
    await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
    await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
    await until(page,'document.querySelector("#hw-panel-host").shadowRoot.querySelectorAll(".crow[data-i]").length===2');
  }
  await clickRefresh();
  const frames=await evaluate(worker,"(async()=>{const [tab]=await chrome.tabs.query({url:'https://i.chaoxing.com/*'});return await chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:true},func:()=>({marker:globalThis.__refreshMarker,child:window.top!==window,reader:typeof globalThis.HW?.Watch?.courseLinks})});})()");
  assert.ok(frames.every(f=>f.result.marker==='原有页面'));assert.ok(frames.some(f=>f.result.child&&f.result.reader==='function'));
  console.log('PASS 手动刷新补回真实内层脚本并读出两门课程，主页面和内层均未重新加载');
  await evaluate(page,'document.querySelector("#hw-panel-host").shadowRoot.querySelector(".crow[data-i] input").click()');
  await pause(3200);
  assert.ok(await evaluate(page,'document.querySelector("#hw-panel-host").shadowRoot.querySelector(".crow[data-i] input").checked'));
  console.log('PASS 自动轮询后课程仍保留，已有勾选不丢失');
  await evaluate(page,'history.replaceState(null,"","/base?ws=1&t=1792814489999")');await clickRefresh();
  assert.ok(await evaluate(page,'document.querySelector("#hw-panel-host").shadowRoot.querySelector(".crow[data-i] input").checked'));
  console.log('PASS 时间参数变化后仍可刷新课程，保留勾选');
  const shot=await page.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'refreshed.png'),Buffer.from(shot.data,'base64'));
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({groups:5,frames:frames.map(f=>({frameId:f.frameId,...f.result}))},null,2));
}finally{
  worker?.close();page?.close();try{await browser?.send('Browser.close');}catch{}browser?.close();child.kill();await pause(200);
  const relative=path.relative(output,folder);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
  try{fs.rmSync(folder,{recursive:true,force:true,maxRetries:4,retryDelay:150});}catch{}
}
