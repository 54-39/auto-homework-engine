import assert from 'node:assert/strict';
import path from 'node:path';
import { deriveExtensionId, extensionIdFor, nativeHostManifest, nativeHostNames, normalizeRoot } from './native-host-install-core.mjs';

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
