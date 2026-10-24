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
const fixture = `<!doctype html><meta charset="utf-8"><style>.ProseMirror{min-height:50px}button{padding:8px}</style>
<button data-testid="create_conversation_button">新对话</button>
<div id="messages"><div data-testid="send_message">旧题</div><div data-testid="receive_message">旧答案 A</div></div>
<div data-testid="chat_input_input"><div class="ProseMirror" contenteditable="true"></div></div>
<button data-testid="chat_input_send_button" disabled>发送</button>
<script>
const editor=document.querySelector('.ProseMirror'),send=document.querySelector('[data-testid="chat_input_send_button"]'),messages=document.querySelector('#messages');
document.querySelector('[data-testid="create_conversation_button"]').onclick=()=>setTimeout(()=>{messages.textContent='';editor.textContent='';send.disabled=true;},150);
editor.addEventListener('input',()=>setTimeout(()=>{send.disabled=editor.textContent.includes('blocked')||!editor.textContent.trim();},40));
send.onclick=()=>{const prompt=editor.textContent;fetch('/attempt',{method:'POST',body:prompt});if(prompt.includes('lost'))return;fetch('/sent',{method:'POST',body:prompt});
const bubble=document.createElement('div');bubble.dataset.testid='send_message';bubble.textContent=prompt;messages.append(bubble);editor.textContent='';send.disabled=true;
setTimeout(()=>{const answer=document.createElement('div');answer.dataset.testid='receive_message';answer.innerHTML='<div data-testid="message_text_content">生成中</div>';messages.append(answer);setTimeout(()=>answer.firstElementChild.textContent='{"answers":["B"]}',180);},100);};
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
  fs.writeFileSync(engine, fs.readFileSync(engine, 'utf8').replace('https://www.doubao.com/chat/', origin + '/chat/').replace('*://*.doubao.com/*', 'http://127.0.0.1/*'));
  const client = path.join(stage, 'content/doubao/doubao-bridge.js');
  fs.writeFileSync(client, fs.readFileSync(client, 'utf8').replace('const sentDeadline = Date.now() + 30000;', 'const sentDeadline = Date.now() + 900;'));
} else {
  const client = path.join(stage, 'content/doubao/doubao-bridge.js');
  const code = fs.readFileSync(client, 'utf8');
  assert.equal(code.split('    clickSend();').length, 2, '真实页面检查必须在唯一发送动作之前终止');
  fs.writeFileSync(client, code.replace('    clickSend();', "    throw new Error('TAB_INPUT_VERIFIED_NO_SEND');"));
}
fs.writeFileSync(path.join(stage, 'background/test-worker.mjs'), `import {requestWithBridge} from './engines/bridge-engine.js';globalThis.bridgeAsk=prompt=>requestWithBridge([{role:'user',content:prompt}],{newChat:true});`);
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
    for (let i = 0; i < 20; i++) {
      state = await evaluate(worker, `chrome.tabs.sendMessage(${tab.id},{type:'BRIDGE_PING'},{frameId:0}).catch(()=>null)`);
      if (state?.ready && state?.hasSend) break;
      await wait(500);
    }
    if (state?.url) { const u = new URL(state.url); state.url = u.origin + u.pathname; }
    assert.deepEqual((await evaluate(worker, 'chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,url:x.url,active:x.active})))')).filter(t => t.id !== tab.id), before);
    console.log('PUBLIC PAGE (no login, no chat):', JSON.stringify(state));
    if (state?.ready && state?.hasSend) {
      const input = await evaluate(worker, `bridgeAsk('仅验证隔离编辑器输入，不提交聊天').then(()=>null,error=>error.message)`);
      console.log('PUBLIC INPUT (send disabled by test guard):', input);
      state.inputCheck = input;
      assert.equal(input, 'TAB_INPUT_VERIFIED_NO_SEND');
    }
    assert.ok(state?.ready && state?.hasSend, '真实豆包标签页尚未就绪');
    fs.writeFileSync(path.join(output, 'tabs-public-page-results.json'), JSON.stringify(state, null, 2));
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
  fs.writeFileSync(path.join(output, 'tabs-results.json'), JSON.stringify({ groups: 6, sendDelay, sent, tabs: afterReopen }, null, 2));
  }
} finally {
  worker?.close();
  try { await browser?.send('Browser.close'); } catch { /* 浏览器关闭时调试连接会断开 */ }
  browser?.close(); child.kill(); server.closeAllConnections(); server.close(); await wait(300);
  const rel = path.relative(output, folder); assert.ok(rel.startsWith('tabs-') && !rel.includes('..') && !path.isAbsolute(rel));
  try { fs.rmSync(folder, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }); } catch { console.warn('Test profile remains locked:', folder); }
}
