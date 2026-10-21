/* 在独立 Edge 配置里先打开页面再加载真正的 MV3 扩展；页面请求全部本地回放。 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'.tmp-extension-startup');fs.mkdirSync(output,{recursive:true});
const edge=process.env.EDGE_BIN||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function connect(url,onEvent=()=>{}) {
  const ws=new WebSocket(url);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let seq=0;const pending=new Map();
  ws.onmessage=({data})=>{const m=JSON.parse(data);if(m.method)onEvent(m);const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
  return {close:()=>ws.close(),send:(method,params={})=>new Promise((resolve,reject)=>{
    const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'));},20000);
    pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));
  })};
}
async function evaluate(cdp,expression) {
  const r=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
  return r.result.value;
}
async function until(cdp,expression) {
  for(let i=0;i<100;i++){if(await evaluate(cdp,expression))return;await pause(100);}
  throw Error('Condition not reached: '+expression);
}
const results=[];
for(const variant of ['baseline','fixed']) {
  const folder=fs.mkdtempSync(path.join(output,variant+'-')),stage=path.join(folder,'extension'),profile=path.join(folder,'profile');
  fs.mkdirSync(stage);for(const dir of ['_locales','background','content','icons','options'])fs.cpSync(path.join(root,dir),path.join(stage,dir),{recursive:true});
  for(const file of ['manifest.json','settings.html','settings.js'])fs.copyFileSync(path.join(root,file),path.join(stage,file));
  if(variant==='baseline') {
    const file=path.join(stage,'background/service-worker.js');
    let source=fs.readFileSync(file,'utf8');
    for(const event of ['onInstalled','onStartup']) {
      const listener=`chrome.runtime.${event}?.addListener(() => injectOpenHomeworkTabs().catch(() => {}));`;
      assert.ok(source.includes(listener));source=source.replace(listener,'');
    }
    fs.writeFileSync(file,source);
  }
  const child=spawn(edge,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking',
    '--disable-crash-reporter','--disable-breakpad','--enable-unsafe-extension-debugging','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
  let browser,page,worker;
  try {
    let port;
    for(let i=0;i<150;i++){const file=path.join(profile,'DevToolsActivePort');if(fs.existsSync(file)){port=Number(fs.readFileSync(file,'utf8').split('\n')[0]);break;}if(child.exitCode!==null)throw Error('Edge exited');await pause(100);}
    assert.ok(port,'Edge DevTools unavailable');
    const version=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();browser=await connect(version.webSocketDebuggerUrl);
    const tab=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();
    const fixture='<!doctype html><meta charset="utf-8"><title>安装前已打开的学习通知</title><main><h2>学习通知</h2><label><input type="checkbox">未完成</label><label><input type="checkbox">已完成作业</label><p>请点击作业入口查看题目。</p></main>';
    page=await connect(tab.webSocketDebuggerUrl,m=>{if(m.method==='Fetch.requestPaused')page.send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'}],body:Buffer.from(fixture).toString('base64')}).catch(()=>{});});
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await page.send('Fetch.enable',{patterns:[{urlPattern:'*'}]});
    await page.send('Page.navigate',{url:'https://mooc1.chaoxing.com/codex-extension-startup'});
    await until(page,'document.title === "安装前已打开的学习通知"');
    const loaded=await browser.send('Extensions.loadUnpacked',{path:stage});assert.ok(loaded.id,'Extension ID missing');
    if(variant==='baseline') {
      await pause(2200);assert.equal(await evaluate(page,'!!document.querySelector("#hw-panel-host")'),false);
      await page.send('Page.reload');await until(page,'!!document.querySelector("#hw-panel-host")?.shadowRoot?.querySelector(".fab")');
      results.push({variant,oldTabBeforeRefresh:false,afterRefresh:true});
      console.log('PASS reproduced: old extension has no ball in pre-opened tab until refresh');
    } else {
      await until(page,'!!document.querySelector("#hw-panel-host")?.shadowRoot?.querySelector(".fab")');
      const point=await evaluate(page,'(()=>{const r=document.querySelector("#hw-panel-host").shadowRoot.querySelector(".fab").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()');
      await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
      await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
      const state=await evaluate(page,'(()=>{const s=document.querySelector("#hw-panel-host").shadowRoot;return{visible:!s.querySelector(".panel").classList.contains("hidden"),pending:s.querySelectorAll(".pending").length,summary:s.querySelector(".smsg").textContent};})()');
      assert.deepEqual(state,{visible:true,pending:0,summary:'未检测出题目'});
      const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      worker=await connect(targets.find(t=>t.type==='service_worker'&&t.url.includes(loaded.id)).webSocketDebuggerUrl);
      const duplicate=await evaluate(worker,`(async()=>{
        const m=chrome.runtime.getManifest().content_scripts[0];
        const tabs=await chrome.tabs.query({url:m.matches});
        await chrome.scripting.executeScript({target:{tabId:tabs[0].id},files:m.js});
        return (await chrome.scripting.executeScript({target:{tabId:tabs[0].id},func:()=>({hosts:document.querySelectorAll('#hw-panel-host').length,runHomework:typeof HW.Panel.runHomework})}))[0].result;
      })()`);
      assert.deepEqual(duplicate,{hosts:1,runHomework:'function'});
      await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});
      const shot=await page.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'installed-open-tab.png'),Buffer.from(shot.data,'base64'));
      results.push({variant,...state,duplicate});console.log('PASS real MV3 install: ball appears without refreshing, click opens, repeated injection stays usable');
    }
  } finally {
    worker?.close();page?.close();browser?.close();child.kill();await pause(400);
    const relative=path.relative(output,folder);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
    try{fs.rmSync(folder,{recursive:true,force:true,maxRetries:4,retryDelay:150});}catch{console.warn('Temporary Edge profile still locked:',folder);}
  }
}
fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));
