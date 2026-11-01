/* 独立临时浏览器验证参考图比例，不连接模型或个人浏览器配置。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.tmp-panel-layout');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'edge-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const scripts = ['adapters/chaoxing.js', 'dropdown.js', 'diagnostics.js', 'extractor.js', 'ai-extractor.js', 'filler.js', '../course/watch.js', 'panel.js']
  .map(name => fs.readFileSync(path.join(root, 'content/homework', name), 'utf8')).join('\n;\n');
function boot() {
  window.config = { engine: 'api', panelMode: 'homework', api: { apiKey: 'fixture-only' }, verify2: true };
  window.storageListeners = [];
  window.configure = patch => {
    const oldValue = config;
    config = { ...config, ...patch };
    storageListeners.forEach(fn => fn({ config: { oldValue, newValue: config } }, 'local'));
  };
  window.chrome = {
    runtime: { onMessage: { addListener() {} }, sendMessage: async msg => {
      if (msg.type === 'GET_CONFIG') return { ok: true, config };
      if (msg.type === 'SET_CONFIG') { Object.assign(config, msg.payload); return { ok: true, config }; }
      if (msg.type === 'HW_WATCH_QUEUE_GET') return { ok: true, queue: null };
      if (msg.type === 'HW_WATCH_COURSES') return { ok: true, courses: [] };
      if (msg.type === 'KEY_LIST') return { ok: true, list: [] };
      if (msg.type === 'CHECK_UPDATE') return { ok: false };
      return { ok: true };
    } },
    storage: { onChanged: { addListener: fn => storageListeners.push(fn) }, local: { get: async () => ({}), set: async () => {} } },
  };
}
const questions = Array.from({ length: 40 }, (_, i) => `<section class="questionLi" typename="简答题" id="question${i + 1}"><h3 class="mark_name">${i + 1}. 请解释本题的概念，并说明具体应用和注意事项</h3><textarea></textarea></section>`).join('');
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><meta charset="utf-8"><style>body{margin:32px;background:#f4f6f8;color:#374151;font:14px system-ui}main{max-width:650px}section{padding:12px;margin:12px 0;background:white}textarea{width:90%;height:50px}</style><main><h1>作业页面 · 本地布局验证</h1>' + (req.url.includes('empty') ? '' : questions) + '</main><script>(' + boot.toString() + ')();' + scripts + ';HW.Panel.init();</script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const child = spawn(process.env.EDGE_BIN || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
let ws, call;
const results = [];
try {
  let port;
  for (let i = 0; i < 150; i++) {
    const file = path.join(profile, 'DevToolsActivePort');
    if (fs.existsSync(file)) { port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]); break; }
    await pause(100);
  }
  assert.ok(port, '临时浏览器未启动');
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('http://127.0.0.1:' + server.address().port)}`, { method: 'PUT' })).json();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data), entry = pending.get(msg.id);
    if (entry) { pending.delete(msg.id); clearTimeout(entry.timer); msg.error ? entry.reject(Error(msg.error.message)) : entry.resolve(msg.result); }
  };
  call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(Error(method + ' timeout')), 20000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  for (let i = 0; i < 100 && !await evaluate('!!document.querySelector("#hw-panel-host")?.shadowRoot'); i++) await pause(50);
  await evaluate(`window.ui=document.querySelector('#hw-panel-host').shadowRoot;ui.querySelector('.fab').click();`);
  const measure = () => evaluate(`(() => {
    const p=ui.querySelector('.panel'),r=selector=>ui.querySelector(selector).getBoundingClientRect().toJSON();
    return {panel:r('.panel'),list:r('.list'),log:r('.logwrap'),buttons:r('.btnrow'),header:r('header'),
      overflowX:p.scrollWidth>p.clientWidth+1,overflowY:p.scrollHeight>p.clientHeight+1,viewport:{width:document.documentElement.clientWidth,height:innerHeight}};
  })()`);
  const check = g => {
    assert.ok(g.panel.left >= 0 && g.panel.top >= 0 && g.panel.right <= g.viewport.width && g.panel.bottom <= g.viewport.height, '面板超出视口');
    assert.ok(!g.overflowX, '面板横向溢出');
    if (g.viewport.height > 600) {
      assert.ok(g.panel.height / g.panel.width >= (g.viewport.height >= 800 ? 2.15 : 1.9), '未恢复参考图的修长比例');
      assert.ok(!g.overflowY && g.log.height >= 96 && g.log.height <= g.panel.height * .30, '日志挤压或空撑');
      assert.ok(g.list.height >= 120 && g.buttons.bottom <= g.list.top && g.list.bottom <= g.log.top && g.log.bottom <= g.panel.bottom, '题目、操作、日志重叠');
    } else assert.ok(g.panel.width >= 300, '矮窗口压窄控件');
  };
  for (const [width, height] of [[1280, 1000], [1280, 900], [420, 800], [390, 700], [640, 480]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    for (const mode of ['api', 'collapsed', 'no-key', 'bridge', 'watch']) {
      await evaluate(`configure({engine:${JSON.stringify(mode === 'bridge' ? 'bridge' : 'api')},panelMode:${JSON.stringify(mode === 'watch' ? 'watch' : 'homework')},api:{apiKey:${JSON.stringify(mode === 'no-key' ? '' : 'fixture-only')}}});`);
      await pause(150);
      if (mode === 'collapsed') await evaluate(`ui.querySelector('.apitoggle').click()`);
      if (mode === 'no-key') await evaluate(`if(ui.querySelector('.apisec').classList.contains('hidden'))ui.querySelector('.apitoggle').click()`);
      await pause(150);
      const geometry = await measure();
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(output, `${mode}-${width}x${height}.png`), Buffer.from(shot.data, 'base64'));
      results.push({ mode, width, height, ...geometry });
      fs.writeFileSync(path.join(output, 'geometry.json'), JSON.stringify(results, null, 2));
      if (mode !== 'watch') check(geometry);
      else assert.ok(!geometry.overflowX && (height <= 600 || !geometry.overflowY) && geometry.panel.top >= 0 && geometry.panel.bottom <= height && geometry.panel.right <= geometry.viewport.width, '刷课布局越界');
      console.log(`PASS ${mode} ${width}x${height}: ${geometry.panel.width.toFixed(1)}x${geometry.panel.height.toFixed(1)}`);
    }
  }
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate(`configure({engine:'api',panelMode:'homework'});ui.querySelector('.expandbtn').click()`);
  await pause(150);
  const expanded = await measure();
  assert.ok(expanded.panel.width >= 600 && !expanded.overflowX && !expanded.overflowY, '展开模式异常');
  await evaluate(`ui.querySelector('.expandbtn').click();ui.querySelector('.keyinput').focus()`);
  assert.equal(await evaluate(`ui.activeElement===ui.querySelector('.keyinput')`), true);
  await evaluate(`ui.querySelector('.btn-collapse').click();ui.querySelector('.fab').click()`);
  assert.equal(await evaluate(`ui.querySelector('.panel').classList.contains('hidden')`), false);
  const good = await measure();
  check(good);
  await evaluate(`ui.querySelector('.panel').style.height='500px'`);
  const squat = await measure();
  assert.throws(() => check(squat), /修长比例/);
  await evaluate(`ui.querySelector('.panel').style.height='';Object.assign(ui.querySelector('.logwrap').style,{flex:'none',height:'400px',maxHeight:'none'})`);
  const blank = await measure();
  assert.throws(() => check(blank), /日志/);
  await evaluate(`ui.querySelector('.logwrap').removeAttribute('style')`);
  console.log('PASS 展开/收起、输入焦点；诊断拒绝矮胖比例及过大日志区域');
  await call('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/empty' });
  for (let i = 0; i < 100 && !await evaluate('!!document.querySelector("#hw-panel-host")?.shadowRoot'); i++) await pause(50);
  await evaluate(`window.ui=document.querySelector('#hw-panel-host').shadowRoot;ui.querySelector('.fab').click()`);
  await pause(200);
  check(await measure());
  assert.equal(await evaluate('HW.questions.length'), 0);
  assert.equal(await evaluate(`ui.querySelector('.start').disabled`), true);
  const empty = await call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, 'empty-full.png'), Buffer.from(empty.data, 'base64'));
  const panel = (await measure()).panel;
  const preview = await call('Page.captureScreenshot', { format: 'png', clip: { x: panel.x, y: panel.y, width: panel.width, height: panel.height, scale: 1 } });
  fs.writeFileSync(path.join(output, 'panel-reference-restored.png'), Buffer.from(preview.data, 'base64'));
  console.log('PASS 空列表、禁用开始状态；参考图同尺寸截图');
} finally {
  if (ws?.readyState === WebSocket.OPEN) await call('Browser.close').catch(() => {});
  ws?.close(); child.kill(); server.closeAllConnections(); server.close();
}
