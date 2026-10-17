/* 生成 Edge 商店专用包：沿用 GitHub 源码，但去掉项目自带的 GitHub 更新器。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = SOURCE_MANIFEST.version;
const outPath = path.resolve(process.argv[2] || path.join(ROOT, 'dist', `作业助手-${version}.zip`));
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-edge-store-'));

function read(rel) { return fs.readFileSync(path.join(stage, rel), 'utf8'); }
function write(rel, text) { fs.writeFileSync(path.join(stage, rel), text, 'utf8'); }
function removeBetween(text, start, end, label) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`无法定位 ${label} 的源码边界`);
  return text.slice(0, from) + text.slice(to);
}
function replaceOnce(text, before, after, label) {
  const at = text.indexOf(before);
  if (at < 0 || text.indexOf(before, at + before.length) >= 0) throw new Error(`无法唯一定位 ${label}`);
  return text.slice(0, at) + after + text.slice(at + before.length);
}
function copyDir(name) {
  fs.cpSync(path.join(ROOT, name), path.join(stage, name), { recursive: true });
}

try {
  for (const dir of ['background', 'content', 'icons', 'options']) copyDir(dir);
  for (const file of ['manifest.json', 'settings.html', 'settings.js']) {
    fs.copyFileSync(path.join(ROOT, file), path.join(stage, file));
  }

  const manifest = JSON.parse(read('manifest.json'));
  manifest.version = version;
  manifest.description = manifest.description.replace('、豆包网页桥接与安全更新。', '、豆包网页桥接。');
  if (manifest.description.includes('安全更新')) throw new Error('Edge 商店版描述仍包含 GitHub 更新功能');
  manifest.permissions = manifest.permissions.filter((permission) => permission !== 'nativeMessaging');
  write('manifest.json', JSON.stringify(manifest, null, 2) + '\n');

  let sw = read('background/service-worker.js');
  sw = replaceOnce(sw,
    '/* 后台 Service Worker：引擎路由、题目队列、答案缓存、与作业页消息中转、热重载、自动更新检查 */',
    '/* 后台 Service Worker：引擎路由、题目队列、答案缓存、与作业页消息中转 */', 'service worker description');
  sw = replaceOnce(sw,
    "import { hashKey, compareVersions, isMajorUpdate } from './engines/engine.js';",
    "import { hashKey } from './engines/engine.js';", 'service worker imports');
  sw = removeBetween(sw, '/* —— 更新检查：', 'async function askEngine(cfg, q) {', 'service worker update checker');
  sw = removeBetween(sw, 'const UPDATE_HOST =', 'function cacheKeyOf(q) {', 'native updater');
  sw = replaceOnce(sw,
    "      } else if (type === 'CHECK_UPDATE') {\n        sendResponse(await checkUpdate(payload.force, payload.cacheOnly));\n      } else if (type === 'HW_RUN_UPDATE') {\n        sendResponse(await runUpdateViaHost());\n      } else if (type === 'DIAG_UPDATE_HOST') {\n        /* 安装完成自检：只 ping 宿主，不启动更新 */\n        sendResponse(await diagUpdateHost());\n      } else if (type === 'UPDATE_PAGE_READY') {\n        sendResponse(await confirmUpdatePage(payload.transactionId, sender));\n      } else if (type === 'OPEN_SETTINGS') {",
    "      } else if (type === 'OPEN_SETTINGS') {", 'service worker updater message handlers');
  sw = replaceOnce(sw,
    "        const keys = Object.keys(all).filter((k) => k.startsWith('c:') && k !== 'c:upd');",
    "        const keys = Object.keys(all).filter((k) => k.startsWith('c:'));", 'update cache exclusion');
  sw = replaceOnce(sw,
    '        // c:upd 是更新检查缓存（非答题记忆），不计入条数也不删',
    '        // 答题记忆缓存以 c: 开头', 'update cache comment');
  sw = replaceOnce(sw,
    '/* 保存当前版本供其他诊断使用；更新成功提示由设置页等到事务健康确认后显示。 */',
    '/* 保存当前版本，供其他诊断使用。 */', 'service worker version comment');
  sw = removeBetween(sw, '\nopenUpdateHealthPage();', '\n/* —— 热重载：', 'update health and development reload');
  sw = sw.slice(0, sw.indexOf('\n/* —— 热重载：')) + '\n';
  write('background/service-worker.js', sw);

  let engine = read('background/engines/engine.js');
  const versionHelpers = engine.indexOf('/* 版本号比较（自动更新检查用）：');
  if (versionHelpers < 0) throw new Error('无法定位版本比较工具');
  engine = engine.slice(0, versionHelpers).trimEnd() + '\n';
  write('background/engines/engine.js', engine);

  let html = read('settings.html');
  html = replaceOnce(html,
    '    <button type="button" data-sec="upd" aria-controls="sec-upd">检测更新</button>\n',
    '', 'settings update navigation');
  html = removeBetween(html, '      <section id="sec-upd"', '      </section>', 'settings updater section');
  html = replaceOnce(html, '      </section>\n    </div>\n  </main>', '    </div>\n  </main>', 'settings updater section closing');
  html = html.replace(/^\s*\.confirm p#updGuidePath\{[^\n]*\}\r?\n/gm, '\n');
  html = html.replace(/^\s*\.update-progress[^\n]*\r?\n/gm, '\n');
  write('settings.html', html);

  let settings = read('settings.js');
  settings = replaceOnce(settings, "import { isUpdaterHostReady } from './tools/updater-setup-core.mjs';\n\n", '', 'settings updater import');
  settings = replaceOnce(settings,
    '/* 工具设置页（settings.html）：侧边栏收纳 记忆 / 诊断 / 检测更新。',
    '/* 工具设置页（settings.html）：侧边栏收纳记忆与诊断。', 'settings page description');
  settings = replaceOnce(settings,
    "  const secs = { mem: $('#sec-mem'), diag: $('#sec-diag'), upd: $('#sec-upd') };\n  let onSection = () => {};",
    "  const secs = { mem: $('#sec-mem'), diag: $('#sec-diag') };", 'settings navigation state');
  settings = replaceOnce(settings, '    onSection(key);\n', '', 'settings update section callback');
  const updaterStart = settings.indexOf('  /* 检测更新：');
  const finalClose = settings.lastIndexOf('\n})();');
  if (updaterStart < 0 || finalClose < updaterStart) throw new Error('无法定位设置页更新代码');
  settings = settings.slice(0, updaterStart) + settings.slice(finalClose);
  write('settings.js', settings);

  let panel = read('content/homework/panel.js');
  panel = panel.replace(/^\s*\.updline[^\n]*\r?\n/gm, '\n');
  panel = replaceOnce(panel,
    '        <div class="updline hidden" data-tip="点击「更新」启动更新事务；下载、验证与回滚状态请在设置页查看，成功后作业页面需 F5"></div>\n',
    '', 'panel update notice element');
  panel = replaceOnce(panel, "      updline: $('.updline'),\n", '', 'panel update notice reference');
  panel = removeBetween(panel, '      // 更新提示：只读后台缓存', '\n    })();', 'panel update notice logic');
  panel = panel.replaceAll('检测更新', '记忆 / 诊断');
  write('content/homework/panel.js', panel);

  const sourceFiles = ['background/service-worker.js', 'background/engines/engine.js', 'settings.html', 'settings.js', 'content/homework/panel.js'];
  const forbidden = /CHECK_UPDATE|HW_RUN_UPDATE|DIAG_UPDATE_HOST|UPDATE_PAGE_READY|nativeMessaging|connectNative|autoupdate\.mjs|install-updater\.cmd|检测更新|updline|自动更新/;
  for (const file of sourceFiles) {
    const hits = read(file).match(new RegExp(forbidden.source, 'g')) || [];
    if (hits.length) throw new Error(`商店包仍含更新功能：${file}（${[...new Set(hits)].join(', ')}）`);
  }
  if (JSON.parse(read('manifest.json')).permissions.includes('nativeMessaging')) throw new Error('商店包仍声明 nativeMessaging');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (fs.existsSync(outPath)) fs.rmSync(outPath, { force: true });
  const quote = (value) => `'${value.replace(/'/g, "''")}'`;
  const zipCommand = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(${quote(stage)}, ${quote(outPath)}, [System.IO.Compression.CompressionLevel]::Optimal, $false)`;
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', zipCommand], { stdio: 'inherit' });
  console.log(`Edge 商店包已生成：${outPath}`);
  console.log(`版本：${version}；大小：${fs.statSync(outPath).size} bytes`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
