import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED_EXTENSION_ID_TOKEN,
  EXPECTED_VERSION_TOKEN,
  isUpdaterHostReady,
  makeInstallerPayload,
} from './updater-setup-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const id = 'abcdefghijklmnopabcdefghijklmnop';
const template = fs.readFileSync(path.join(HERE, 'updater-bootstrap.cmd'), 'utf8');
const payload = makeInstallerPayload(template, id, '0.6.9');

assert(!payload.includes(EXPECTED_EXTENSION_ID_TOKEN));
assert(!payload.includes(EXPECTED_VERSION_TOKEN));
assert(payload.includes(`set "HW_EXPECTED_EXTENSION_ID=${id}"`));
assert(payload.includes('set "HW_EXPECTED_VERSION=0.6.9"'));
assert.match(payload, /HW_BOOTSTRAP_FILE/);
assert.match(payload, /HW_BOOTSTRAP_SCRIPT/);
assert.doesNotMatch(payload, /goto invalid/);
assert.throws(() => makeInstallerPayload(template, 'bad-id', '0.6.9'), /扩展 ID 格式无效/);
assert.throws(() => makeInstallerPayload(template, id, '0.6'), /版本号格式无效/);
assert.throws(() => makeInstallerPayload('no placeholder', id, '0.6.9'), /安装器模板无效/);
assert.throws(() => makeInstallerPayload(template.replace('HW_EXPECTED_VERSION=__HW_EXPECTED_VERSION__', 'HW_EXPECTED_VERSION=x'), id, '0.6.9'), /安装器模板无效/);

const generic = fs.readFileSync(path.resolve(HERE, '..', 'repair-updater.cmd'), 'utf8');
assert(generic.includes('set "HW_EXPECTED_EXTENSION_ID="'));
assert(generic.includes('set "HW_EXPECTED_VERSION="'));
assert.match(generic, /powershell\.exe .*HW_BOOTSTRAP_SCRIPT/);

const ready = { ok: true, extensionId: id, manifestVersion: '0.6.9' };
assert.equal(isUpdaterHostReady(ready, id, '0.6.9'), true);
assert.equal(isUpdaterHostReady({ ...ready, extensionId: 'p'.repeat(32) }, id, '0.6.9'), false);
assert.equal(isUpdaterHostReady({ ...ready, manifestVersion: '0.6.8' }, id, '0.6.9'), false);
assert.equal(isUpdaterHostReady({ ok: false }, id, '0.6.9'), false);

const setupCore = fs.readFileSync(path.join(HERE, 'updater-setup-core.mjs'), 'utf8');
assert.doesNotMatch(setupCore, /downloads/);
assert.doesNotMatch(setupCore, /requestDownloadsPermission/);

/* 这个 ps1 必须带 UTF-8 BOM：Windows PowerShell 5.1 没有 BOM 就按 GBK 读，
   里面的中文提示会变成乱码、引号解析也会炸（曾真炸过一次）。 */
const bootstrapBytes = fs.readFileSync(path.join(HERE, 'updater-bootstrap.ps1'));
assert.deepEqual([...bootstrapBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'tools/updater-bootstrap.ps1 丢了 UTF-8 BOM');

const settingsSource = fs.readFileSync(path.resolve(HERE, '..', 'settings.js'), 'utf8');
assert.doesNotMatch(settingsSource, /chrome\.downloads/);
assert.doesNotMatch(settingsSource, /作业助手-更新安装器/);
assert.match(settingsSource, /install-updater\.cmd/);
const manifest = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'manifest.json'), 'utf8'));
assert.equal(manifest.optional_permissions, undefined);

console.log('updater bootstrap parameters, standalone repair payload, host identity, and no-download setup guide cases PASS');
