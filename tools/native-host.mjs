/* Native Messaging bridge. The detached transaction runner survives extension reloads. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXTENSION_ID = process.argv.slice(2).map((arg) => arg.match(/^chrome-extension:\/\/([a-p]{32})\/$/)?.[1]).find(Boolean) || '';
const STATE = path.join(ROOT, '.update-state.json');

function send(obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  process.stdout.write(Buffer.concat([Buffer.from([buf.length & 255, (buf.length >> 8) & 255, (buf.length >> 16) & 255, (buf.length >> 24) & 255]), buf]));
}

function readMessage() {
  return new Promise((resolve) => {
    let pending = Buffer.alloc(0), done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      resolve(value);
    };
    const onData = (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 4) return;
      const size = pending.readUInt32LE(0);
      if (size > 1024 * 1024) return finish(null);
      if (pending.length >= size + 4) {
        try { finish(JSON.parse(pending.subarray(4, size + 4).toString('utf8'))); }
        catch { finish(null); }
      }
    };
    const onEnd = () => finish(null);
    const timer = setTimeout(() => finish(null), 300000);
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
  });
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; }
}

function validTransactionId(value) { return /^[0-9a-f-]{36}$/i.test(value || ''); }
function identityMatches(msg) { return !!EXTENSION_ID && msg?.extensionId === EXTENSION_ID; }

const msg = await readMessage();
if (!msg) {
  send({ ok: false, error: '未收到有效请求' });
  process.exit(1);
}
if (!EXTENSION_ID) {
  send({ ok: false, error: '浏览器未提供有效扩展来源' });
  process.exit(1);
}
if (msg.type === 'ping') {
  let manifestVersion = '';
  try { manifestVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version || ''; } catch { /* 返回空版本，由调用方显示目录错误 */ }
  send({ ok: true, pong: true, node: process.version, root: ROOT, manifestVersion, extensionId: EXTENSION_ID });
  process.exit(0);
}
if (msg.type === 'update_status') {
  const state = readState();
  if (!identityMatches(msg) || state?.extensionId !== EXTENSION_ID || state?.transactionId !== msg.transactionId) {
    send({ ok: false, error: '找不到匹配的更新事务' });
  } else send({ ok: true, state });
  process.exit(0);
}
if (msg.type === 'confirm_update') {
  const state = readState();
  const matches = identityMatches(msg) && state?.extensionId === EXTENSION_ID &&
    state?.transactionId === msg.transactionId && state?.phase === 'awaiting_health' &&
    state?.latest === msg.targetVersion && state?.revision === msg.revision && msg.settingsReady === true;
  if (!matches) {
    send({ ok: false, error: '健康回执与本轮更新不匹配' });
  } else {
    const next = { ...state, phase: 'confirmed', settingsReady: true, confirmedAt: Date.now() };
    const temp = STATE + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(next, null, 2));
    fs.renameSync(temp, STATE);
    send({ ok: true, accepted: true, transactionId: next.transactionId });
  }
  process.exit(0);
}
if (msg.type !== 'run_update' || !identityMatches(msg) || !validTransactionId(msg.transactionId)) {
  send({ ok: false, error: '无效请求或扩展身份不匹配' });
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, 'manifest.json'))) {
  send({ ok: false, error: '插件目录不是有效根目录（缺 manifest.json）：' + ROOT });
  process.exit(1);
}

try {
  const runnerDir = path.join(ROOT, `.update-runner-${msg.transactionId}`);
  fs.mkdirSync(runnerDir, { recursive: true });
  fs.copyFileSync(path.join(HERE, 'autoupdate.mjs'), path.join(runnerDir, 'autoupdate.mjs'));
  fs.copyFileSync(path.join(HERE, 'transaction-runner.mjs'), path.join(runnerDir, 'transaction-runner.mjs'));
  const child = spawn(process.execPath, [path.join(runnerDir, 'transaction-runner.mjs'), ROOT, msg.transactionId, EXTENSION_ID], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  send({ ok: true, started: true, transactionId: msg.transactionId, phase: 'checking' });
} catch (error) {
  send({ ok: false, error: '无法启动独立更新进程：' + String(error.message || error) });
}
