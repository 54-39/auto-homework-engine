import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.tmp-settings-tests');
const profile = fs.mkdtempSync(path.join(output, 'chrome-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture() {
  window.testCalls = [];
  window.testConfig = { engine: 'api', subjMode: 'ask', verify2: true, api: { iface: 'openai', apiKey: 'fixture-old-3eb1', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }, bridge: { delayMin: 3000, delayMax: 8000, newChat: true } };
  window.testKeys = [{ id: 'old', key: 'fixture-old-3eb1', iface: 'openai', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', savedAt: Date.now() }, { id: 'other', key: 'fixture-other-4abc', iface: 'anthropic', baseURL: 'https://ark.cn-beijing.volces.com/api/coding', model: 'doubao-seed-code', savedAt: Date.now() }];
  if (location.search.includes('empty')) { testKeys = []; testConfig.api = { iface: 'auto', baseURL: '', model: '', apiKey: '' }; }
  const merge = (target, value) => { for (const [k,v] of Object.entries(value)) { if (v && typeof v === 'object' && !Array.isArray(v)) merge(target[k] ||= {}, v); else target[k] = v; } return target; };
  window.chrome = { runtime: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', getManifest: () => ({ version: '0.9.13' }), sendMessage: async ({ type, payload }) => {
    testCalls.push({ type, payload: structuredClone(payload) });
    if (window.testFailure === type) return { ok: false, error: '模拟失败，请重试' };
    if (type === 'GET_CONFIG') return { ok: true, config: structuredClone(testConfig) };
    if (type === 'KEY_LIST') return { ok: true, list: structuredClone(testKeys) };
    if (type === 'SET_CONFIG') { merge(testConfig, payload); return { ok: true, config: structuredClone(testConfig) }; }
    if (type === 'KEY_SAVE') {
      const api = { apiKey: payload.key, iface: 'openai', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };
      testKeys = [{ id: 'new', key: payload.key, ...api, savedAt: Date.now() }, ...testKeys.filter(r => r.key !== payload.key)];
      merge(testConfig, { api }); return { ok: true, detected: api, list: structuredClone(testKeys) };
    }
    if (type === 'KEY_USE') { const r = testKeys.find(r => r.id === payload.id); merge(testConfig, { api: { apiKey: r.key, iface: r.iface, baseURL: r.baseURL, model: r.model } }); return { ok: true }; }
    if (type === 'KEY_REMOVE') { testKeys = testKeys.filter(r => r.id !== payload.id); if (testConfig.api.apiKey === payload.key) testConfig.api.apiKey = ''; return { ok: true }; }
    if (type === 'CACHE_CLEAR') return { ok: true, count: 0 };
    if (type === 'HW_ISSUE_LIST') return { ok: true, issues: [{stage:'刷课跳过',message:'测试失败',course:'课程甲',chapter:'第一节',task:'第二页签',action:'跳过并继续，未计完成',stack:'Error: 测试失败',details:'测试上下文',sceneSummary:{status:'captured',documents:3,unreadable:1,truncated:true},at:new Date().toISOString(),version:'0.9.14'}], total: 1, offset: 0 };
    if (type === 'TEST_API') return { ok: true, reply: '测试通过' };
    return { ok: true };
  } }, permissions: { contains: async () => !window.testDenyPermission, request: async () => !window.testDenyPermission }, storage: { onChanged: { addListener() {} } } };
}
async function checks() {
  const $ = id => document.getElementById(id), results = [];
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async fn => { for (let i=0;i<100;i++) { if (fn()) return; await wait(10); } throw new Error('等待界面超时'); };
  const ok = (v, msg = 'assertion failed') => { if (!v) throw new Error(msg); };
  const check = async (name, fn) => { try { await fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: e.message }); } };
  const click = async id => { $(id).click(); await wait(30); };
  const select = (id, value) => { $(id).value = value; $(id).dispatchEvent(new Event('change')); };
  await until(() => !$('appFields').disabled);
  await check('设置下拉复用面板样式，键盘切换、单弹层与焦点可用', async () => {
    for (const id of ['engine','subjMode','provider','watchSections']) {
      ok($(id).hidden && $(id+'-trigger'), '原生下拉未替换：'+id);
      ok(document.querySelector('label[for="'+id+'-trigger"]'), '标签未关联：'+id);
    }
    const trigger = $('engine-trigger');
    trigger.focus();
    for(const key of ['ArrowDown','ArrowDown','Enter']) trigger.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}));
    ok($('engine').value==='bridge' && !$('bridgeFields').hidden && $('apiFields').hidden);
    select('engine','api');
    ok(trigger.textContent.includes('API'));
    $('subjMode-trigger').click();trigger.click();
    ok(document.querySelectorAll('body>.ddlist:not(.hidden)').length===1);
    trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    ok(!document.querySelector('body>.ddlist:not(.hidden)'));
  });
  await check('Key胶囊框聚焦时标签上浮，输入后保持浮起', async () => {
    const input=$('apiKey'),label=document.querySelector('label[for="apiKey"]');
    input.value='';input.blur();await wait(220);
    const before=label.getBoundingClientRect().top;
    input.focus();await wait(220);
    ok(label.getBoundingClientRect().top<before && label.getBoundingClientRect().bottom<=input.getBoundingClientRect().top+1);
    ok(getComputedStyle(input).boxShadow === 'none' && getComputedStyle(input).outlineStyle === 'none', 'Key聚焦不能增加外框或光晕');
    ok(parseFloat(getComputedStyle(input).borderTopLeftRadius)>=input.clientHeight/2, '两端没有形成圆弧');
    input.value='fixture';input.blur();await wait(220);
    ok(label.getBoundingClientRect().bottom<=input.getBoundingClientRect().top+1);
    input.value='';
  });
  await check('默认进入应用设置，所有已保存Key仅显示尾号', () => {
    ok(location.hash === '#app' && !$('sec-app').hidden && $('sec-mem').hidden);
    ok($('savedKeys').children.length === 2 && $('apiKey').value === '');
    ok($('keyStatus').textContent.includes('3eb1') && !document.body.innerText.includes('fixture-old-3eb1'));
  });
  await check('诊断展示跳过任务的课程、章节、处理结果、堆栈和上下文', async () => {
    document.querySelector('[data-sec="diag"]').click();await wait(30);
    const text=$('issueList').textContent;
    for(const value of ['课程甲','第一节','第二页签','跳过并继续','Error: 测试失败','测试上下文','已附 3 个','1 个无法读取','已截断']) ok(text.includes(value),value);
    document.querySelector('[data-sec="app"]').click();await wait(30);
  });
  await check('临时Key默认重置旧供应商并自动探测，不加入列表', async () => {
    $('apiKey').value = 'fixture-temp-5xyz'; await click('tempKey');
    ok(testConfig.api.apiKey === 'fixture-temp-5xyz' && testConfig.api.iface === 'auto');
    ok(testConfig.api.baseURL === '' && testConfig.api.model === '' && testKeys.length === 2);
    ok($('apiKey').value === '' && $('keyStatus').textContent.includes('未加入已保存列表'));
  });
  await check('切换已保存Key恢复对应接口，并正确标记当前项', async () => {
    $('savedKeys').children[1].querySelector('button').click(); await wait(30);
    ok(testConfig.api.apiKey === 'fixture-other-4abc' && testConfig.api.iface === 'anthropic');
    ok($('provider').value === 'anthropic' && $('savedKeys').children[1].querySelector('button').disabled);
  });
  await check('删除当前Key会传递id和key，同时停用且不影响其他记录', async () => {
    $('savedKeys').children[1].querySelectorAll('button')[1].click(); await wait(30);
    const call = testCalls.findLast(x => x.type === 'KEY_REMOVE');
    ok(call.payload.id === 'other' && call.payload.key === 'fixture-other-4abc');
    ok(testConfig.api.apiKey === '' && testKeys.length === 1 && $('clearKey').disabled);
  });
  await check('首次记住Key先告知，确认后走自动KEY_SAVE并刷新列表', async () => {
    $('apiKey').value = 'fixture-new-9key'; await click('saveKey');
    ok(!$('keyConfirm').hidden && !testCalls.some(x => x.type === 'KEY_SAVE'));
    await click('keyConfirmSave');
    ok(testConfig.keyWarned && $('keyConfirm').hidden && testKeys.length === 2);
    ok(testCalls.findLast(x => x.type === 'KEY_SAVE').payload.iface === 'auto');
    ok($('keyStatus').textContent.includes('9key') && $('provider').value === 'openai');
  });
  await check('停用仅清当前Key，列表保留可重新使用', async () => {
    await click('clearKey'); ok(testKeys.length === 2 && testConfig.api.apiKey === '');
    $('savedKeys').children[0].querySelector('button').click(); await wait(30);
    ok(testConfig.api.apiKey === 'fixture-new-9key');
  });
  await check('明确展开自定义接口时临时Key尊重手动配置，拒绝域名权限不会写配置', async () => {
    $('apiDetails').open = true; select('provider', 'openai');
    $('baseURL').value = 'https://custom.example/v1'; $('model').value = 'custom-model'; $('apiKey').value = 'fixture-custom-7abc';
    window.testDenyPermission = true; await click('tempKey');
    ok(testConfig.api.apiKey === 'fixture-new-9key' && $('keyMsg').classList.contains('err'));
    window.testDenyPermission = false; await click('tempKey');
    ok(testConfig.api.apiKey === 'fixture-custom-7abc' && testConfig.api.baseURL === 'https://custom.example/v1' && testKeys.length === 2);
  });
  await check('测试连接具有成功和错误反馈', async () => {
    await click('test'); ok($('testMsg').classList.contains('ok'));
    window.testFailure = 'TEST_API'; await click('test'); ok($('testMsg').classList.contains('err') && !$('test').disabled); window.testFailure = null;
  });
  await check('普通设置保存二次判断和简答策略，保留当前Key且不将输入框新Key悄悄入库', async () => {
    $('verify2').checked = false; $('subjMode').value = 'keep'; $('apiKey').value = 'fixture-not-saved';
    await click('save');
    const payload = testCalls.findLast(x => x.type === 'SET_CONFIG').payload;
    ok(!('apiKey' in payload.api) && !testConfig.verify2 && testConfig.subjMode === 'keep');
    ok(testConfig.api.apiKey === 'fixture-custom-7abc' && testKeys.length === 2 && $('msg').textContent.includes('新粘贴'));
    $('apiKey').value = '';
  });
  await check('豆包配置按引擎出现，间隔范围有校验且正常保存', async () => {
    select('engine', 'bridge'); ok($('apiFields').hidden && !$('bridgeFields').hidden && $('verify2').disabled);
    $('delayMin').value = '5000'; $('delayMax').value = '3000'; await click('save'); ok($('msg').classList.contains('err'));
    $('delayMax').value = '9000'; $('newChat').checked = false; await click('save');
    ok(testConfig.engine === 'bridge' && testConfig.bridge.delayMin === 5000 && testConfig.bridge.delayMax === 9000 && !testConfig.bridge.newChat);
    select('engine', 'api');
  });
  await check('Key操作失败后保留输入，恢复控件并显示错误', async () => {
    $('apiDetails').open = false; $('apiKey').value = 'fixture-failure'; window.testFailure = 'KEY_SAVE'; await click('saveKey');
    ok($('apiKey').value === 'fixture-failure' && !$('appFields').disabled && $('keyMsg').classList.contains('err'));
    window.testFailure = null; $('apiKey').value = '';
  });
  return results;
}
const fixtureScript = `<script>(${fixture.toString()})();window.runSettingsChecks=${checks.toString()};window.uiErrors=[];addEventListener('error', e=>uiErrors.push(e.message));addEventListener('unhandledrejection', e=>uiErrors.push(String(e.reason)));</script>`;
const server = http.createServer((req, res) => {
  const requestPath = new URL(req.url, 'http://localhost').pathname;
  const full = path.resolve(root, '.' + requestPath);
  if (!full.startsWith(root + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.statusCode = 404; res.end(); return; }
  let text = fs.readFileSync(full, 'utf8');
  if (requestPath === '/settings.html') text = text.replace('<script type="module" src="settings.js">', fixtureScript + '<script type="module" src="settings.js">');
  res.setHeader('Content-Type', /\.m?js$/.test(full) ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8'); res.end(text);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const child = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-crash-reporter', '--disable-breakpad', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
let socket;
try {
  let port;
  for (let i=0;i<150;i++) { const f=path.join(profile,'DevToolsActivePort'); if(fs.existsSync(f)){port=Number(fs.readFileSync(f,'utf8').split('\n')[0]);break;} if(child.exitCode!==null)throw new Error('Chrome exited before DevTools'); await pause(100); }
  assert.ok(port,'Chrome unavailable');
  const target=await(await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://127.0.0.1:${server.address().port}/settings.html`)}`,{method:'PUT'})).json();
  socket=new WebSocket(target.webSocketDebuggerUrl); await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
  let id=0;const pending=new Map();socket.onmessage=({data})=>{const m=JSON.parse(data);if(pending.has(m.id)){const {r,j,t}=pending.get(m.id);pending.delete(m.id);clearTimeout(t);m.error?j(Error(JSON.stringify(m.error))):r(m.result);}};
  const call=(method,params={})=>new Promise((r,j)=>{const key=++id,t=setTimeout(()=>j(Error('CDP timeout '+method)),10000);pending.set(key,{r,j,t});socket.send(JSON.stringify({id:key,method,params}));});
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  for(let i=0;i<100&&!(await evaluate('document.readyState==="complete"&&!!window.runSettingsChecks&&!document.getElementById("appFields").disabled'));i++)await pause(50);
  for (const width of [1280,420]) {
    await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await pause(100);
    const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});fs.writeFileSync(path.join(output,`settings-default-${width}.png`),Buffer.from(shot.data,'base64'));
  }
  const results=await evaluate('runSettingsChecks()');
  for(const r of results)console.log(r.ok?'PASS':'FAIL',r.name,r.error||'');
  for(const width of [1280,420,320]) {
    await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.querySelector('[data-sec="diag"]').click()`);await pause(100);
    await evaluate(`(()=>{document.querySelector('.issue-history').open=true;document.querySelector('#issueList details').open=true;window.scrollTo(0,0);})()`);await pause(30);
    assert.ok(await evaluate('document.querySelector("#issueList details").open'),'诊断详情未展开');
    const diag = await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});fs.writeFileSync(path.join(output,`settings-diag-${width}.png`),Buffer.from(diag.data,'base64'));
    assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'诊断内容溢出');
    await evaluate(`document.querySelector('[data-sec="app"]').click()`);
    for(const mode of ['api','advanced','bridge']) {
      await evaluate(`(()=>{const e=document.getElementById('engine');e.value=${JSON.stringify(mode==='bridge'?'bridge':'api')};e.dispatchEvent(new Event('change'));document.getElementById('apiDetails').open=${mode==='advanced'};window.scrollTo(0,0);})()`);await pause(100);
      const geometry=await evaluate(`(()=>{const s=document.getElementById('sec-app'),r=s.getBoundingClientRect();return {width:innerWidth,scroll:document.documentElement.scrollWidth,left:r.left,right:r.right,cardScroll:s.scrollWidth,cardWidth:s.clientWidth};})()`);
      assert.ok(geometry.scroll<=width && geometry.left>=0 && geometry.right<=width && geometry.cardScroll<=geometry.cardWidth,JSON.stringify({mode,geometry}));
      const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});fs.writeFileSync(path.join(output,`settings-${mode}-${width}.png`),Buffer.from(shot.data,'base64'));
    }
    results.push({name:`设置页${width}px API/手动接口/豆包无横向溢出`,ok:true});
  }
  assert.deepEqual(await evaluate('uiErrors'),[],'运行时出现页面错误');
  await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/options/options.html`});
  for(let i=0;i<100&&!(await evaluate('location.pathname==="/settings.html"&&location.hash==="#app"'));i++)await pause(50);
  assert.ok(await evaluate('location.pathname==="/settings.html"&&location.hash==="#app"'),'旧options入口未统一跳转');
  results.push({name:'旧options入口跳转同一应用设置页',ok:true});
  await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/settings.html?empty=1`});
  for(let i=0;i<100&&!(await evaluate('document.readyState==="complete"&&document.getElementById("appFields")&&!document.getElementById("appFields").disabled'));i++)await pause(50);
  assert.ok(await evaluate('!document.getElementById("savedKeys").children.length&&document.getElementById("keyStatus").textContent.includes("当前未使用")&&document.getElementById("clearKey").disabled'),'无Key空状态错误');
  await call('Emulation.setDeviceMetricsOverride',{width:420,height:900,deviceScaleFactor:1,mobile:false});await pause(100);
  const empty=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});fs.writeFileSync(path.join(output,'settings-empty-420.png'),Buffer.from(empty.data,'base64'));
  await evaluate(`(()=>{document.getElementById('apiKey').focus();})()`);await pause(250);
  let detail=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'settings-key-focus.png'),Buffer.from(detail.data,'base64'));
  await evaluate(`(()=>{const t=document.getElementById('engine-trigger');t.focus();t.click();})()`);await pause(100);
  detail=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'settings-dropdown-open.png'),Buffer.from(detail.data,'base64'));
  results.push({name:'首次使用无Key空状态正确，停用按钮禁用',ok:true});
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));assert.ok(results.every(r=>r.ok),'设置验证失败');
  console.log(`PASS total ${results.length} groups; screenshots ${output}`);
}finally{socket?.close();child.kill();server.close();}
