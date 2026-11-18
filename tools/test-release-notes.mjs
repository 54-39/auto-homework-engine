import assert from 'node:assert/strict';
import { PENDING_RELEASES, EDGE_RELEASES } from '../options/release-notes.js';

const checkEntries = (entries, label) => {
  assert.ok(Array.isArray(entries), label + ' 必须是数组');
  for (const text of entries) assert.ok(typeof text === 'string' && text.trim(), label + ' 不能有空条目');
};
assert.ok(Array.isArray(PENDING_RELEASES), '小版本记录必须是数组');
assert.ok(Array.isArray(EDGE_RELEASES) && EDGE_RELEASES.length > 0, '已上架记录不能为空');
const seen = new Set();
for (const release of [...PENDING_RELEASES, ...EDGE_RELEASES]) {
  assert.match(release.version, /^\d+\.\d+\.\d+\.\d+$/, '版本号格式不正确：' + release.version);
  assert.ok(!seen.has(release.version), '版本号重复：' + release.version);
  seen.add(release.version);
  checkEntries(release.features, release.version + ' 功能');
  checkEntries(release.fixes, release.version + ' 修复');
}
console.log('Release notes checks passed.');
