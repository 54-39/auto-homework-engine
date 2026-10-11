/* 一次性安装：把 tools/native-host.mjs 注册为浏览器的原生消息宿主（Windows）。
   用法：node tools/install-native-host.mjs <插件根目录> [chrome|edge]
   做四件事：① 用系统自带 csc.exe 编译一个启动器 native-host.exe（新版 Chrome/Edge 已禁 .bat 宿主，
   .mjs 又不能直接运行，启动器只负责把标准输入输出原样接给 node）② 写宿主清单 .native-host.json
   ③ 写注册表 HKCU\...\NativeMessagingHosts ④ 把扩展 ID 记进 .crinfo。
   安装后：设置页/面板点「更新」→ 浏览器拉起启动器 → node 同步 GitHub 新版 → 热重载。
   重复运行会覆盖旧配置。卸载：删 .native-host.json + 删注册表键。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const NAME = 'com.homeworkhelper.autoupdate';
const HOSTS = {
  chrome: 'SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\' + NAME,
  edge: 'SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts\\' + NAME,
};

const extRoot = path.resolve(process.argv[2] || '');
const browser = (process.argv[3] || 'edge').toLowerCase();
if (!HOSTS[browser]) {
  console.error('用法：node tools/install-native-host.mjs <插件根目录> [chrome|edge]（默认 edge）');
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

/* ① 扩展 ID：.crinfo 记过就用；否则提示用户从 chrome://extensions 复制（未打包扩展的 ID 由路径决定，换路径才会变） */
const crinfoPath = path.join(extRoot, '.crinfo');
let extId = '';
try { extId = JSON.parse(fs.readFileSync(crinfoPath, 'utf8')).id || ''; } catch { /* 没有 */ }
if (!/^[a-p]{32}$/.test(extId)) {
  console.error('未找到有效的扩展 ID。chrome://extensions → 开发者模式 → 复制「作业助手」的 ID（32 个字母），');
  console.error('然后重跑本脚本（或手动把 ' + ROOT + '\\.native-host.json 里 allowed_origins 的占位符替换成 chrome-extension://<ID>/）。');
  extId = 'PASTE_EXTENSION_ID_HERE';
} else {
  fs.writeFileSync(crinfoPath, JSON.stringify({ id: extId }, null, 2));
}

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
  static int Main() {
    string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
    string host = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(self), "native-host.mjs");
    ProcessStartInfo psi = new ProcessStartInfo();
    psi.FileName = @"${nodeExe.replace(/\\/g, '\\\\')}";
    psi.Arguments = '"' + host + '"';
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

/* ③ 宿主清单：path 指向启动器 exe；allowed_origins 只允许本扩展 */
const manifestPath = path.join(ROOT, '.native-host.json');
fs.writeFileSync(manifestPath, JSON.stringify({
  name: NAME,
  description: '作业助手：用户点「更新」时执行一次 GitHub 同步',
  path: exePath,
  type: 'stdio',
  allowed_origins: ['chrome-extension://' + extId + '/'],
}, null, 2));

/* ④ 注册表：浏览器按 name 查这个键找到清单 */
try {
  execFileSync('reg', ['add', 'HKCU\\' + HOSTS[browser], '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'pipe' });
} catch (e) {
  console.error('错误：写注册表失败（' + String(e.message || e) + '）');
  process.exit(1);
}

console.log('已安装原生消息宿主（' + browser + '）：');
console.log('  启动器:   ' + exePath);
console.log('  Node:     ' + nodeExe);
console.log('  宿主清单: ' + manifestPath);
console.log('  注册表:   HKCU\\' + HOSTS[browser]);
console.log('  允许来源: chrome-extension://' + extId + '/');
if (extId === 'PASTE_EXTENSION_ID_HERE') {
  console.log('\n下一步（必做）：把 .native-host.json 里 PASTE_EXTENSION_ID_HERE 换成扩展 ID 后重开浏览器。');
} else {
  console.log('\n完成。验证：设置页 → 检测更新 → 点「更新」。失败会显示具体错误（重开浏览器后生效）。');
}
