/* 真正的 MV3 标签页桥接 + 内容脚本；默认使用本机固定样例。 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.tmp-doubao-tests');
fs.mkdirSync(output, { recursive: true });
const folder = fs.mkdtempSync(path.join(output, 'tabs-'));
const stage = path.join(folder, 'extension'), profile = path.join(folder, 'profile');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const sent = [];
const attempts = [];
const publicPage = process.argv.includes('--public-page');
const reuseChatCases = process.argv.includes('--reuse-chat-cases');
const switchChatCases = process.argv.includes('--conversation-switch-cases');
const collapsedMessageCases = process.argv.includes('--collapsed-message-cases');
const requestIdCases = process.argv.includes('--request-id-cases');
const answerRecoveryCases = process.argv.includes('--answer-recovery-cases');
const fixture = `<!doctype html><meta charset="utf-8"><style>.ProseMirror{min-height:50px}button{padding:8px}</style>
<button data-testid="create_conversation_button">新对话</button>
<div id="messages"><div data-testid="send_message">旧题</div><div data-testid="receive_message">旧答案 A</div></div>
<div data-testid="chat_input_input"><div id="chat-editor" class="ProseMirror" contenteditable="true"></div></div>
<button data-testid="chat_input_send_button" disabled>发送</button>
<script>
const editor=()=>document.querySelector('#chat-editor')||document.querySelector('.ProseMirror'),send=document.querySelector('[data-testid="chat_input_send_button"]'),messages=document.querySelector('#messages');
const inputText=()=>editor().tagName==='TEXTAREA'?editor().value:editor().textContent;
const clearInput=()=>{if(editor().tagName==='TEXTAREA')editor().value='';else editor().textContent='';};
document.querySelector('[data-testid="create_conversation_button"]').onclick=()=>{window.newChatClicks=(window.newChatClicks||0)+1;setTimeout(()=>{messages.textContent='';clearInput();send.disabled=true;},150);};
document.addEventListener('input',()=>setTimeout(()=>{send.disabled=inputText().includes('blocked')||!inputText().trim();},40));
send.onclick=()=>{const wirePrompt=inputText(),prompt=wirePrompt.replace(/^【请求编号：hw-[a-f0-9-]{36}，不要在答案中输出编号】\\s*/,'');fetch('/attempt',{method:'POST',body:prompt});if(prompt.includes('lost'))return;fetch('/sent',{method:'POST',body:prompt});
const bubble=document.createElement('div');bubble.dataset.testid='send_message';bubble.textContent=wirePrompt;messages.append(bubble);clearInput();send.disabled=true;
if(prompt.includes('collapsed-preview')||prompt.includes('inline-expand')){
 bubble.textContent='';const text=document.createElement('div');text.dataset.testid='message_text_content';bubble.append(text);
 const label=document.createElement('button');label.textContent='展开全部';
 if(prompt.includes('collapsed-preview')){text.textContent=wirePrompt.slice(0,110);bubble.append(label);}
 else{text.append(document.createTextNode(wirePrompt.slice(0,110)),label,document.createTextNode(wirePrompt.slice(110)));}
 label.onclick=()=>{document.body.dataset.expandClicks=String(Number(document.body.dataset.expandClicks||0)+1);text.textContent=wirePrompt;label.remove();};
}
if(prompt.includes('formatted-message')){bubble.textContent='';const head=document.createElement('div'),body=document.createElement('div');head.dataset.testid=body.dataset.testid='message_text_content';head.textContent=wirePrompt.match(/^【[^】]+】/)?.[0]||'';body.textContent=prompt.replaceAll('…','...').replaceAll('~','～');bubble.append(head,body);}
if(prompt.includes('switch-away')){setTimeout(()=>{messages.innerHTML='<div data-testid="send_message">其他对话的问题</div><div data-testid="receive_message">其他对话的答案</div>';},100);return;}
if(prompt.includes('transient-render')){setTimeout(()=>{const nodes=[...messages.childNodes];messages.replaceChildren();setTimeout(()=>messages.prepend(...nodes),400);},50);}
if(prompt.includes('reuse-second'))messages.prepend(messages.querySelector('[data-testid="receive_message"]').cloneNode(true));
const answerValue=prompt.includes('reuse-second')||(prompt.includes('formatted-message')&&messages.querySelectorAll('[data-testid="send_message"]').length>2)?'C':'B';
const answerPayload=prompt.includes('review-empty')?{answers:prompt.includes('唯一一次复核')&&!prompt.includes('review-empty-still')?['2.5']:[]}:{answers:[answerValue]};
setTimeout(()=>{const answer=document.createElement('div');answer.dataset.testid='receive_message';answer.innerHTML='<div data-testid="message_text_content">生成中</div>';messages.append(answer);setTimeout(()=>answer.firstElementChild.textContent=JSON.stringify(answerPayload),180);},prompt.includes('reuse-second')?2600:prompt.includes('transient-render')?800:100);};
</script>`;
const server = http.createServer(async (req, res) => {
  if (req.url === '/sent' || req.url === '/attempt') {
    let text = ''; for await (const chunk of req) text += chunk;
    (req.url === '/sent' ? sent : attempts).push({ prompt: text, at: Date.now() }); res.end('ok'); return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixture);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
for (const dir of ['background/engines', 'content/doubao']) fs.mkdirSync(path.join(stage, dir), { recursive: true });
for (const file of ['background/engines/engine.js', 'background/engines/bridge-engine.js', 'content/doubao/doubao-bridge.js'])
  fs.copyFileSync(path.join(root, file), path.join(stage, file));
if (!publicPage) {
  const engine = path.join(stage, 'background/engines/bridge-engine.js');
  fs.writeFileSync(engine, fs.readFileSync(engine, 'utf8').replace('https://www.doubao.com/chat/', origin + '/chat/').replaceAll('*://*.doubao.com/*', 'http://127.0.0.1/*'));
  const client = path.join(stage, 'content/doubao/doubao-bridge.js');
  fs.writeFileSync(client, fs.readFileSync(client, 'utf8').replace('const sentDeadline = Date.now() + 30000;', 'const sentDeadline = Date.now() + 900;'));
} else {
  const client = path.join(stage, 'content/doubao/doubao-bridge.js');
  const code = fs.readFileSync(client, 'utf8');
  assert.equal(code.split('    clickSend();').length, 2, '真实页面检查必须在唯一发送动作之前终止');
  fs.writeFileSync(client, code.replace('    clickSend();', "    throw new Error('TAB_INPUT_VERIFIED_NO_SEND');"));
}
fs.writeFileSync(path.join(stage, 'background/test-worker.mjs'), `import {requestWithBridge,answerWithBridge,openBridgeSplit,openBridgeView} from './engines/bridge-engine.js';globalThis.bridgeAsk=prompt=>requestWithBridge([{role:'user',content:prompt}],{newChat:true});globalThis.bridgeAnswer=q=>answerWithBridge(q);globalThis.bridgeSplit=tabId=>openBridgeSplit(tabId);globalThis.bridgeView=(tabId,viewMode)=>openBridgeView(tabId,{viewMode});`);
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: '豆包标签页桥接回归', version: '1.0.0',
  permissions: ['tabs', 'scripting'], host_permissions: [publicPage ? '*://*.doubao.com/*' : 'http://127.0.0.1/*'],
  background: { service_worker: 'background/test-worker.mjs', type: 'module' },
  content_scripts: [{ matches: [publicPage ? '*://*.doubao.com/*' : 'http://127.0.0.1/*'], js: ['content/doubao/doubao-bridge.js'] }],
}));

async function connect(url) {
  const socket = new WebSocket(url); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let seq = 0; const pending = new Map();
  socket.onmessage = ({ data }) => { const m = JSON.parse(data), p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); };
  return { close: () => socket.close(), send: (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timeout')); }, 45000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  }) };
}
async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
const child = spawn(process.env.EDGE_BIN || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-features=CalculateNativeWinOcclusion', '--enable-unsafe-extension-debugging', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore', windowsHide: true });
let browser, worker;
try {
  let port;
  for (let i = 0; i < 150; i++) { const file = path.join(profile, 'DevToolsActivePort');
    if (fs.existsSync(file)) { port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]); break; } await wait(100); }
  assert.ok(port, 'Edge DevTools unavailable');
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); browser = await connect(version.webSocketDebuggerUrl);
  const loaded = await browser.send('Extensions.loadUnpacked', { path: stage }); assert.ok(loaded.id);
  let target;
  for (let i = 0; i < 100; i++) { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
    .find(t => t.type === 'service_worker' && t.url.includes(loaded.id)); if (target) break; await wait(100); }
  assert.ok(target, 'Extension worker missing'); worker = await connect(target.webSocketDebuggerUrl);
  await worker.send('Runtime.enable');
  for (let i = 0; i < 100 && !(await evaluate(worker, 'typeof chrome!=="undefined" && typeof bridgeAsk==="function"')); i++) await wait(50);
  const before = await evaluate(worker, 'chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,url:x.url,active:x.active})))');
  if (publicPage) {
    const tab = await evaluate(worker, `chrome.tabs.create({url:'https://www.doubao.com/chat/',active:false})`);
    let state;
    for (let i = 0; i < 60; i++) {
      state = await evaluate(worker, `chrome.tabs.sendMessage(${tab.id},{type:'BRIDGE_PING'},{frameId:0}).catch(()=>null)`);
      if (state?.ready && state?.hasSend) break;
      await wait(500);
    }
    if (state?.url) { const u = new URL(state.url); state.url = u.origin + u.pathname; }
    assert.deepEqual((await evaluate(worker, 'chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,url:x.url,active:x.active})))')).filter(t => t.id !== tab.id), before);
    console.log('PUBLIC PAGE (no login, no chat):', JSON.stringify(state));
    const controls=await evaluate(worker,`chrome.scripting.executeScript({target:{tabId:${tab.id}},func:()=>[...document.querySelectorAll('button,[role="button"],a,[data-testid="create_conversation_button"]')].filter(e=>/新对话|新聊天|create_conversation/.test((e.innerText||'')+' '+(e.getAttribute('data-testid')||''))).map(e=>({tag:e.tagName,testid:e.getAttribute('data-testid'),label:e.getAttribute('aria-label'),text:(e.innerText||'').slice(0,60),visible:e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0})).slice(0,12)}).then(r=>r[0].result)`);
    console.log('PUBLIC NEW CHAT CONTROLS:',JSON.stringify(controls));
    const editors=await evaluate(worker,`chrome.scripting.executeScript({target:{tabId:${tab.id}},func:()=>[...document.querySelectorAll('[data-testid="chat_input_input"],textarea,.ProseMirror,[contenteditable="true"]')].map(e=>({tag:e.tagName,testid:e.getAttribute('data-testid'),class:e.className,editable:e.getAttribute('contenteditable'),role:e.getAttribute('role'),placeholder:e.getAttribute('placeholder'),readonly:e.readOnly,disabled:e.disabled,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,visibility:getComputedStyle(e).visibility,display:getComputedStyle(e).display})).slice(0,12)}).then(r=>r[0].result)`);
    console.log('PUBLIC EDITORS:',JSON.stringify(editors));
    state = await evaluate(worker, `chrome.tabs.sendMessage(${tab.id},{type:'BRIDGE_PING'},{frameId:0}).catch(()=>null)`);
    if (state?.url) { const u = new URL(state.url); state.url = u.origin + u.pathname; }
    if (state?.ready && state?.hasSend) {
      const input = await evaluate(worker, `bridgeAsk('仅验证隔离编辑器输入，不提交聊天').then(()=>null,error=>error.message)`);
      console.log('PUBLIC INPUT (send disabled by test guard):', input);
      state.inputCheck = input;
      assert.equal(input, 'TAB_INPUT_VERIFIED_NO_SEND');
    }
    assert.ok(state?.ready && state?.hasSend, '真实豆包标签页尚未就绪');
    fs.writeFileSync(path.join(output, 'tabs-public-page-results.json'), JSON.stringify(state, null, 2));
  } else if(answerRecoveryCases) {
    const q={type:'choice',stem:'review-empty：设 X 服从泊松分布且 P(X=1)=0.2，参数为何？',options:['1.5','2','2.5','3'].map((text,i)=>({key:'ABCD'[i],text}))};
    assert.equal((await evaluate(worker,`bridgeAnswer(${JSON.stringify(q)})`)).answer,'C');
    assert.equal(sent.length,2);assert.ok(sent[1].prompt.includes('合理近似'));
    console.log('PASS 真实扩展首轮空答案后复核一次，收到新回复后匹配 C');
    q.stem='review-empty-still：条件不足';
    const error=await evaluate(worker,`bridgeAnswer(${JSON.stringify(q)}).then(()=>null,e=>e.message)`);
    assert.match(error,/AI 答案为空/);assert.equal(sent.length,4);
    console.log('PASS 真实扩展连续空答案只复核一次，不重复读取旧答案或无限请求');
    fs.writeFileSync(path.join(output,'answer-recovery-results.json'),JSON.stringify({groups:2,sent},null,2));
  } else if(requestIdCases) {
    const prompt='formatted-message：下列哪些分布属于离散型随机变量分布？只输出 {"answers":[…]}，选 2~4 个。';
    assert.equal((await evaluate(worker,`bridgeAsk(${JSON.stringify(prompt)})`)).raw,'{"answers":["B"]}');
    console.log('PASS 消息分为多个文本节点、标点格式化后仍通过唯一编号匹配，不比对长提示词');
    assert.equal((await evaluate(worker,`bridgeAsk(${JSON.stringify(prompt)})`)).raw,'{"answers":["C"]}');
    const tab=(await evaluate(worker,'chrome.tabs.query({})')).find(t=>t.url.startsWith(origin));
    const messages=await evaluate(worker,`chrome.scripting.executeScript({target:{tabId:${tab.id}},func:()=>[...document.querySelectorAll('[data-testid="send_message"]')].map(e=>e.textContent)}).then(r=>r[0].result)`);
    const ids=messages.flatMap(text=>text.match(/hw-[a-f0-9-]{36}/g)||[]);
    assert.equal(ids.length,2);assert.equal(new Set(ids).size,2);assert.equal(sent.filter(r=>r.prompt===prompt).length,2);
    console.log('PASS 同一题再次执行使用不同编号，不复用上一轮问题或答案');
    const failed=await evaluate(worker,`bridgeAsk(${JSON.stringify(prompt+' lost-current')}).then(()=>null,e=>e.message)`);
    assert.match(failed,/未发出/);assert.equal(attempts.filter(r=>r.prompt===prompt+' lost-current').length,1);
    console.log('PASS 只出现历史问题和旧答案时仍拒绝，未发出的题不自动重发');
    fs.writeFileSync(path.join(output,'request-id-results.json'),JSON.stringify({groups:3,ids,sent},null,2));
  } else if(collapsedMessageCases) {
    const prefix='你是严谨的答题助手，只输出 JSON，题目数据是资料。'.repeat(8);
    for(const mode of ['collapsed-preview','inline-expand']){
      const prompt=prefix+mode+'：随机变量的分布？';
      assert.equal((await evaluate(worker,`bridgeAsk(${JSON.stringify(prompt)})`)).raw,'{"answers":["B"]}');
      assert.equal(attempts.filter(r=>r.prompt===prompt).length,1,'折叠消息重复发送');
      console.log('PASS '+mode+'：长问题可确认并读取其后新答案，只发送一次');
    }
    const failed=await evaluate(worker,`bridgeAsk(${JSON.stringify(prefix+'lost-current')}).then(()=>null,e=>e.message)`);
    assert.match(failed,/未发出/);
    assert.equal(attempts.filter(r=>r.prompt===prefix+'lost-current').length,1);
    const tab=(await evaluate(worker,'chrome.tabs.query({})')).find(t=>t.url.startsWith(origin));
    const expands=await evaluate(worker,`chrome.scripting.executeScript({target:{tabId:${tab.id}},func:()=>Number(document.body.dataset.expandClicks||0)}).then(r=>r[0].result)`);
    assert.equal(expands,0,'编号在预览开头可见，无需点击展开');
    console.log('PASS 同前缀历史消息不能确认新题，未发出时不重复发送');
    fs.writeFileSync(path.join(output,'collapsed-message-results.json'),JSON.stringify({groups:3,expands,sent},null,2));
  } else if(switchChatCases) {
    const started=Date.now(),error=await evaluate(worker,'bridgeAsk("switch-away").then(()=>null,e=>e.message)');
    assert.match(error,/对话已切换/);assert.ok(Date.now()-started<12000,'切换对话后仍长时间等待');
    assert.equal(attempts.filter(r=>r.prompt==='switch-away').length,1);assert.equal(sent.filter(r=>r.prompt==='switch-away').length,1);
    console.log('PASS 切换对话后及时暂停，不读取其他对话答案、不重复发题');
    assert.equal((await evaluate(worker,'bridgeAsk("resume-after-switch")')).raw,'{"answers":["B"]}');
    console.log('PASS 切换后再次开始可继续，桥接不残留忙碌锁');
    assert.equal((await evaluate(worker,'bridgeAsk("transient-render")')).raw,'{"answers":["B"]}');
    console.log('PASS 短暂 DOM 重绘不误报切换对话');
    fs.writeFileSync(path.join(output,'conversation-switch-results.json'),JSON.stringify({groups:3,error,sent},null,2));
  } else if(reuseChatCases) {
    assert.equal((await evaluate(worker,'bridgeAsk("first-real-question")')).raw,'{"answers":["B"]}');
    const bridgeTab=(await evaluate(worker,'chrome.tabs.query({})')).find(t=>t.url.startsWith(origin));
    assert.equal((await evaluate(worker,'bridgeAsk("reuse-second")')).raw,'{"answers":["C"]}');
    console.log('PASS 同一对话第二题读取新答案 C，忽略重新挂载的历史答案 A');
    const prefix='同样的答题提示词，请只输出本题 JSON。'.repeat(7);
    assert.equal((await evaluate(worker,`bridgeAsk(${JSON.stringify(prefix+'上一题')})`)).raw,'{"answers":["B"]}');
    const failed=await evaluate(worker,`bridgeAsk(${JSON.stringify(prefix+'lost-current')}).then(()=>null,e=>e.message)`);
    assert.match(failed,/未发出/);assert.equal(attempts.filter(r=>r.prompt===prefix+'lost-current').length,1);
    console.log('PASS 提示词前缀相同也不误把旧问题当成本次发送成功，不重发');
    for(const mode of ['hidden-button','hidden-editor','hidden-history','native-textarea','native-next-question']){
      await evaluate(worker,`chrome.scripting.executeScript({target:{tabId:${bridgeTab.id}},func:mode=>{
        document.getElementById('decoy')?.remove();
        if(mode==='hidden-button'){
          const b=document.createElement('button');b.id='decoy';b.dataset.testid='create_conversation_button';b.style.display='none';b.textContent='新对话';document.body.prepend(b);
        } else if(mode==='hidden-editor'){
          const z=document.createElement('div');z.id='decoy';z.dataset.testid='chat_input_input';z.style.display='none';z.innerHTML='<div class="ProseMirror" contenteditable="true">旧草稿</div>';document.body.prepend(z);
        } else if(mode==='hidden-history'){
          const d=document.createElement('div');d.id='decoy';d.style.display='none';d.innerHTML='<div data-testid="send_message">旧题</div><div data-testid="receive_message">旧答案</div>';document.body.prepend(d);
        } else if(mode==='native-textarea'){
          const t=document.createElement('textarea');t.id='chat-editor';t.dataset.testid='chat_input_input';t.placeholder='发消息...';
          document.querySelector('[data-testid="chat_input_input"]').replaceWith(t);
        }
      },args:[${JSON.stringify(mode)}]})`);
      const count=sent.length;
      assert.equal((await evaluate(worker,`bridgeAsk(${JSON.stringify(mode)})`)).raw,'{"answers":["B"]}');
      assert.equal(sent.length,count+1,'每题只能发送一次');
      console.log('PASS 沿用对话场景 '+mode+'：连续非缓存请求正常取答');
    }
    const state=await evaluate(worker,`chrome.scripting.executeScript({target:{tabId:${bridgeTab.id}},func:()=>({newChatClicks:window.newChatClicks||0,hasOriginalHistory:[...document.querySelectorAll('[data-testid="receive_message"]')].some(e=>e.textContent==='旧答案 A')})}).then(r=>r[0].result)`);
    assert.equal(state.newChatClicks,0);assert.equal(state.hasOriginalHistory,true);
    console.log('PASS 旧配置 newChat:true 也不点击新对话，原历史完整保留');
    fs.writeFileSync(path.join(output,'reuse-chat-results.json'),JSON.stringify({groups:8,sent,state},null,2));
  } else {
  const first = await evaluate(worker, 'bridgeAsk("first")');
  assert.equal(first.raw, '{"answers":["B"]}'); assert.equal(sent.length, 1);
  const afterFirst = await evaluate(worker, 'chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,url:x.url,active:x.active})))');
  const bridgeTab = afterFirst.find(t => t.url.startsWith(origin));
  assert.ok(bridgeTab && !bridgeTab.active);
  assert.equal(afterFirst.length, before.length + 1);
  assert.deepEqual(afterFirst.filter(t => t.id !== bridgeTab.id), before);
  console.log('PASS 无豆包页时新开后台标签页，可取回完整答案且不串旧题');
  const begin = Date.now();
  const second = await evaluate(worker, 'bridgeAsk("second")');
  assert.equal(second.raw, '{"answers":["B"]}'); assert.equal(sent.length, 2);
  const sendDelay = sent[1].at - begin;
  assert.deepEqual(await evaluate(worker, 'chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,url:x.url,active:x.active})))'), afterFirst);
  console.log('PASS 连续请求复用已有标签页，不抢焦点；模拟发送准备耗时 ' + sendDelay + 'ms');
  const failure = await evaluate(worker, 'bridgeAsk("blocked").then(()=>null,e=>e.message)');
  assert.match(failure, /发送按钮不可用/); assert.equal(sent.length, 2, '失败时重复发送了问题');
  assert.deepEqual(await evaluate(worker, 'chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,url:x.url,active:x.active})))'), afterFirst);
  console.log('PASS 输入不可发送时返回错误，不自动开网页或重发');
  assert.equal((await evaluate(worker, 'bridgeAsk("resume")')).raw, '{"answers":["B"]}');
  assert.equal(sent.length, 3);
  assert.deepEqual(await evaluate(worker, 'chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,url:x.url,active:x.active})))'), afterFirst);
  console.log('PASS 用户处理问题后再次启动，继续复用原豆包标签页');
  const missing = await evaluate(worker, 'bridgeAsk("lost").then(()=>null,e=>e.message)');
  assert.match(missing, /未发出/);
  assert.equal(attempts.filter(item => item.prompt === 'lost').length, 1, '消息未确认发出时发生自动重发');
  assert.equal(sent.length, 3);
  console.log('PASS 消息气泡未出现时只发送一次，暂停后交给用户处理');
  await evaluate(worker, `chrome.tabs.remove(${bridgeTab.id})`);
  assert.equal((await evaluate(worker, 'bridgeAsk("reopened")')).raw, '{"answers":["B"]}');
  const afterReopen = await evaluate(worker, 'chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,url:x.url,active:x.active})))');
  assert.equal(afterReopen.length, afterFirst.length);
  assert.ok(afterReopen.some(t => t.id !== bridgeTab.id && t.url.startsWith(origin) && !t.active));
  assert.equal(sent.length, 4);
  console.log('PASS 用户关闭豆包页后，下次请求能重新打开并正常取答');
  let split = null, groups = 6;
  if (await evaluate(worker, "typeof chrome.tabs.createSplit === 'function'")) {
    const leftId = before[0].id;
    split = await evaluate(worker, `bridgeSplit(${leftId})`);
    assert.equal(split.reused, true);
    const pair = await evaluate(worker, `Promise.all([chrome.tabs.get(${leftId}),chrome.tabs.get(${split.tabId})]).then(t=>t.map(x=>({id:x.id,splitViewId:x.splitViewId,index:x.index})))`);
    assert.ok(pair[0].splitViewId >= 0); assert.equal(pair[0].splitViewId, pair[1].splitViewId);
    assert.equal(pair[1].index, pair[0].index + 1); assert.equal(sent.length, 4);
    console.log('PASS 真实 Edge 原生分屏复用现有豆包页，左右两页共用 splitViewId，不发题');
    assert.equal((await evaluate(worker, 'bridgeAsk("split-view")')).raw, '{"answers":["B"]}');
    assert.equal(sent.length, 5);
    assert.equal((await evaluate(worker, `bridgeSplit(${leftId})`)).tabId, split.tabId);
    assert.equal((await evaluate(worker, 'chrome.tabs.query({})')).length, afterReopen.length);
    console.log('PASS 原生分屏内继续取答，重复点击复用分屏且不新增标签');
    groups += 2;
  } else console.log('SKIP 当前浏览器没有原生分屏 API，兼容提示由专项单元测试覆盖');
  const view=await evaluate(worker, `bridgeView(${before[0].id},'window')`);
  const windowTab=await evaluate(worker,`chrome.tabs.get(${view.tabId})`);
  assert.notEqual(windowTab.windowId,(await evaluate(worker,`chrome.tabs.get(${before[0].id})`)).windowId);
  assert.ok(!(windowTab.splitViewId>=0));
  assert.equal((await evaluate(worker,`bridgeView(${before[0].id},'window')`)).tabId,view.tabId);
  console.log('PASS 真实 Edge 新窗口模式退出豆包分屏，并复用原网页');groups++;
  const notice=async(text,close=true)=>evaluate(worker,`chrome.scripting.executeScript({target:{tabId:${view.tabId}},func:(text,close)=>{
    const d=document.createElement('div');d.id='test-notice';d.setAttribute('role','dialog');d.style.cssText='position:fixed;inset:20px;background:white;z-index:999';
    d.textContent=text;
    if(close){const b=document.createElement('button');b.setAttribute('aria-label','关闭');b.textContent='×';b.onclick=()=>{window.noticeClosed=(window.noticeClosed||0)+1;d.remove();};d.append(b);}
    document.body.append(d);
  },args:${JSON.stringify([text,close])}})`);
  const noticeState=()=>evaluate(worker,`chrome.scripting.executeScript({target:{tabId:${view.tabId}},func:()=>({open:!!document.getElementById('test-notice'),closed:window.noticeClosed||0})}).then(r=>r[0].result)`);
  for(const text of ['豆包功能更新，试试新功能','登录解锁更多功能，手机号登录，获取验证码']){
    await notice(text);const count=sent.length;
    assert.equal((await evaluate(worker,'bridgeAsk("dismiss-notice")')).raw,'{"answers":["B"]}');
    assert.equal(sent.length,count+1);assert.equal((await noticeState()).open,false);
  }
  console.log('PASS 更新弹窗和可关闭的登录邀请自动点叉，连续题正常完成且不重复发送');groups++;
  for(const [text,close,pattern] of [['请完成安全验证，拖动滑块',true,/安全验证/],['请登录后继续',false,/需要登录/]]){
    await notice(text,close);const count=sent.length,closed=(await noticeState()).closed;
    const error=await evaluate(worker,'bridgeAsk("real-attention").then(()=>null,e=>e.message)');
    assert.match(error,pattern);assert.equal(sent.length,count);assert.deepEqual(await noticeState(),{open:true,closed});
    await evaluate(worker,`chrome.scripting.executeScript({target:{tabId:${view.tabId}},func:()=>document.getElementById('test-notice').remove()})`);
  }
  assert.equal((await evaluate(worker,'bridgeAsk("after-attention-cleared")')).raw,'{"answers":["B"]}');
  console.log('PASS 真实验证和强制登录不点叉、不发题，解除后无需重启即可恢复');groups++;
  fs.writeFileSync(path.join(output, 'tabs-results.json'), JSON.stringify({ groups, sendDelay, sent, tabs: afterReopen, split, view }, null, 2));
  }
} finally {
  worker?.close();
  try { await browser?.send('Browser.close'); } catch { /* 浏览器关闭时调试连接会断开 */ }
  browser?.close(); child.kill(); server.closeAllConnections(); server.close(); await wait(300);
  const rel = path.relative(output, folder); assert.ok(rel.startsWith('tabs-') && !rel.includes('..') && !path.isAbsolute(rel));
  try { fs.rmSync(folder, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }); } catch { console.warn('Test profile remains locked:', folder); }
}
