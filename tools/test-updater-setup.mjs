import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOWNLOADS_PERMISSION,
  EXPECTED_EXTENSION_ID_TOKEN,
  EXPECTED_VERSION_TOKEN,
  isUpdaterHostReady,
  makeInstallerPayload,
  requestDownloadsPermission,
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

let asked = null;
assert.equal(await requestDownloadsPermission({ request: async (request) => { asked = request; return true; } }), true);
assert.deepEqual(asked, { permissions: [DOWNLOADS_PERMISSION] });
assert.equal(await requestDownloadsPermission({ request: async () => false }), false);

console.log('updater bootstrap parameters, standalone repair payload, host identity, and optional download permission cases PASS');
