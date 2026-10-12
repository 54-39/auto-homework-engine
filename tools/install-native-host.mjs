/* 一次性安装：把 tools/native-host.mjs 注册为浏览器的原生消息宿主（Windows）。
   用法：双击 install-updater.cmd；命令行可用 node tools/install-native-host.mjs [edge|chrome]
   做四件事：① 用系统自带 csc.exe 编译一个启动器 native-host.exe（新版 Chrome/Edge 已禁 .bat 宿主，
   .mjs 又不能直接运行，启动器只负责把标准输入输出原样接给 node）② 写宿主清单 .native-host.json
   ③ 写注册表 HKCU\...\NativeMessagingHosts ④ 把扩展 ID 记进 .crinfo。
   安装后：由浏览器实际 ping 验证宿主，再在设置页点「更新」启动可回滚事务。
   重复运行会覆盖旧配置。卸载：删 .native-host.json + 删注册表键。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { extensionIdFor, nativeHostManifest, nativeHostNames, normalizeRoot } from './native-host-install-core.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HOSTS = {
  chrome: 'SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\',
  edge: 'SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\',
};

const args = process.argv.slice(2);
const browser = (args[0] || 'edge').toLowerCase();
const extRoot = ROOT;
if (args.length > 1 || !HOSTS[browser]) {
  console.error('用法：在插件目录双击 install-updater.cmd；或 node tools/install-native-host.mjs [edge|chrome]');
  process.exit(1);
}
if (!fs.existsSync(path.join(extRoot, 'manifest.json'))) {
  console.error('错误：' + extRoot + ' 不是插件根目录（缺 manifest.json）');
  process.exit(1);
}
if (!fs.existsSync(path.join(HERE, 'native-host.mjs'))) {
  console.error('错误：tools/native-host.mjs 不存在（先拉取/更新仓库）');
  process.exit(1);
}

/* ① 未打包扩展 ID 由所在目录决定；每次重新计算，忽略复制来的记录。 */
const crinfoPath = path.join(extRoot, '.crinfo');
let saved = null;
try { saved = JSON.parse(fs.readFileSync(crinfoPath, 'utf8')); } catch { /* 首次安装 */ }
const extId = extensionIdFor(extRoot);
const names = nativeHostNames(extId);
const derivedId = saved?.id !== extId || normalizeRoot(saved?.root || '') !== normalizeRoot(extRoot);
fs.writeFileSync(crinfoPath, JSON.stringify({ id: extId, root: normalizeRoot(extRoot) }, null, 2));

/* ② 启动器 exe：Chrome/Edge 只认 exe（2025 年起 .bat/.cmd 宿主被禁），csc.exe 是 Windows 自带的 */
function findCsc() {
  for (const f of ['Framework64', 'Framework']) {
    const base = 'C:\\Windows\\Microsoft.NET\\' + f;
    if (!fs.existsSync(base)) continue;
    const vers = fs.readdirSync(base).filter((d) => /^v\d/.test(d)).sort().reverse();
    for (const v of vers) {
      const csc = path.join(base, v, 'csc.exe');
      if (fs.existsSync(csc)) return csc;
    }
  }
  return '';
}
function findNode() {
  try {
    const out = spawnSync('where.exe', ['node'], { encoding: 'utf8' });
    const first = String(out.stdout || '').split(/\r?\n/).find(Boolean);
    if (out.status === 0 && first) return first.trim();
  } catch { /* 走兜底 */ }
  for (const p of ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files (x86)\\nodejs\\node.exe']) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}
function findBrowser() {
  const name = browser === 'edge' ? 'msedge.exe' : 'chrome.exe';
  for (const p of browser === 'edge'
    ? ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
    : ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const result = spawnSync('where.exe', [name], { encoding: 'utf8' });
    if (result.status === 0) return String(result.stdout || '').split(/\r?\n/).find(Boolean)?.trim() || '';
  } catch { /* user can open the settings page manually */ }
  return '';
}
const nodeExe = findNode();
if (!nodeExe) {
  console.error('错误：PATH 上找不到 node.exe，无法编译启动器。先安装 Node.js 再重跑。');
  process.exit(1);
}
const exePath = path.join(HERE, 'native-host.exe');
const csc = findCsc();
if (!csc) {
  console.error('错误：找不到 csc.exe（.NET Framework 编译器），无法生成启动器。');
  process.exit(1);
}
const cs = `
using System;
using System.Diagnostics;
using System.Threading;
class NativeHostLauncher {
  static void Pump(System.IO.Stream from, System.IO.Stream to) {
    byte[] buf = new byte[8192];
    try { int n; while ((n = from.Read(buf, 0, buf.Length)) > 0) { to.Write(buf, 0, n); to.Flush(); } }
    catch { }
    try { to.Close(); } catch { }
  }
  static int Main(string[] args) {
    string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
    string host = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(self), "native-host.mjs");
    ProcessStartInfo psi = new ProcessStartInfo();
    psi.FileName = @"${nodeExe.replace(/\\/g, '\\\\')}";
    psi.Arguments = '"' + host + '"';
    foreach (string arg in args) psi.Arguments += " \"" + arg.Replace("\"", "\\\"") + "\"";
    psi.UseShellExecute = false;
    psi.RedirectStandardInput = true;
    psi.RedirectStandardOutput = true;
    psi.RedirectStandardError = true;
    psi.CreateNoWindow = true;
    using (Process p = Process.Start(psi)) {
      Thread ti = new Thread(() => Pump(Console.OpenStandardInput(), p.StandardInput.BaseStream));
      Thread to = new Thread(() => Pump(p.StandardOutput.BaseStream, Console.OpenStandardOutput()));
      Thread te = new Thread(() => Pump(p.StandardError.BaseStream, Console.OpenStandardError()));
      ti.IsBackground = to.IsBackground = te.IsBackground = true;
      ti.Start(); to.Start(); te.Start();
      ti.Join();
      p.WaitForExit();
      return p.ExitCode;
    }
  }
}`;
const csPath = path.join(os.tmpdir(), 'hw-native-host-launcher.cs');
fs.writeFileSync(csPath, cs);
const cscOut = spawnSync(csc, ['/nologo', '/target:exe', '/out:' + exePath, '/platform:anycpu', csPath], { encoding: 'utf8' });
if (cscOut.status !== 0 || !fs.existsSync(exePath)) {
  console.error('错误：启动器编译失败：' + (cscOut.stdout || cscOut.stderr || ''));
  process.exit(1);
}

/* ③ 每个目录有独立宿主名；再保留旧固定名供尚未迁移的插件完成第一次更新。 */
const manifests = [
  { name: names.current, path: path.join(ROOT, `.native-host-${extId}.json`) },
  { name: names.legacy, path: path.join(ROOT, '.native-host.json') },
];
for (const item of manifests) {
  fs.writeFileSync(item.path, JSON.stringify(nativeHostManifest({
    name: item.name,
    description: '作业助手：用户点「更新」时执行一次同步',
    executable: exePath,
    extensionId: extId,
  }), null, 2));
}

/* ④ 注册表：浏览器按 name 查这个键找到清单 */
try {
  for (const item of manifests) {
    execFileSync('reg', ['add', 'HKCU\\' + HOSTS[browser] + item.name, '/ve', '/t', 'REG_SZ', '/d', item.path, '/f'], { stdio: 'pipe' });
  }
} catch (e) {
  console.error('错误：写注册表失败（' + String(e.message || e) + '）');
  process.exit(1);
}

console.log('已安装原生消息宿主（' + browser + '）：');
console.log('  启动器:   ' + exePath);
console.log('  Node:     ' + nodeExe);
for (const item of manifests) console.log('  宿主清单: ' + item.path);
console.log('  注册表:   HKCU\\' + HOSTS[browser] + names.current);
console.log('  允许来源: chrome-extension://' + extId + '/');
if (derivedId) {
  console.log('\n扩展 ID 已按此插件目录重新计算，并写入 .crinfo。');
}

/* 安装后自检：注册表键和清单文件必须都真实存在，否则浏览器根本找不到宿主，
   点「更新」只会报「宿主未安装」。有问题直接报错退出，不让人装完还蒙在鼓里 */
let verifyOk = true;
try {
  for (const item of manifests) {
    const q = execFileSync('reg', ['query', 'HKCU\\' + HOSTS[browser] + item.name, '/ve'], { encoding: 'utf8', stdio: 'pipe' });
    if (!q.includes(item.path)) { console.error('自检失败：注册表里没写对清单路径：' + item.name); verifyOk = false; }
  }
} catch (e) {
  console.error('自检失败：读不到浏览器宿主注册键（' + String(e.message || e).split('\n')[0] + '）');
  verifyOk = false;
}
try {
  for (const item of manifests) {
    const m = JSON.parse(fs.readFileSync(item.path, 'utf8'));
    if (m.name !== item.name || m.path !== exePath || !(m.allowed_origins || []).includes('chrome-extension://' + extId + '/')) {
      console.error('自检失败：宿主清单内容不对（' + item.name + '）');
      verifyOk = false;
    }
    if (!fs.existsSync(m.path)) { console.error('自检失败：清单指向的启动器不存在：' + m.path); verifyOk = false; }
  }
} catch (e) {
  console.error('自检失败：宿主清单读不出来（' + String(e.message || e) + '）');
  verifyOk = false;
}
if (!verifyOk) process.exit(1);
console.log('自检通过：注册表、宿主清单、启动器路径与目录 ID 一致。');
console.log('\n安装完成。设置页将通过当前浏览器验证宿主连接、扩展 ID、目录和版本。');
const browserExe = findBrowser();
if (browserExe) {
  const settingsUrl = `chrome-extension://${extId}/settings.html?setupCheck=1#upd`;
  const opened = spawn(browserExe, [settingsUrl], { detached: true, stdio: 'ignore', windowsHide: false });
  opened.once('error', (e) => console.error('无法自动打开浏览器自检页：' + String(e.message || e)));
  opened.unref();
  console.log('已打开设置页，由当前浏览器实际 ping 更新宿主并校验扩展 ID、目录和版本。');
} else {
  console.log('未找到浏览器可执行文件；打开扩展设置页 → 诊断更新，完成实际浏览器 ping。');
}
