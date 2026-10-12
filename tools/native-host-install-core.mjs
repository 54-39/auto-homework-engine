import crypto from 'node:crypto';
import path from 'node:path';

const BASE = 'com.homeworkhelper.autoupdate';

export function normalizeRoot(root) {
  const resolved = path.resolve(root);
  return process.platform === 'win32'
    ? resolved.replace(/^([a-z]):/, (_, drive) => drive.toUpperCase() + ':')
    : resolved;
}

export function deriveExtensionId(root) {
  const canonical = normalizeRoot(root);
  const hash = crypto.createHash('sha256').update(Buffer.from(canonical, 'utf16le')).digest('hex').slice(0, 32);
  return [...hash].map((ch) => String.fromCharCode(97 + parseInt(ch, 16))).join('');
}

export function extensionIdFor(root) {
  return deriveExtensionId(root);
}

export function nativeHostNames(extensionId) {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('扩展 ID 格式无效');
  return { current: `${BASE}.${extensionId}`, legacy: BASE };
}

export function nativeHostManifest({ name, description, executable, extensionId }) {
  return {
    name,
    description,
    path: executable,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

export function nativeHostLauncherSource(nodeExe) {
  if (typeof nodeExe !== 'string' || !nodeExe || nodeExe.includes('"')) throw new Error('Node.js 路径无效');
  return String.raw`
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
    psi.FileName = @"${nodeExe}";
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
}
