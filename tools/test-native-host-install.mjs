import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { deriveExtensionId, extensionIdFor, nativeHostLauncherSource, nativeHostManifest, nativeHostNames, normalizeRoot } from './native-host-install-core.mjs';

const root = path.join(path.parse(process.cwd()).root, '插件 源码', '作业助手 中文目录');
const otherRoot = path.join(path.parse(process.cwd()).root, '插件 源码', '其他目录');
const id = deriveExtensionId(root);
assert.match(id, /^[a-p]{32}$/);
assert.equal(deriveExtensionId(root), id);
assert.equal(extensionIdFor(root, { id: 'p'.repeat(32), root: otherRoot }), id);
assert.equal(extensionIdFor(root, { id: 'p'.repeat(32) }), id);
assert.equal(extensionIdFor(root, { id: 'p'.repeat(32), root: normalizeRoot(root) }), id);
assert.equal(extensionIdFor(root, { id, root: normalizeRoot(root) }), id);

const names = nativeHostNames(id);
assert.equal(names.current, `com.homeworkhelper.autoupdate.${id}`);
assert.equal(names.legacy, 'com.homeworkhelper.autoupdate');
assert.notEqual(names.current, nativeHostNames(deriveExtensionId(otherRoot)).current);
const manifest = nativeHostManifest({ name: names.current, description: 'test', executable: path.join(root, 'tools', 'native-host.exe'), extensionId: id });
assert.equal(manifest.path, path.join(root, 'tools', 'native-host.exe'));
assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${id}/`]);

console.log('installer path, copied-ID, per-extension host, and origin cases PASS');

const nodeExe = String.raw`C:\Program Files\nodejs\node.exe`;
const launcher = nativeHostLauncherSource(nodeExe);
assert(launcher.includes(String.raw`psi.FileName = @"C:\Program Files\nodejs\node.exe";`));
assert(launcher.includes(String.raw`arg.Replace("\"", "\\\"")`));
if (process.platform === 'win32') {
  const frameworks = ['Framework64', 'Framework'].map((name) => path.join('C:\\Windows\\Microsoft.NET', name));
  const csc = frameworks.flatMap((base) => fs.existsSync(base) ? fs.readdirSync(base).filter((name) => /^v\d/.test(name)).sort().reverse().map((name) => path.join(base, name, 'csc.exe')) : []).find((file) => fs.existsSync(file));
  if (csc) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-native-launcher-test-'));
    try {
      const source = path.join(temp, 'launcher.cs');
      const output = path.join(temp, 'launcher.exe');
      fs.writeFileSync(source, launcher);
      const result = spawnSync(csc, ['/nologo', '/target:exe', '/out:' + output, '/platform:anycpu', source], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert(fs.existsSync(output));
      console.log('generated C# native-host launcher compiles PASS');
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
}
