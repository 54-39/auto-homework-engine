/* 打一个「完整离线包」：整个插件目录 + 一份 Node.js 压缩包。
 *
 * 用途：给没网/网络差的电脑用。对方解开这个 zip，里面就是可直接加载的插件目录；
 * 第一次点「运行」→ 双击 install-updater.cmd 时，安装器发现目录里已经有 Node 压缩包，
 * 就地解压，全程不联网。
 *
 * 用法：
 *   node tools/make-offline-bundle.mjs             # 输出到 dist/作业助手-<版本>-完整离线包.zip
 *   node tools/make-offline-bundle.mjs --out <路径>
 *   node tools/make-offline-bundle.mjs --no-node   # 不塞 Node（包很小，装的时候要联网）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const NODE_VERSION = 'v24.21.0';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const BUNDLE_NAME = `node-${NODE_VERSION}-win-${ARCH}.zip`;
const NODE_URL = `https://nodejs.org/download/release/${NODE_VERSION}/node-${NODE_VERSION}-win-${ARCH}.zip`;

/* 不进包的东西：版本控制、本机运行时（Node 已经单独放压缩包了，别再塞一份 90MB）、
 * 安装器自己生成的产物、更新事务的中间状态。 */
const SKIP_DIRS = new Set(['.git', '.native-runtime', 'dist', 'node_modules', 'design-preview']);
const SKIP_FILES = new Set([
  '.crinfo', '.update-state.json', '.update-files.json', 'hot-reload.json',
  'tools/native-host.exe', 'package-lock.json',
]);
const SKIP_PREFIX = ['.native-host', '.update-runner-', '.update-stage', '.build-probe', '.il-probe'];

const args = process.argv.slice(2);
const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : '';
const withNode = !args.includes('--no-node');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;
const outPath = path.resolve(outArg || path.join(ROOT, 'dist', `作业助手-${version}-完整离线包.zip`));
if (fs.existsSync(outPath)) fs.rmSync(outPath, { force: true });
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-offline-bundle-'));
const stageRoot = path.join(stage, `作业助手-${version}`);

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore' && entry.name !== '.gitattributes') continue;
    if (SKIP_PREFIX.some((prefix) => entry.name.startsWith(prefix))) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      copyTree(source, target);
    } else if (!SKIP_FILES.has(entry.name) && !entry.name.endsWith('.download-')) {
      fs.copyFileSync(source, target);
    }
  }
}

function compress(sourceDir, zipPath, level = 'Optimal') {
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Compress-Archive -LiteralPath '${sourceDir}' -DestinationPath '${zipPath}' -CompressionLevel ${level} -Force`],
  { stdio: 'inherit' });
}

try {
  console.log('正在收集插件文件…');
  copyTree(ROOT, stageRoot);

  if (withNode) {
    const target = path.join(stageRoot, BUNDLE_NAME);
    const cached = path.join(ROOT, '.native-runtime', `${NODE_VERSION}-win-${ARCH}`, BUNDLE_NAME);
    if (fs.existsSync(cached)) {
      console.log('复用已有的 Node 压缩包：' + cached);
      fs.copyFileSync(cached, target);
    } else {
      const localNode = path.join(ROOT, '.native-runtime', `${NODE_VERSION}-win-${ARCH}`, 'node.exe');
      if (fs.existsSync(localNode)) {
        console.log('用本机 .native-runtime 里的 node.exe 打包（不打网络）…');
        const nodeStage = path.join(stage, `node-${NODE_VERSION}-win-${ARCH}`);
        fs.mkdirSync(nodeStage, { recursive: true });
        fs.copyFileSync(localNode, path.join(nodeStage, 'node.exe'));
        compress(nodeStage, target, 'Optimal');
        fs.rmSync(nodeStage, { recursive: true, force: true });
      } else {
        console.log('正在下载 Node.js ' + NODE_VERSION + '（' + ARCH + '，约 36 MB）…');
        execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${NODE_URL}' -OutFile '${target}' -UseBasicParsing`],
        { stdio: 'inherit' });
        fs.mkdirSync(path.dirname(cached), { recursive: true });
        fs.copyFileSync(target, cached);
      }
    }
    console.log('Node 压缩包：' + (fs.statSync(target).size / 1048576).toFixed(1) + ' MB');
  } else {
    console.log('按要求不带 Node：安装时需要联网下载。');
  }

  console.log('正在压缩整包…');
  compress(stageRoot, outPath, 'Optimal');
  const size = fs.statSync(outPath).size;
  console.log('\n完成：' + outPath);
  console.log('大小：' + (size / 1048576).toFixed(1) + ' MB');
  console.log('用法：把这个 zip 发给对方，解开后加载「作业助手-' + version + '」目录，' +
    '点设置页「运行」→ 双击里面的 install-updater.cmd' + (withNode ? '（不需要联网）' : ''));
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
