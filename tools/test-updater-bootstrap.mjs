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
