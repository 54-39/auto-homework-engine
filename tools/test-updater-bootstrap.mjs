import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extensionIdFor } from './native-host-install-core.mjs';
import { makeInstallerPayload } from './updater-setup-core.mjs';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TOOLS, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), '作业助手 更新测试 '));
const cleanup = () => fs.rmSync(temp, { recursive: true, force: true });

function runPowerShell(args, localAppData) {
  const powershell = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(TOOLS, 'updater-bootstrap.ps1'), ...args], {
    encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: localAppData }, timeout: 20000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function runEmbeddedPowerShell(localAppData, expectedId, expectedVersion) {
  const powershell = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encodedFile = path.join(temp, 'embedded-bootstrap.b64');
  const scriptFile = path.join(temp, 'embedded-bootstrap.ps1');
  const bytes = fs.readFileSync(path.join(TOOLS, 'updater-bootstrap.ps1'));
  fs.writeFileSync(encodedFile, bytes.toString('base64'));
  const command = '[IO.File]::WriteAllBytes($env:HW_BOOTSTRAP_SCRIPT,[Convert]::FromBase64String([IO.File]::ReadAllText($env:HW_BOOTSTRAP_FILE))); & $env:HW_BOOTSTRAP_SCRIPT -ExpectedId ([string]$env:HW_EXPECTED_EXTENSION_ID) -ExpectedVersion ([string]$env:HW_EXPECTED_VERSION) -DryRun';
  return spawnSync(powershell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8', env: {
      ...process.env, LOCALAPPDATA: localAppData, HW_BOOTSTRAP_FILE: encodedFile, HW_BOOTSTRAP_SCRIPT: scriptFile,
      HW_EXPECTED_EXTENSION_ID: expectedId, HW_EXPECTED_VERSION: expectedVersion,
    }, timeout: 20000,
  });
}

function makeExtension(folder, version = '0.6.9') {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ name: '作业助手', version }));
  for (const file of ['install-native-host.mjs', 'native-host.mjs', 'native-host-install-core.mjs']) {
    const target = path.join(folder, 'tools', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '// fixture');
  }
  return extensionIdFor(folder);
}

function writePrefs(profile, name, settings) {
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, name), JSON.stringify({ extensions: { settings } }), 'utf8');
}

function findCsc() {
  const bases = ['C:\\Windows\\Microsoft.NET\\Framework64', 'C:\\Windows\\Microsoft.NET\\Framework'];
  return bases.flatMap((base) => fs.existsSync(base)
    ? fs.readdirSync(base).filter((name) => /^v\d/.test(name)).sort().reverse().map((name) => path.join(base, name, 'csc.exe'))
    : []).find((file) => fs.existsSync(file));
}

try {
  const userData = path.join(temp, 'Edge Data', 'Microsoft', 'Edge', 'User Data');
  const defaultProfile = path.join(userData, 'Default');
  const firstRoot = path.join(defaultProfile, 'Extensions', 'unpacked', '作业助手 一');
  const firstId = makeExtension(firstRoot);
  writePrefs(defaultProfile, 'Preferences', { [firstId]: { path: 'unpacked/作业助手 一' } });
  writePrefs(defaultProfile, 'Secure Preferences', { [firstId]: { path: firstRoot } });
  const duplicateProfile = path.join(userData, 'Profile 1');
  writePrefs(duplicateProfile, 'Preferences', { [firstId]: { path: firstRoot } });
  const malformedProfile = path.join(userData, 'Profile 2');
  fs.mkdirSync(malformedProfile, { recursive: true });
  fs.writeFileSync(path.join(malformedProfile, 'Preferences'), '{ malformed json', 'utf8');

  const one = runPowerShell(['-ExpectedVersion', '0.6.9', '-DryRun'], path.join(temp, 'Edge Data'));
  assert.equal(one.status, 0, one.stdout + one.stderr);
  assert.match(one.stdout, /EDGE_CANDIDATES=1/);
  assert.match(one.stdout, new RegExp(firstId));
  assert(one.stdout.includes(firstRoot));
  assert(!fs.existsSync(path.join(firstRoot, '.native-runtime')));
  const rootEntry = runPowerShell(['-Root', firstRoot, '-ExpectedId', firstId, '-ExpectedVersion', '0.6.9', '-DryRun'], path.join(temp, 'Edge Data'));
  assert.equal(rootEntry.status, 0, rootEntry.stdout + rootEntry.stderr);
  assert(rootEntry.stdout.includes(firstRoot));

  const secondRoot = path.join(malformedProfile, 'Extensions', 'unpacked', '作业助手 二');
  const secondId = makeExtension(secondRoot);
  writePrefs(malformedProfile, 'Secure Preferences', { [secondId]: { path: path.join('unpacked', '作业助手 二') } });
  const conflict = runPowerShell(['-ExpectedVersion', '0.6.9', '-DryRun'], path.join(temp, 'Edge Data'));
  assert.equal(conflict.status, 0, conflict.stdout + conflict.stderr);
  assert.match(conflict.stdout, /EDGE_CANDIDATES=2/);
  const selectedById = runPowerShell(['-ExpectedId', secondId, '-ExpectedVersion', '0.6.9', '-DryRun'], path.join(temp, 'Edge Data'));
  assert.equal(selectedById.status, 0, selectedById.stdout + selectedById.stderr);
  assert.match(selectedById.stdout, /EDGE_CANDIDATES=1/);
  assert.match(selectedById.stdout, new RegExp(secondId));
  const embeddedGeneric = runEmbeddedPowerShell(path.join(temp, 'Edge Data'), '', '0.6.9');
  assert.equal(embeddedGeneric.status, 0, embeddedGeneric.stdout + embeddedGeneric.stderr);
  assert.match(embeddedGeneric.stdout, /EDGE_CANDIDATES=2/);
  const embeddedBound = runEmbeddedPowerShell(path.join(temp, 'Edge Data'), secondId, '0.6.9');
  assert.equal(embeddedBound.status, 0, embeddedBound.stdout + embeddedBound.stderr);
  assert.match(embeddedBound.stdout, /EDGE_CANDIDATES=1/);
  const wrongVersion = runPowerShell(['-ExpectedVersion', '0.6.8', '-DryRun'], path.join(temp, 'Edge Data'));
  assert.equal(wrongVersion.status, 0, wrongVersion.stdout + wrongVersion.stderr);
  assert.match(wrongVersion.stdout, /EDGE_CANDIDATES=0/);
  const wrongRoot = runPowerShell(['-Root', secondRoot, '-ExpectedId', firstId, '-ExpectedVersion', '0.6.9'], path.join(temp, 'Edge Data'));
  assert.equal(wrongRoot.status, 1, wrongRoot.stdout + wrongRoot.stderr);
  assert.match(wrongRoot.stdout + wrongRoot.stderr, /不是匹配版本/);
  assert(!fs.existsSync(path.join(secondRoot, '.native-runtime')));
  console.log('Edge Preferences/Secure Preferences discovery, relative paths, duplicate roots, conflicts, damaged JSON, version and ID rejection PASS');

  /* ---- 完整离线包：插件目录里带了 node 压缩包时，必须不联网直接解压使用 ----
     用本机已验证的那份 node.exe 造包；没有就跳过（不联网拉 93 MB）。 */
  const realNode = path.join(ROOT, '.native-runtime', 'v24.21.0-win-x64', 'node.exe');
  if (process.arch === 'x64' && fs.existsSync(realNode)) {
    const bundleStage = path.join(temp, 'node-v24.21.0-win-x64');
    fs.mkdirSync(bundleStage, { recursive: true });
    fs.copyFileSync(realNode, path.join(bundleStage, 'node.exe'));
    const bundleZip = path.join(temp, 'node-v24.21.0-win-x64.zip');
    const zipped = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Compress-Archive -LiteralPath '${bundleStage}' -DestinationPath '${bundleZip}' -CompressionLevel NoCompression -Force`],
    { encoding: 'utf8', timeout: 120000 });
    assert.equal(zipped.status, 0, zipped.stdout + zipped.stderr);

    const offlineRoot = path.join(temp, 'Edge Data', '离线包插件目录');
    const offlineId = makeExtension(offlineRoot);
    fs.copyFileSync(bundleZip, path.join(offlineRoot, 'node-v24.21.0-win-x64.zip'));
    const offline = runPowerShell(['-Root', offlineRoot, '-ExpectedId', offlineId, '-ExpectedVersion', '0.6.9'], path.join(temp, 'Edge Data'));
    assert.equal(offline.status, 0, offline.stdout + offline.stderr);
    assert.match(offline.stdout, /发现离线 Node.js 压缩包/);
    assert.match(offline.stdout, /安装命令已完成/);
    assert(!/正在下载并校验/.test(offline.stdout), '带了离线包就不该联网下载');
    const unpacked = path.join(offlineRoot, '.native-runtime', 'v24.21.0-win-x64', 'node.exe');
    assert(fs.existsSync(unpacked), '离线包应解出 .native-runtime/node.exe');
    assert.equal(fs.statSync(unpacked).size, fs.statSync(realNode).size);

    /* 压缩包是坏的时不能直接失败退出，要打印原因再回落到在线下载。 */
    const badRoot = path.join(temp, 'Edge Data', '坏包插件目录');
    const badId = makeExtension(badRoot);
    fs.writeFileSync(path.join(badRoot, 'node-v24.21.0-win-x64.zip'), 'not a zip at all', 'utf8');
    // 这一步故意掐断（不掐断就会真去下载 93MB）。机器忙时 PowerShell 还没打印就被掐掉，
    // 管道里拿到的 stdout 会是空的——空输出算这次没测到，重跑，最多三次。
    let bad = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      bad = spawnSync(path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(TOOLS, 'updater-bootstrap.ps1'),
          '-Root', badRoot, '-ExpectedId', badId, '-ExpectedVersion', '0.6.9'],
        { encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: path.join(temp, 'Edge Data') }, timeout: 4000 });
      if (bad.stdout && /离线压缩包不可用/.test(bad.stdout) && /正在下载并校验/.test(bad.stdout)) break;
    }
    assert.match(bad.stdout, /离线压缩包不可用/);
    assert.match(bad.stdout, /正在下载并校验/);
    console.log('Offline Node bundle is unpacked without network; a broken bundle falls back to download PASS');
  } else {
    console.log('Offline Node bundle check SKIPPED (需要本机 .native-runtime 里的 x64 node.exe)');
  }

  const csc = findCsc();
  assert(csc, 'Windows .NET Framework csc.exe is required to exercise the generated CMD entry points');
  const shimDir = path.join(temp, 'PowerShell Shim');
  const cmdTemp = path.join(temp, '临时 CMD 文件');
  const noNodePath = [shimDir, path.join(process.env.WINDIR || 'C:\\Windows', 'System32'), process.env.WINDIR || 'C:\\Windows'].join(';');
  fs.mkdirSync(shimDir);
  fs.mkdirSync(cmdTemp);
  const shimSource = path.join(temp, 'powershell-shim.cs');
  const shimExe = path.join(shimDir, 'powershell.exe');
  const logFile = path.join(temp, 'powershell-args.log');
  fs.writeFileSync(shimSource, 'using System; using System.IO; class Shim { static int Main() { File.WriteAllText(Environment.GetEnvironmentVariable("HW_TEST_LOG"), Environment.CommandLine); return int.Parse(Environment.GetEnvironmentVariable("HW_TEST_EXIT_CODE")); } }');
  const compiled = spawnSync(csc, ['/nologo', '/target:exe', '/out:' + shimExe, shimSource], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const rootCommand = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'install-updater.cmd'], {
    cwd: ROOT, input: '\r\n', encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PATH: noNodePath, TEMP: cmdTemp, TMP: cmdTemp, HW_TEST_EXIT_CODE: '0', HW_TEST_LOG: logFile },
  });
  assert.equal(rootCommand.status, 0, rootCommand.stdout + rootCommand.stderr);
  assert.match(rootCommand.stdout, /安装已完成/);
  assert.match(fs.readFileSync(logFile, 'utf8'), /updater-bootstrap\.ps1.*-Root/);
  const command = makeInstallerPayload(fs.readFileSync(path.join(TOOLS, 'updater-bootstrap.cmd'), 'utf8'), firstId, '0.6.9');
  assert.doesNotMatch(command, /^\s*node(?:\.exe)?\b/im);
  for (const cmdFile of [path.join(TOOLS, 'updater-bootstrap.cmd'), path.join(ROOT, 'repair-updater.cmd')]) {
    const lines = fs.readFileSync(cmdFile, 'utf8').split(/\r?\n/);
    const chunks = lines.filter((line) => /^>{1,2} "%HW_BOOTSTRAP_FILE%" echo /.test(line)).map((line) => line.slice(line.indexOf(' echo ') + 6));
    assert(chunks.length > 0);
    const source = fs.readFileSync(path.join(TOOLS, 'updater-bootstrap.ps1'), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const expected = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source, 'utf8')]);
    assert(Buffer.from(chunks.join(''), 'base64').equals(expected));
  }
  fs.writeFileSync(path.join(temp, 'setup.cmd'), command, 'utf8');
  const lfCommand = makeInstallerPayload(fs.readFileSync(path.join(TOOLS, 'updater-bootstrap.cmd'), 'utf8').replace(/\r\n/g, '\n'), firstId, '0.6.9');
  assert.match(lfCommand, /\r\n/);
  assert.doesNotMatch(lfCommand, /(?<!\r)\n/);
  fs.writeFileSync(path.join(temp, 'setup-lf.cmd'), lfCommand, 'utf8');
  const lfResult = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'setup-lf.cmd'], {
    cwd: temp, input: '\r\n', encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PATH: noNodePath, TEMP: cmdTemp, TMP: cmdTemp, HW_TEST_EXIT_CODE: '0', HW_TEST_LOG: logFile },
  });
  assert.equal(lfResult.status, 0, lfResult.stdout + lfResult.stderr);
  assert.match(lfResult.stdout, /安装已完成/);
  for (const [code, label] of [[0, '安装已完成'], [2, '已取消'], [7, '安装失败']]) {
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'setup.cmd'], {
      cwd: temp, input: '\r\n', encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PATH: noNodePath, TEMP: cmdTemp, TMP: cmdTemp, HW_TEST_EXIT_CODE: String(code), HW_TEST_LOG: logFile },
    });
    assert.equal(result.status, code, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(label));
    assert.match(fs.readFileSync(logFile, 'utf8'), /HW_BOOTSTRAP_SCRIPT/);
    assert.match(command, new RegExp(firstId));
  }
  assert.deepEqual(fs.readdirSync(cmdTemp), []);
  console.log('Generated CMD success, cancel and failure branches execute; temporary payload cleanup PASS');
} finally { cleanup(); }
