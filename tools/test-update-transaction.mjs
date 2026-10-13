import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runUpdateTransaction } from './autoupdate.mjs';

const SHA = 'b123456789abcdef0123456789abcdef01234567';
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const BASE = '0.6.6';
const NEXT = '0.6.7';
const files = {
  'manifest.json': JSON.stringify({ version: NEXT, background: { service_worker: 'background/service-worker.js' }, content_scripts: [{ js: ['content/new.js'] }] }),
  'install-updater.cmd': '@echo off\nREM updated installer',
  'background/service-worker.js': 'new worker',
  'content/new.js': 'new content',
  'settings.html': '<html>new</html>',
  'settings.js': 'new settings',
  'tools/autoupdate.mjs': 'new updater',
  'tools/transaction-runner.mjs': 'new runner',
};
const digest = (value) => crypto.createHash('sha256').update(value).digest('base64');
const response = (value) => {
  const bytes = Buffer.from(value);
  return { ok: true, status: 200, text: async () => bytes.toString('utf8'), json: async () => JSON.parse(bytes.toString('utf8')), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
};
const error = (status = 503) => ({ ok: false, status });
function mockFetch({ failPath = '', failCount = 0 } = {}) {
  const requests = [];
  const fetchImpl = async (url) => {
    const value = String(url);
    requests.push(value);
    if (value.includes('commits/master.atom')) return response(`<id>tag:github.com,2008:Grit::Commit/${SHA}</id>`);
    if (value.includes(`data.jsdelivr.com/v1/packages/gh/54-39/auto-homework-engine@${SHA}`)) {
      return response(JSON.stringify({ files: Object.entries(files).map(([name, content]) => ({ name: '/' + name, hash: 'sha256-' + digest(content) })) }));
    }
    const cdnPrefix = `https://cdn.jsdelivr.net/gh/54-39/auto-homework-engine@${SHA}/`;
    if (value.startsWith(cdnPrefix)) {
      const name = value.slice(cdnPrefix.length);
      if (name === failPath && failCount > 0) { failCount--; return error(); }
      return name in files ? response(files[name]) : error(404);
    }
    const apiFile = value.match(/\/contents\/(.+)\?ref=/);
    if (apiFile) {
      const name = decodeURIComponent(apiFile[1]);
      if (name === failPath && failCount > 0) { failCount--; return error(); }
      if (!(name in files)) return error(404);
      return response(JSON.stringify({ content: Buffer.from(files[name]).toString('base64') }));
    }
    return error(404);
  };
  return { fetchImpl, requests, get failuresLeft() { return failCount; } };
}
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-update-tx-'));
  const put = (name, content) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  put('manifest.json', JSON.stringify({ version: BASE, background: { service_worker: 'background/service-worker.js' }, content_scripts: [{ js: ['content/old.js'] }] }));
  put('background/service-worker.js', 'old worker');
  put('content/old.js', 'old content');
  put('tools/autoupdate.mjs', 'old updater');
  put('install-updater.cmd', '@echo off\nREM old installer');
  put('settings.html', '<html>old</html>');
  put('settings.js', 'old settings');
  put('.update-files.json', JSON.stringify(['manifest.json', 'install-updater.cmd', 'background/service-worker.js', 'content/old.js', 'tools/autoupdate.mjs', 'settings.html', 'settings.js']));
  put('.crinfo', JSON.stringify({ id: EXTENSION_ID, root }));
  put('user-config.json', JSON.stringify({ keyName: 'preserved', options: { keep: true } }));
  return root;
}
const tx = () => crypto.randomUUID();
const read = (root, name) => fs.readFileSync(path.join(root, name), 'utf8');
const exists = (root, name) => fs.existsSync(path.join(root, name));
const run = (root, transactionId, fetchImpl, confirmImpl) => runUpdateTransaction({ root, transactionId, extensionId: EXTENSION_ID, fetchImpl, confirmImpl, log: () => {} });

{
  const root = makeRoot(), id = tx(), remote = mockFetch();
  const result = await run(root, id, remote.fetchImpl, async () => true);
  assert.equal(result.phase, 'complete');
  assert.equal(result.updated, true);
  assert.equal(result.latest, NEXT);
  assert.equal(result.downloadedFiles, result.totalFiles);
  assert.equal(result.totalFiles, Object.keys(files).length);
  assert.equal(result.attempt, 1);
  assert.equal(read(root, 'manifest.json'), files['manifest.json']);
  assert.equal(read(root, 'tools/autoupdate.mjs'), 'new updater');
  assert.equal(read(root, 'install-updater.cmd'), files['install-updater.cmd']);
  assert.equal(exists(root, 'content/old.js'), false);
  assert.equal(exists(root, `.update-backup-${id}`), false);
  assert.deepEqual(JSON.parse(read(root, '.crinfo')), { id: EXTENSION_ID, root });
  assert.equal(JSON.parse(read(root, 'user-config.json')).keyName, 'preserved');
  assert(remote.requests.every((u) => !u.includes('@master/')));
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const root = makeRoot(), id = tx(), remote = mockFetch({ failPath: 'content/new.js', failCount: 2 });
  const attempts = [];
  const result = await run(root, id, remote.fetchImpl, async (candidate) => { attempts.push(candidate.attempt); return true; });
  assert.equal(result.phase, 'complete');
  assert.deepEqual(attempts, [2]);
  assert.equal(remote.failuresLeft, 0);
  assert.equal(remote.requests.filter((u) => u.includes('commits/master.atom')).length, 1);
  assert.equal(read(root, 'content/new.js'), 'new content');
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const root = makeRoot(), id = tx(), remote = mockFetch();
  const attempts = [];
  const result = await run(root, id, remote.fetchImpl, async (candidate) => { attempts.push(candidate.attempt); return candidate.attempt === 2; });
  assert.equal(result.phase, 'complete');
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(result.attempt, 2);
  assert.equal(result.downloadedFiles, result.totalFiles);
  assert.equal(result.totalFiles, Object.keys(files).length);
  assert.equal(exists(root, 'content/old.js'), false);
  assert.equal(exists(root, `.update-backup-${id}`), false);
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const root = makeRoot(), id = tx(), remote = mockFetch();
  const attempts = [];
  const result = await run(root, id, remote.fetchImpl, async (candidate) => { attempts.push(candidate.attempt); return false; });
  assert.equal(result.phase, 'rolled_back');
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(JSON.parse(read(root, 'manifest.json')).version, BASE);
  assert.equal(read(root, 'background/service-worker.js'), 'old worker');
  assert.equal(read(root, 'content/old.js'), 'old content');
  assert.equal(exists(root, 'content/new.js'), false);
  assert.equal(read(root, 'tools/autoupdate.mjs'), 'old updater');
  assert.equal(read(root, 'install-updater.cmd'), '@echo off\nREM old installer');
  assert.equal(JSON.parse(read(root, '.update-files.json')).includes('content/old.js'), true);
  assert.equal(exists(root, `.update-backup-${id}`), false);
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const root = makeRoot(), previousId = tx(), id = tx();
  const backup = path.join(root, `.update-backup-${previousId}`);
  fs.mkdirSync(path.join(backup, 'files'), { recursive: true });
  fs.copyFileSync(path.join(root, 'manifest.json'), path.join(backup, 'files', 'manifest.json'));
  fs.mkdirSync(path.join(backup, 'files', 'background'), { recursive: true });
  fs.writeFileSync(path.join(backup, 'files', 'background/service-worker.js'), 'old worker');
  fs.writeFileSync(path.join(backup, 'index.json'), JSON.stringify({ files: [
    { path: 'manifest.json', existed: true },
    { path: 'background/service-worker.js', existed: true },
    { path: 'content/new.js', existed: false },
  ] }));
  fs.writeFileSync(path.join(root, 'manifest.json'), '{broken manifest');
  fs.writeFileSync(path.join(root, 'background/service-worker.js'), 'partial worker');
  fs.writeFileSync(path.join(root, 'content/new.js'), 'partial content');
  fs.writeFileSync(path.join(root, '.update-state.json'), JSON.stringify({ transactionId: previousId, extensionId: EXTENSION_ID, phase: 'recovery_required' }));
  let sawRecovered = false;
  const remote = mockFetch();
  const fetchImpl = async (url) => {
    if (String(url).includes('commits/master.atom')) sawRecovered = JSON.parse(read(root, 'manifest.json')).version === BASE;
    return remote.fetchImpl(url);
  };
  const result = await run(root, id, fetchImpl, async () => true);
  assert.equal(sawRecovered, true);
  assert.equal(result.phase, 'complete');
  assert.equal(result.current, BASE);
  assert.equal(read(root, 'content/new.js'), 'new content');
  assert.equal(exists(root, `.update-backup-${previousId}`), false);
  assert.equal(JSON.parse(read(root, 'user-config.json')).options.keep, true);
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const root = makeRoot(), previousId = tx(), id = tx();
  fs.writeFileSync(path.join(root, 'manifest.json'), '{broken manifest');
  fs.writeFileSync(path.join(root, '.update-state.json'), JSON.stringify({ transactionId: previousId, extensionId: EXTENSION_ID, phase: 'recovery_required' }));
  let contactedRemote = false;
  const result = await run(root, id, async () => { contactedRemote = true; return error(); }, async () => true);
  assert.equal(result.phase, 'recovery_required');
  assert.equal(result.transactionId, id);
  assert.equal(JSON.parse(read(root, '.update-state.json')).transactionId, id);
  assert.equal(contactedRemote, false);
  assert.equal(read(root, 'manifest.json'), '{broken manifest');
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('6 transaction scenarios PASS');
