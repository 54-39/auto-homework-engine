import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const settingsTest = read('tools/test-settings-browser.mjs');
const settingsFixture = settingsTest.slice(settingsTest.indexOf('function fixture()'), settingsTest.indexOf('const fixtureScript ='));
const questionFixture = () => {
  const source = read('tools/test-question-actions-browser.mjs');
  return source.slice(source.indexOf('function boot()'), source.indexOf('const questions='));
};
const scripts = () => ['adapters/chaoxing.js', 'dropdown.js', 'diagnostics.js', 'extractor.js', 'ai-extractor.js', 'question-images.js', 'filler.js', '../course/watch.js', 'panel.js']
  .map(file => read('content/homework/' + file)).join('\n;\n');
const errors = 'window.uiErrors=[];addEventListener("error",e=>uiErrors.push(e.message));addEventListener("unhandledrejection",e=>uiErrors.push(String(e.reason)));';
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  res.setHeader('Content-Type', 'text/html;charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (pathname === '/questions') {
    const questions = Array.from({ length: 52 }, (_, i) => `<section class="questionLi" typename="简答题" id="question${i + 1}"><h3 class="mark_name">${i + 1}. 解释第${i + 1}题</h3>${i >= 48 ? '<iframe srcdoc="<body contenteditable=true></body>"></iframe>' : '<textarea></textarea>'}</section>`).join('');
    res.end('<!doctype html><meta charset="utf-8"><title>作业助手 · 本地回归夹具</title><style>body{font:14px system-ui}textarea,iframe{width:300px;height:70px}section{margin-bottom:10px}</style><main>' + questions + '</main><script>' + errors + questionFixture() + 'boot();' + scripts() + ';HW.Panel.init();</script>');
    return;
  }
  if (pathname === '/privacy') {
    res.end('<!doctype html><meta charset="utf-8"><title>诊断脱敏夹具</title><section class="questionLi"><h3>诊断题干</h3><a href="https://example.test/work?token=URL_SECRET#HASH_SECRET">附件</a><input name="answer" value="FORM_SECRET"><textarea>TEXTAREA_SECRET</textarea><div contenteditable>EDITOR_SECRET</div><p>sk-FAKE1234567890 demo@example.test 13800000000</p><iframe srcdoc="<p>框架题干</p><input value=FRAME_SECRET>"></iframe></section><script type="application/json">{"key":"SCRIPT_SECRET"}</script><script>window.chrome={runtime:{onMessage:{addListener(){}}}};' + read('content/homework/diagnostics.js') + '</script>');
    return;
  }
  if (pathname === '/settings.html') {
    const fixture = '<script>' + errors + settingsFixture + 'fixture();window.runSettingsChecks=checks;window.fixtureDownloads=[];HTMLAnchorElement.prototype.click=function(){fixtureDownloads.push({name:this.download,href:this.href});};chrome.tabs={query:async q=>{window.lastTabQuery=q;return window.fixtureTabs||[]},sendMessage:async(id,msg)=>{window.lastCapture={id,msg};return window.fixtureScene||{status:"captured",documents:[{html:"<p>脱敏题目</p>"}]}}};</script>';
    res.end(read('settings.html').replace('<script type="module" src="settings.js">', fixture + '<script type="module" src="settings.js">'));
    return;
  }
  const relative = pathname.slice(1);
  if (!/^(settings\.js|options\/[\w./-]+|content\/homework\/dropdown\.js|background\/issue-history\.js|tools\/updater-setup-core\.mjs)$/.test(relative)) {
    res.writeHead(404); res.end(); return;
  }
  const full = path.resolve(root, relative);
  if (!full.startsWith(root + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  res.setHeader('Content-Type', 'text/javascript;charset=utf-8');
  res.end(fs.readFileSync(full));
});
server.listen(0, '127.0.0.1', () => console.log('Audit fixtures: http://127.0.0.1:' + server.address().port));
