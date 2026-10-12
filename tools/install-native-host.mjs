/* 一次性安装：把 tools/native-host.mjs 注册为浏览器的原生消息宿主（Windows）。
   用法：node tools/install-native-host.mjs <插件根目录> [chrome|edge]
   做四件事：① 用系统自带 csc.exe 编译一个启动器 native-host.exe（新版 Chrome/Edge 已禁 .bat 宿主，
   .mjs 又不能直接运行，启动器只负责把标准输入输出原样接给 node）② 写宿主清单 .native-host.json
   ③ 写注册表 HKCU\...\NativeMessagingHosts ④ 把扩展 ID 记进 .crinfo。
   安装后：设置页/面板点「更新」→ 浏览器拉起启动器 → node 同步 GitHub 新版 → 热重载。
   重复运行会覆盖旧配置。卸载：删 .native-host.json + 删注册表键。 */
import crypto from 'node:crypto';
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

/* ① 扩展 ID：未打包扩展的 ID 由插件目录路径算出（Chrome: sha256(路径 UTF-16LE) 前 16 字节，每个半字节映射 a..p），
   所以新机器不用手填；.crinfo 里记过就优先用记的（那是从 chrome://extensions 抄来的真实值） */
function deriveId(dir) {
  let real = dir;
  try { real = fs.realpathSync.native(dir); } catch { /* 用原样路径 */ }
  const h = crypto.createHash('sha256').update(Buffer.from(real, 'utf16le')).digest('hex');
  return [...h.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}
const crinfoPath = path.join(extRoot, '.crinfo');
let extId = '';
try { extId = JSON.parse(fs.readFileSync(crinfoPath, 'utf8')).id || ''; } catch { /* 没有 */ }
let derivedId = false;
if (!/^[a-p]{32}$/.test(extId)) {
  extId = deriveId(extRoot);
  derivedId = true;
}
fs.writeFileSync(crinfoPath, JSON.stringify({ id: extId }, null, 2));

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
if (derivedId) {
  console.log('\n扩展 ID 按插件目录推算并写入 .crinfo；若与 chrome://extensions 里显示的不一致，把那里的 ID 填进 .crinfo 后重跑本脚本。');
}

/* 安装后自检：注册表键和清单文件必须都真实存在，否则浏览器根本找不到宿主，
   点「更新」只会报「宿主未安装」。有问题直接报错退出，不让人装完还蒙在鼓里 */
let verifyOk = true;
try {
  const q = execFileSync('reg', ['query', 'HKCU\\' + HOSTS[browser], '/ve'], { encoding: 'utf8', stdio: 'pipe' });
  if (!q.includes(manifestPath)) { console.error('自检失败：注册表里没写对清单路径'); verifyOk = false; }
} catch (e) {
  console.error('自检失败：读不到注册表键 HKCU\\' + HOSTS[browser] + '（' + String(e.message || e).split('\n')[0] + '）');
  verifyOk = false;
}
try {
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (m.path !== exePath || !(m.allowed_origins || []).includes('chrome-extension://' + extId + '/')) {
    console.error('自检失败：宿主清单内容不对（启动器路径或允许来源不匹配）');
    verifyOk = false;
  }
  if (!fs.existsSync(m.path)) { console.error('自检失败：清单指向的启动器不存在：' + m.path); verifyOk = false; }
} catch (e) {
  console.error('自检失败：宿主清单读不出来（' + manifestPath + '）');
  verifyOk = false;
}
if (!verifyOk) process.exit(1);
console.log('自检通过：注册表与宿主清单都已就位。');
console.log('\n最后一步：打开 edge://extensions（开发者模式），核对上面「允许来源」里的 ID 和页面上显示的扩展 ID 是否一致，');
console.log('不一致就把页面上的 ID 写进插件根目录的 .crinfo（{"id":"..."}），重跑本脚本。');
console.log('\n完成。验证：设置页 → 检测更新 → 点「诊断更新」。失败会显示具体错误（重开浏览器后生效）。');
