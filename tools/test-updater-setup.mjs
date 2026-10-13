import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOWNLOADS_PERMISSION,
  EXPECTED_EXTENSION_ID_TOKEN,
  isUpdaterHostReady,
  makeInstallerPayload,
  requestDownloadsPermission,
} from './updater-setup-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const id = 'abcdefghijklmnopabcdefghijklmnop';
const template = fs.readFileSync(path.join(HERE, 'updater-bootstrap.cmd'), 'utf8');
const payload = makeInstallerPayload(template, id);

assert(!payload.includes(EXPECTED_EXTENSION_ID_TOKEN));
assert(payload.includes(`set "HW_EXPECTED_EXTENSION_ID=${id}"`));
assert.match(payload, /FolderBrowserDialog/);
assert.match(payload, /--expected-id=/);
assert.throws(() => makeInstallerPayload(template, 'bad-id'), /扩展 ID 格式无效/);
assert.throws(() => makeInstallerPayload('no placeholder', id), /安装器模板无效/);

const ready = { ok: true, extensionId: id, manifestVersion: '0.6.8' };
assert.equal(isUpdaterHostReady(ready, id, '0.6.8'), true);
assert.equal(isUpdaterHostReady({ ...ready, extensionId: 'p'.repeat(32) }, id, '0.6.8'), false);
assert.equal(isUpdaterHostReady({ ...ready, manifestVersion: '0.6.7' }, id, '0.6.8'), false);
assert.equal(isUpdaterHostReady({ ok: false }, id, '0.6.8'), false);

let asked = null;
assert.equal(await requestDownloadsPermission({ request: async (request) => { asked = request; return true; } }), true);
assert.deepEqual(asked, { permissions: [DOWNLOADS_PERMISSION] });
assert.equal(await requestDownloadsPermission({ request: async () => false }), false);

console.log('updater bootstrap payload, host identity, and optional download permission cases PASS');
