import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TOOLS, '..');
const source = fs.readFileSync(path.join(TOOLS, 'updater-bootstrap.ps1'), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
const script = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source, 'utf8')]);
const encoded = script.toString('base64');
const chunks = encoded.match(/.{1,4000}/g) || [];

function makeCmd(id, version) {
  const lines = [
    '@echo off',
    'setlocal EnableExtensions DisableDelayedExpansion',
    'chcp 65001 >nul',
    `set "HW_EXPECTED_EXTENSION_ID=${id}"`,
    `set "HW_EXPECTED_VERSION=${version}"`,
    'set "HW_BOOTSTRAP_FILE=%TEMP%\\hw-updater-%RANDOM%-%RANDOM%.b64"',
    'set "HW_BOOTSTRAP_SCRIPT=%TEMP%\\hw-updater-%RANDOM%-%RANDOM%.ps1"',
    `> "%HW_BOOTSTRAP_FILE%" echo ${chunks[0]}`,
    ...chunks.slice(1).map((chunk) => `>> "%HW_BOOTSTRAP_FILE%" echo ${chunk}`),
    'if not exist "%HW_BOOTSTRAP_FILE%" goto payload_error',
    'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "[IO.File]::WriteAllBytes($env:HW_BOOTSTRAP_SCRIPT,[Convert]::FromBase64String([IO.File]::ReadAllText($env:HW_BOOTSTRAP_FILE))); & $env:HW_BOOTSTRAP_SCRIPT -ExpectedId ([string]$env:HW_EXPECTED_EXTENSION_ID) -ExpectedVersion ([string]$env:HW_EXPECTED_VERSION); exit $LASTEXITCODE"',
    'set "HW_INSTALL_RESULT=%ERRORLEVEL%"',
    'del "%HW_BOOTSTRAP_FILE%" >nul 2>&1',
    'del "%HW_BOOTSTRAP_SCRIPT%" >nul 2>&1',
    'if "%HW_INSTALL_RESULT%"=="0" goto success',
    'if "%HW_INSTALL_RESULT%"=="2" goto cancelled',
    'echo.',
    'echo 安装失败。请查看上方原因，修复后再重新双击此文件。',
    'goto finish',
    ':success',
    'echo.',
    'echo 安装已完成。请回到 Edge 设置页，页面会自动检查连接。',
    'goto finish',
    ':cancelled',
    'echo.',
    'echo 已取消，没有安装更新组件。',
    'goto finish',
    ':payload_error',
    'set "HW_INSTALL_RESULT=1"',
    'echo 无法准备安装器内容。请重新下载此文件后再试。',
    ':finish',
    'echo.',
    'pause',
    'exit /b %HW_INSTALL_RESULT%',
    '',
  ];
  return lines.join('\r\n');
}

fs.writeFileSync(path.join(TOOLS, 'updater-bootstrap.cmd'), makeCmd('__HW_EXPECTED_EXTENSION_ID__', '__HW_EXPECTED_VERSION__'), 'utf8');
fs.writeFileSync(path.join(ROOT, 'repair-updater.cmd'), makeCmd('', ''), 'utf8');
