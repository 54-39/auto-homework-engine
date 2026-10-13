import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-native-host-'));
const tools = path.join(root, 'tools');
fs.mkdirSync(tools);
fs.copyFileSync(path.join(source, 'native-host.mjs'), path.join(tools, 'native-host.mjs'));
fs.copyFileSync(path.join(source, 'updater-network.mjs'), path.join(tools, 'updater-network.mjs'));
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ version: '0.6.3' }));
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const transactionId = '12345678-1234-4234-8234-123456789abc';
const stateFile = path.join(root, '.update-state.json');
fs.writeFileSync(stateFile, JSON.stringify({
  ok: true, transactionId, extensionId, latest: '0.6.3', revision: 'a'.repeat(40),
  phase: 'awaiting_health', settingsReady: false,
}));

function invoke(message, callerId = extensionId) {
  const body = Buffer.from(JSON.stringify(message));
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  const result = spawnSync(process.execPath, [path.join(tools, 'native-host.mjs'), `chrome-extension://${callerId}/`], { input: frame, encoding: null, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr?.toString());
  const size = result.stdout.readUInt32LE(0);
  return JSON.parse(result.stdout.subarray(4, size + 4).toString('utf8'));
}

try {
  const ping = invoke({ type: 'ping' });
  assert.equal(ping.ok, true);
  assert.equal(ping.pong, true);
  assert.equal(ping.root, root);
  assert.equal(ping.manifestVersion, '0.6.3');
  assert.equal(ping.extensionId, extensionId);

  assert.equal(invoke({ type: 'update_status', transactionId, extensionId: 'p'.repeat(32) }).ok, false);
  assert.equal(invoke({ type: 'confirm_update', transactionId, extensionId, targetVersion: '0.6.2', revision: 'a'.repeat(40), settingsReady: true }).ok, false);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).phase, 'awaiting_health');
  assert.equal(invoke({ type: 'update_status', transactionId, extensionId }).state.transactionId, transactionId);

  const ack = invoke({ type: 'confirm_update', transactionId, extensionId, targetVersion: '0.6.3', revision: 'a'.repeat(40), settingsReady: true });
  assert.equal(ack.accepted, true);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).phase, 'confirmed');
  assert.equal(invoke({ type: 'ping' }, 'p'.repeat(32)).extensionId, 'p'.repeat(32));
  assert.equal(invoke({ type: 'update_status', transactionId, extensionId }, 'p'.repeat(32)).ok, false);
  console.log('native-host ping, target-root, transaction, version, revision, and caller checks PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
