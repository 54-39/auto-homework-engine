/* 隔离 Edge 验证真实滚动、滚轮/键盘接管；只用本地课程与文档 fixture。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.tmp-reading-scroll-tests');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'edge-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const edge = process.env.EDGE_BIN || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const source = fs.readFileSync(process.env.WATCH_SOURCE || path.join(root, 'content/course/watch.js'), 'utf8')
  .replace('  HW.Watch = {', '  HW.Watch = { _readingTest: {readThrough, readDocFrame, documents: typeof readingDocuments === "function" ? readingDocuments : docs, setOn(v) {on=v;}},')
  .replace('if (DOC_FRAME.test(location.href)) {', 'if (false) {');
const viewer = '<!doctype html><meta charset="utf-8"><style>body{margin:0;overflow:hidden}.content{height:300px;overflow:auto;width:500px}aside{position:absolute;left:550px;top:0;height:250px;overflow:auto;width:120px}</style><div class="content" tabindex="0"><article style="height:30000px;display:flex;flex-direction:column;justify-content:space-between"><span>阅读正文</span><span>正文底部：已经快速滚到底</span></article></div><aside><div style="height:6000px">预览器目录</div></aside><button id="hidden" style="display:none">下一页</button><button id="disabled" disabled>下一页</button><button id="next">下一页</button>';
const card = viewer.replace('<button id="hidden"', '<span class="ans-job-icon"></span><button id="hidden"');
const course = '<!doctype html><meta charset="utf-8"><style>body{height:4000px}iframe{position:fixed;left:30px;top:80px;width:750px;height:420px}aside{position:fixed;left:850px;top:40px;height:400px;overflow:auto;width:180px}</style><h1>课程主页面</h1><iframe id="iframe" src="/knowledge/cards"></iframe><aside id="coursetree"><div style="height:9000px">章节目录</div></aside>';
const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(req.url.startsWith('/knowledge/cards') ? card : req.url.includes('/ananas/modules/pdf/') ? viewer : course); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
let ws;
try {
  let port;
  for (let i = 0; i < 150; i++) { const file = path.join(profile, 'DevToolsActivePort'); if (fs.existsSync(file)) { port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]); break; } await pause(100); }
  assert.ok(port, '隔离浏览器未启动');
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => { const m = JSON.parse(data), p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } };
  const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq, timer = setTimeout(() => reject(Error(method + ' timeout')), 45000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  await call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  const rows = [];
  const check = async (name, fn) => { try { await fn(); rows.push({ name, ok: true }); console.log('PASS', name); } catch (error) { rows.push({ name, ok: false, error: error.stack }); console.log('FAIL', name, error.message); } };
  async function setup(isViewer = false, queue = { paused: false }, automatic = false) {
    await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${isViewer ? 'ananas/modules/pdf/index.html' : 'mycourse/studentstudy'}` });
    await pause(160);
    const code = automatic ? source.replace('if (false) {', 'if (DOC_FRAME.test(location.href)) {') : source;
    await evaluate(`window.queue=${JSON.stringify(queue)};window.readRequests=0;window.queueChecks=0;window.readerListeners=[];window.chrome={runtime:{onMessage:{addListener:fn=>readerListeners.push(fn)},sendMessage:async message=>{if(message.type==='HW_WATCH_QUEUE_GET')queueChecks++;if(message.type==='HW_WATCH_READ_DOC')readRequests++;return{queue:window.queue};}}};${code}`);
    await evaluate(`window.reader=HW.Watch._readingTest;window.doc=${isViewer ? 'document' : 'document.getElementById("iframe").contentDocument'};window.box=doc.querySelector('.content');window.nextClicks=0;doc.getElementById('next').onclick=()=>{window.nextClicks++;doc.getElementById('next').disabled=true;};doc.getElementById('hidden').onclick=doc.getElementById('disabled').onclick=()=>{window.nextClicks+=100;};`);
  }
  await check('长阅读正文一次快速到底，课程主页面与目录栏保持位置', async () => {
    await setup();
    await evaluate(`document.scrollingElement.scrollTop=90;document.getElementById('coursetree').scrollTop=140;doc.querySelector('aside').scrollTop=100;window.wheelCount=0;document.addEventListener('wheel',()=>wheelCount++);doc.addEventListener('wheel',()=>wheelCount++);reader.setOn(true);window.readDone=reader.readThrough(10000).catch(()=>false);void 0;`);
    await pause(100);
    const p = await evaluate(`({top:box.scrollTop,bottom:box.scrollHeight-box.clientHeight,main:document.scrollingElement.scrollTop,catalog:document.getElementById('coursetree').scrollTop,viewerCatalog:doc.querySelector('aside').scrollTop,wheel:wheelCount})`);
    assert.equal(p.main, 90, '主页面被拉走'); assert.equal(p.catalog, 140, '章节目录被拉走'); assert.equal(p.viewerCatalog, 100, '文档目录被拉走'); assert.equal(p.wheel, 0, '仍有冒泡的模拟滚轮'); assert.equal(p.top, p.bottom, '仍在逐屏慢滚');
    fs.writeFileSync(path.join(output, 'course-reading.png'), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await evaluate('reader.setOn(false)');
  });
  await check('正文到达底部后仍等待站点回执，不伪报完成', async () => {
    await setup(); await evaluate(`reader.setOn(true);window.readDone=reader.readThrough(10000);void 0;`); await pause(100);
    assert.equal(await evaluate(`doc.querySelector('.ans-job-icon').parentElement.classList.contains('ans-job-finished')`), false);
    await evaluate(`doc.querySelector('.ans-job-icon').parentElement.classList.add('ans-job-finished')`);
    assert.equal(await evaluate('readDone'), true);
  });
  await check('顶层阅读遍历不接管预览器或测验框架', async () => {
    await setup();
    const urls = await evaluate(`(async()=>{for(const src of ['/ananas/modules/pdf/index.html','/ananas/modules/work/index.html']){const f=doc.createElement('iframe');f.src=src;doc.body.append(f);await new Promise(r=>f.onload=r);}return reader.documents().map(d=>d.URL);})()`);
    assert.equal(urls.length, 1); assert.ok(urls[0].includes('/knowledge/cards'));
  });
  await check('原生章节框架使用 srcdoc 时仍处理正文', async () => {
    await setup();
    await evaluate(`(async()=>{const frame=document.getElementById('iframe');await new Promise(r=>{frame.onload=r;frame.srcdoc=${JSON.stringify(card)};});window.doc=frame.contentDocument;window.box=doc.querySelector('.content');reader.setOn(true);window.readDone=reader.readThrough(10000).catch(()=>false);})()`);
    await pause(100); assert.equal(await evaluate('box.scrollTop'), await evaluate('box.scrollHeight-box.clientHeight'));
    await evaluate('reader.setOn(false)');
  });
  await check('文档框架快速到底后能翻下一页，隐藏及禁用按钮不点', async () => {
    await setup(true); await evaluate('window.readDone=reader.readDocFrame();void 0'); await pause(100);
    assert.equal(await evaluate('box.scrollTop'), await evaluate('box.scrollHeight-box.clientHeight'));
    await pause(1600); assert.equal(await evaluate('nextClicks'), 1, '到底后仍被错误判为一直移动');
    await evaluate('window.queue=null');
  });
  for (const input of ['wheel', 'keyboard', 'drag']) await check(`真实${input}接管后不再拉回底部或自动翻页`, async () => {
    await setup(true); await evaluate('window.readDone=reader.readDocFrame();void 0'); await pause(100);
    if (input === 'wheel') await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 180, y: 120, deltaX: 0, deltaY: -900 });
    if (input === 'keyboard') { await evaluate('box.focus()'); await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 }); await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 }); }
    if (input === 'drag') { await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 490, y: 120, button: 'left', clickCount: 1 }); await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 490, y: 120, button: 'left', clickCount: 1 }); await evaluate('box.scrollTop=500'); }
    await pause(400); const top = await evaluate('box.scrollTop'); assert.ok(top < await evaluate('box.scrollHeight-box.clientHeight'), '手动上翻没有生效');
    await pause(1600); assert.equal(await evaluate('box.scrollTop'), top, '手动上翻后被拉回底部'); assert.equal(await evaluate('nextClicks'), 0, '接管后仍自动翻页');
  });
  await check('未运行或人工暂停时不自动滚文档', async () => {
    for (const queue of [null, { paused: true }]) { await setup(true, queue); await evaluate('reader.readDocFrame()'); assert.equal(await evaluate('box.scrollTop'), 0); }
  });
  await check('新文档恢复自动阅读，迟到的正文仍可发现', async () => {
    await setup(true);
    await evaluate(`box.innerHTML='等待正文';window.readDone=reader.readDocFrame();void 0;`); await pause(100);
    await evaluate(`box.innerHTML='<article style="height:30000px">迟到的正文</article>'`); await pause(1600);
    assert.equal(await evaluate('box.scrollTop'), await evaluate('box.scrollHeight-box.clientHeight'));
    await evaluate('window.queue=null');
  });
  await check('没有任务角标的文档仍滚动正文并请求预览器，不提前算完成', async () => {
    await setup();
    await evaluate(`doc.querySelector('.ans-job-icon').remove();window.attachment=doc.createElement('div');attachment.className='ans-attach-ct';attachment.innerHTML='<iframe src="/ananas/modules/pdf/index.html" srcdoc="阅读附件" style="height:40px"></iframe>';doc.body.append(attachment);reader.setOn(true);window.readDone=reader.readThrough(10000);void 0;`);
    await pause(100);
    assert.equal(await evaluate('box.scrollTop'),await evaluate('box.scrollHeight-box.clientHeight'));
    assert.equal(await evaluate('readRequests'),1);
    await evaluate(`attachment.classList.add('ans-job-finished')`);
    assert.equal(await evaluate('readDone'),true);
  });
  for(const queue of [null,{paused:true}]) await check((queue?'暂停后恢复':'先打开文档后建队列')+'能接续自动阅读，重复通知不会重复启动', async()=>{
    await setup(true,queue,true);await pause(100);assert.equal(await evaluate('box.scrollTop'),0);
    await evaluate(`window.queue={paused:false};readerListeners.forEach(fn=>fn({type:'HW_WATCH_READ_DOC'},{},()=>{}))`);await pause(100);
    assert.equal(await evaluate('box.scrollTop'),await evaluate('box.scrollHeight-box.clientHeight'));
    const before=await evaluate('queueChecks');
    await evaluate(`for(let i=0;i<10;i++)readerListeners.forEach(fn=>fn({type:'HW_WATCH_READ_DOC'},{},()=>{}))`);await pause(100);
    assert.equal(await evaluate('queueChecks'),before,'重复通知启动了多个阅读循环');
  });
  fs.writeFileSync(path.join(output, process.env.WATCH_SOURCE ? 'baseline-results.json' : 'results.json'), JSON.stringify(rows, null, 2));
  assert.ok(rows.every(row => row.ok), '阅读滚动检查未全部通过');
  console.log(rows.length + ' reading browser groups passed (offline).');
  await call('Browser.close').catch(() => {});
} finally {
  ws?.close(); child.kill(); server.closeAllConnections(); server.close(); await pause(200);
  const relative = path.relative(output, profile); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); } catch {}
}
