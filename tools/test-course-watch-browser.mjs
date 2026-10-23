/* 刷课功能的真实 Chromium 检查：跨同源 iframe 找 <video>、倍速被重置后能守住、播完点「下一节」。
   不联网、不接个人浏览器配置；用的是 headless Edge 里的真实 DOM。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.tmp-watch-tests');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'edge-'));
const edge = process.env.EDGE_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/* 页面里跑：三层同源 iframe（学习页 → 章节卡 → 视频模块），和超星真实层级一致。
   外层还带了课程目录与页签——整课循环是从目录进到「视频讲义」页签才会开始看视频。 */
async function watchChecks() {
  const out = [];
  const check = async (name, fn) => {
    try { await fn(); out.push({ name, ok: true }); } catch (e) { out.push({ name, ok: false, error: e.stack || e.message }); }
  };
  const ok = (v, msg = 'assertion failed') => { if (!v) throw new Error(msg); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const video = window.theVideo;
  /* 所有启动都走这里：把脚本的提示收集起来，最后几组断言要看它 */
  window.__notes = [];
  const start = (opts) => HW.Watch.start({ ...(opts || {}), onNote: (t) => window.__notes.push(t) });

  await check('跨两层层同源 iframe 找到 video', () => {
    ok(HW.Watch.findVideo() === video, '没在嵌套 iframe 里找到 video');
  });

  await check('静音选项立即应用到本页和嵌套视频，取消后恢复声音', () => {
    const other = document.createElement('video');
    document.body.append(other);
    HW.Watch.setMuted(true);
    ok(video.muted && other.muted, '未全部静音');
    HW.Watch.setMuted(false);
    ok(!video.muted && !other.muted, '取消后仍静音');
    HW.Watch.setMuted(true);
    other.remove();
  });

  await check('同页跳过已完成视频，并只点未完成视频自己的播放控件', async () => {
    const mid = document.querySelector('#card').contentDocument;
    const done = mid.createElement('div');
    done.className = 'ans-attach-ct ans-job-finished';
    const frame = mid.createElement('iframe');
    done.append(frame); mid.body.prepend(done);
    frame.srcdoc = '<body><video></video><button class="vjs-big-play-button">播放视频</button></body>';
    await new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
    const decoy = frame.contentDocument.querySelector('video');
    Object.defineProperty(decoy, 'readyState', { get: () => 1 });
    let wrongClicks = 0;
    frame.contentDocument.querySelector('button').addEventListener('click', () => { wrongClicks++; });
    const before = window.playBtnClicks || 0;
    ok(HW.Watch.findVideo() === video, '选中了已完成视频');
    start({ rate: 2 });
    await wait(1600);
    HW.Watch.stop();
    ok((window.playBtnClicks || 0) > before, '未点击待完成视频');
    ok(wrongClicks === 0, '误点已完成视频控件');
    done.remove();
  });

  await check('自动倍速跟播放器菜单最高档走（多数课只给到 2x）', async () => {
    start({ rate: 2, autoRate: true });
    await wait(1500);
    ok(Math.abs(video.playbackRate - 2) < 0.001, '当前 ' + video.playbackRate);
  });

  await check('播放器把倍速重置回 1 后自动守住', async () => {
    video.playbackRate = 1; // 模拟 videojs 换源/重载时重置
    await wait(1200);
    ok(Math.abs(video.playbackRate - 2) < 0.001, '被重置后没写回去，当前 ' + video.playbackRate);
  });

  await check('没有播放按钮时才退回调 play()，不让视频永远卡在 readyState 0', async () => {
    HW.Watch.stop();
    video.pause(); // 就像真人还没点播放：readyState 一直是 0
    const btn = window.thePlayBtn;
    btn.style.display = 'none'; // 版式里没有播放按钮
    let played = 0;
    const orig = video.play;
    video.play = () => { played++; return Promise.resolve(); }; // 真实 play() 在这里会因没源而 reject
    HW.Watch.setMuted(false);
    start({ rate: 2 });
    await wait(2200); // kick() 点不到按钮后等 900ms 才退回 play()
    ok(!video.muted, '开始播放时覆盖了用户的取消静音选择');
    HW.Watch.stop();
    HW.Watch.setMuted(true);
    video.play = orig;
    btn.style.display = '';
    ok(played > 0, 'readyState=' + video.readyState + ' 且没有播放按钮时也没调用 play()，视频永远不会开始');
  });

  await check('程序化 play() 被站点暂停过，所以也点它自己的播放按钮', async () => {
    HW.Watch.stop();
    video.pause();
    window.playBtnClicks = 0;
    start({ rate: 2 });
    // kick() 有 1.5 秒的重试间隔，上一组刚点过，所以这里要等够两轮
    let kickClicks = 0;
    const trace = [];
    for (let i = 0; i < 15 && !kickClicks; i++) {
      await wait(200);
      kickClicks = window.playBtnClicks;
      const cur = HW.Watch.findVideo();
      trace.push(i + ':' + kickClicks + ',rate=' + cur.playbackRate + ',rs=' + cur.readyState
        + ',btn=' + (window.thePlayBtn.offsetParent !== null) + ',run=' + HW.Watch.running
        + ',notes=' + window.__notes.slice(-2).join('|'));
    }
    HW.Watch.stop();
    ok(kickClicks > 0, '没点播放器的播放按钮；' + trace.join(' '));
  });

  await check('站点菜单里有这一档时，点它自己的倍速菜单项', async () => {
    HW.Watch.stop();
    window.rateItemClicks = 0;
    video.playbackRate = 1;
    start({ rate: 1.5 }); // 站点菜单有 1.5x，应该点菜单而不是直接写
    await wait(1500);
    HW.Watch.stop();
    ok(window.rateItemClicks > 0, '没点播放器的倍速菜单项');
    ok(Math.abs(video.playbackRate - 1.5) < 0.001, '点完菜单倍速是 ' + video.playbackRate);
  });

  await check('视频播完后整课循环自己收尾并停止', async () => {
    Object.defineProperty(video, 'ended', { get: () => true, configurable: true });
    start({ rate: 2 });
    for (let i = 0; i < 40 && HW.Watch.running; i++) await wait(300);
    ok(!HW.Watch.running, '视频播完了整课循环还在跑');
    ok(window.__notes.some((t) => /走完一遍/.test(t)), '没提示已走完：' + window.__notes.join(' / '));
  });

  await check('一个视频结束后仍继续同页第二个视频，不提前结束页签', async () => {
    const mid = document.querySelector('#card').contentDocument;
    const frame = mid.createElement('iframe');
    mid.body.append(frame);
    frame.srcdoc = '<body><video></video><button class="vjs-big-play-button">播放视频</button></body>';
    await new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
    const second = frame.contentDocument.querySelector('video');
    let paused = true, clicked = 0;
    Object.defineProperty(second, 'readyState', { get: () => 1 });
    Object.defineProperty(second, 'paused', { get: () => paused });
    second.play = () => { paused = false; return Promise.resolve(); };
    frame.contentDocument.querySelector('button').addEventListener('click', () => { clicked++; paused = false; });
    Object.defineProperty(video, 'ended', { get: () => false, configurable: true });
    start({ rate: 2 });
    await wait(1000);
    video.dispatchEvent(new Event('ended'));
    await wait(2200);
    ok(HW.Watch.running, '第一个视频结束后把整页提前结束了');
    ok(clicked > 0, '未接着点第二个视频的播放器');
    HW.Watch.stop(); frame.remove();
    Object.defineProperty(video, 'ended', { get: () => true, configurable: true });
  });

  await check('停止后不再改动倍速', async () => {
    HW.Watch.stop();
    ok(!HW.Watch.running);
    video.playbackRate = 1;
    await wait(900);
    ok(Math.abs(video.playbackRate - 1) < 0.001, '停止后仍在写倍速');
  });

  await check('倍速越界值被夹住', () => {
    start({ rate: 100 });
    ok(HW.Watch.rate === 16, 'rate=' + HW.Watch.rate);
    HW.Watch.stop();
  });

  window.watchResults = out;
  return out;
}

const fixture = `<!doctype html><meta charset="utf-8"><title>刷课模拟学习页</title>
<style>body{font:14px system-ui;margin:24px}button{padding:6px 10px}.prev_ul{display:flex;gap:10px;list-style:none;padding:0}.prev_ul li.active{background:#e8effd}</style>
<div id="coursetree">
  <div class="posCatalog_select posCatalog_active" id="cur900"><span class="posCatalog_name" title="1.1 视频任务点" onclick="getTeacherAjax('1','2','900');">1.1 视频任务点</span></div>
</div>
<ul class="prev_ul">
  <li class="c1 active" id="dct1" title="视频讲义">视频讲义</li>
  <li class="c2" id="dct2" title="元典阅读">元典阅读</li>
  <li class="c3" id="dct3" title="章节测验">章节测验</li>
</ul>
<iframe id="card" srcdoc="&lt;body style='margin:0'&gt;&lt;iframe id='video' srcdoc=&quot;&amp;lt;body style='margin:0'&amp;gt;&amp;lt;video id='vid' preload='none'&amp;gt;&amp;lt;/video&amp;gt;&amp;lt;/body&amp;gt;&quot;&gt;&lt;/iframe&gt;&lt;/body&gt;"></iframe>
<script>
  // 三层 iframe 全部就绪后取出最里层的 video，模拟超星层级
  window.addEventListener('load', () => {
    const mid = document.querySelector('#card').contentDocument;
    const inner = mid.querySelector('#video').contentDocument;
    const video = inner.querySelector('#vid');
    window.theVideo = video;
    // 模拟 videojs 的播放按钮：站点只认自己按钮触发的播放，程序化 play() 会被它暂停
    const play = inner.createElement('button');
    play.className = 'vjs-big-play-button';
    play.textContent = '播放视频';
    play.addEventListener('click', () => { window.playBtnClicks = (window.playBtnClicks || 0) + 1; });
    inner.body.appendChild(play);
    window.thePlayBtn = play;
    // 模拟 videojs 的倍速菜单：站点只提供到 2x，菜单项点了才会改 video.playbackRate
    const openRate = () => { window.rateMenuOpen = !window.rateMenuOpen; menu.style.display = window.rateMenuOpen ? 'block' : 'none'; };
    const rate = inner.createElement('button');
    rate.className = 'vjs-playback-rate';
    rate.textContent = '播放速度';
    rate.addEventListener('click', openRate);
    inner.body.appendChild(rate);
    const menu = inner.createElement('div');
    menu.className = 'vjs-menu-content';
    menu.style.display = 'none';
    for (const r of [0.75, 1, 1.25, 1.5, 2]) {
      const li = inner.createElement('li');
      li.className = 'vjs-menu-item';
      li.textContent = r + 'x';
      li.addEventListener('click', () => {
        window.rateItemClicks = (window.rateItemClicks || 0) + 1;
        video.playbackRate = r;
        window.rateMenuOpen = false;
        menu.style.display = 'none';
      });
      menu.appendChild(li);
    }
    inner.body.appendChild(menu);
  });
</script>`;

const sources = fs.readFileSync(path.join(root, 'content/course/watch.js'), 'utf8');
const html = fixture + `<script>${sources}</script><script>window.runWatchChecks=${watchChecks.toString()};</script>`;
const server = http.createServer((_, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-crash-reporter', '--disable-breakpad', '--remote-debugging-port=0', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
let socket;
try {
  let port;
  for (let i = 0; i < 150; i++) {
    const file = path.join(profile, 'DevToolsActivePort');
    if (fs.existsSync(file)) { port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]); break; }
    /* Edge 155 起启动器进程会先正常退出、浏览器由另一个进程承载，不再据此判失败（超时后由 assert.ok(port, 'Headless Edge unavailable') 兜底） */
    await pause(100);
  }
  assert.ok(port, 'Headless Edge unavailable');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://127.0.0.1:${server.address().port}/`)}`, { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, reject) => { socket.onopen = r; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (!pending.has(msg.id)) return;
    const { resolve, reject, timer } = pending.get(msg.id);
    clearTimeout(timer);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('CDP timeout: ' + method)); }, 30000);
    pending.set(key, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: key, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  for (let i = 0; i < 100 && !(await evaluate('document.readyState === "complete" && !!window.runWatchChecks && !!window.theVideo')); i++) await pause(50);
  const results = await evaluate('runWatchChecks()');
  for (const r of results) console.log(r.ok ? 'PASS' : 'FAIL', r.name, r.error || '');
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  assert.ok(results.every((r) => r.ok), 'Watch checks failed; see .tmp-watch-tests/results.json');
  console.log(`\n${results.length} watch groups passed.`);
} finally {
  socket?.close();
  /* Edge 155：child 是已退出的启动器进程，要用 CDP 关掉真正持有 profile 的浏览器，否则进程残留、profile 删不掉 */
  try {
    const pf = path.join(profile, 'DevToolsActivePort');
    if (fs.existsSync(pf)) {
      const p = Number(fs.readFileSync(pf, 'utf8').split('\n')[0]);
      const v = await (await fetch(`http://127.0.0.1:${p}/json/version`)).json();
      const bw = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((res) => { bw.onopen = () => { bw.send(JSON.stringify({ id: 1, method: 'Browser.close' })); setTimeout(res, 1200); }; bw.onerror = res; });
    }
  } catch { /* 浏览器已退出 */ }
  child.kill();
  server.closeAllConnections();
  server.close();
  await pause(300);
  const relative = path.relative(output, profile);
  if (!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('edge-')) {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
    catch { console.warn('Temporary browser profile is still locked:', profile); }
  }
}
