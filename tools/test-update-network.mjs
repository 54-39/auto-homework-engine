import assert from 'node:assert/strict';
import { updaterEnvironment } from './updater-network.mjs';

let lookups = 0;
const system = updaterEnvironment({}, {
  platform: 'win32',
  lookupSystemProxy: () => { lookups++; return 'http://127.0.0.1:7890/'; },
});
assert.equal(lookups, 1);
assert.equal(system.NODE_USE_ENV_PROXY, '1');
assert.equal(system.NODE_USE_SYSTEM_CA, '1');
assert.equal(system.HTTPS_PROXY, 'http://127.0.0.1:7890/');
assert.equal(system.HTTP_PROXY, system.HTTPS_PROXY);
assert.equal(system.https_proxy, system.HTTPS_PROXY);

const explicit = updaterEnvironment({ https_proxy: 'http://proxy.example:8080' }, {
  platform: 'win32', lookupSystemProxy: () => { throw new Error('must not replace an explicit proxy'); },
});
assert.equal(explicit.https_proxy, 'http://proxy.example:8080');
assert.equal(explicit.HTTPS_PROXY, 'http://proxy.example:8080');

const direct = updaterEnvironment({}, {
  platform: 'win32', lookupSystemProxy: () => '',
});
assert.equal(direct.NODE_USE_ENV_PROXY, '1');
assert.equal(direct.HTTPS_PROXY, undefined);

let nonWindowsLookup = false;
const otherPlatform = updaterEnvironment({}, {
  platform: 'linux', lookupSystemProxy: () => { nonWindowsLookup = true; return 'http://proxy.example:8080'; },
});
assert.equal(nonWindowsLookup, false);
assert.equal(otherPlatform.HTTPS_PROXY, undefined);

console.log('updater environment/system proxy discovery and Windows CA settings PASS');
