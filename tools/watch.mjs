/* 热重载监听：node tools/watch.mjs
   检测到插件代码变化时更新 hot-reload.json 时间戳，
   后台 Service Worker 轮询到变化即 chrome.runtime.reload() 自动重载。
   注意：页面里的 content script 仍需刷新（F5）后生效。 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const targets = ['manifest.json', 'background', 'content', 'options'];
const stampFile = path.join(root, 'hot-reload.json');

fs.writeFileSync(stampFile, JSON.stringify({ t: Date.now() }));

let timer = null;
function onTouch() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    fs.writeFileSync(stampFile, JSON.stringify({ t: Date.now() }));
    console.log('[watch] 变更已写入，插件将自动重载（页面记得 F5）');
  }, 150);
}

for (const t of targets) {
  const p = path.join(root, t);
  if (!fs.existsSync(p)) continue;
  const stat = fs.statSync(p);
  if (stat.isDirectory()) fs.watch(p, { recursive: true }, onTouch);
  else fs.watchFile(p, { interval: 500 }, onTouch);
}
console.log(`[watch] 热重载监听中：${targets.join(', ')} （Ctrl+C 退出）`);
