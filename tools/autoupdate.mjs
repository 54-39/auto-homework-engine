/* 下载并校验固定提交，再暂存完整扩展载荷。点击更新时事务由独立进程负责提交与回滚。 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = '54-39/auto-homework-engine';
const API = `https://api.github.com/repos/${REPO}`;
const ATOM = `https://github.com/${REPO}/commits/master.atom`;
const CDN = (rev) => `https://cdn.jsdelivr.net/gh/${REPO}@${rev}/`;
const CDN_LIST = (rev) => `https://data.jsdelivr.com/v1/packages/gh/${REPO}@${rev}?structure=flat`;
const STAGE = '.update-stage';
const LIST = '.update-files.json';
const FETCH_TIMEOUT = 25000;
const DOWNLOAD_LIMIT = 300000;

export const isPayload = (p) =>
  typeof p === 'string' && !p.split('/').includes('..') &&
  (p === 'manifest.json' || p === 'settings.html' || p === 'settings.js' || p === 'install-updater.cmd' || p === 'repair-updater.cmd' ||
    /^(background|content|options|icons|tools)\//.test(p));

export const cmp = (a, b) => {
  const A = String(a).split('.').map(Number), B = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((A[i] || 0) !== (B[i] || 0)) return Math.sign((A[i] || 0) - (B[i] || 0));
  return 0;
};

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
const textOf = (r) => typeof r === 'string' ? r : Buffer.from(r).toString('utf8');

async function request(url, consume, fetchImpl, headers = {}, deadline = Infinity) {
  const controller = new AbortController();
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('本轮下载超过 5 分钟');
  const timer = setTimeout(() => controller.abort(), Math.min(FETCH_TIMEOUT, remaining));
  try {
    const r = await fetchImpl(url, { headers, signal: controller.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await consume(r);
  } catch (e) {
    let host = url;
    try { host = new URL(url).host; } catch { /* Keep the original URL for diagnostics. */ }
    if (e?.name === 'AbortError') throw new Error(`请求超时（${FETCH_TIMEOUT / 1000}s）：${host}`);
    if (/^HTTP \d+/.test(e?.message || '')) throw new Error(`请求 ${host} 失败：${e.message}`, { cause: e });
    const cause = e?.cause;
    const detail = [cause?.code, cause?.message].filter(Boolean).join('：');
    const prefix = e?.name === 'TypeError' && /^fetch failed/i.test(e?.message || '') ? `连接 ${host} 失败` : `请求 ${host} 失败`;
    throw new Error(`${prefix}：${e?.message || e}${detail ? `（${detail}）` : ''}`, { cause: e });
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveRevision({ fetchImpl = fetch } = {}) {
  try {
    const atom = await request(ATOM, (r) => r.text(), fetchImpl);
    const sha = atom.match(/Grit::Commit\/([0-9a-f]{40})/)?.[1];
    if (sha) return sha;
  } catch { /* API ref 仍能给出不可变提交 */ }
  const ref = await request(`${API}/git/ref/heads/master`, (r) => r.json(), fetchImpl, { 'user-agent': 'homework-helper-autoupdate' });
  const sha = ref?.object?.sha;
  if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error('无法锁定更新提交');
  return sha;
}

async function bytesAt(url, fetchImpl, deadline) {
  return request(url, async (r) => Buffer.from(await r.arrayBuffer()), fetchImpl, {}, deadline);
}

async function apiJson(url, fetchImpl, deadline) {
  return request(url, (r) => r.json(), fetchImpl, { 'user-agent': 'homework-helper-autoupdate' }, deadline);
}

async function fileAtRevision(revision, file, fetchImpl, deadline) {
  try { return await bytesAt(CDN(revision) + file, fetchImpl, deadline); }
  catch {
    const encoded = file.split('/').map(encodeURIComponent).join('/');
    const j = await apiJson(`${API}/contents/${encoded}?ref=${revision}`, fetchImpl, deadline);
    if (!j?.content) throw new Error(file + ' 无法从固定提交读取');
    return Buffer.from(j.content.replace(/\s/g, ''), 'base64');
  }
}

function safePath(root, file) {
  if (!isPayload(file)) throw new Error('远端清单包含非法载荷路径：' + file);
  const base = path.resolve(root);
  const dest = path.resolve(base, file);
  if (!dest.startsWith(base + path.sep)) throw new Error('远端清单路径越界：' + file);
  return dest;
}

function hashForEntry(buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

function localFilesFromManifest(root) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    return [
      'manifest.json', 'settings.html', 'settings.js', m.background?.service_worker,
      m.options_page, ...(m.content_scripts || []).flatMap((x) => [...(x.js || []), ...(x.css || [])]),
      ...Object.values(m.icons || {}),
    ].filter((p) => isPayload(p) && fs.existsSync(safePath(root, p)));
  } catch { return ['manifest.json']; }
}

async function fetchSnapshot({ root, fetchImpl, targetRevision, force, log }) {
  const deadline = Date.now() + DOWNLOAD_LIMIT;
  const localManifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const current = localManifest.version;
  const revision = targetRevision || await resolveRevision({ fetchImpl });
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('更新提交 ID 格式无效');

  const manifestBytes = await fileAtRevision(revision, 'manifest.json', fetchImpl, deadline);
  const latest = JSON.parse(manifestBytes.toString('utf8')).version;
  if (!latest) throw new Error('固定提交中的 manifest.json 缺少版本号');
  if (!force && cmp(latest, current) <= 0) return { ok: true, updated: false, current, latest, revision };

  log(`发现新版本 ${current} → ${latest}（提交 ${revision.slice(0, 8)}），下载中…`);
  let files, checksums;
  try {
    const list = await apiJson(CDN_LIST(revision), fetchImpl, deadline);
    const entries = list.files.map((f) => ({ ...f, name: f.name.replace(/^\//, '') })).filter((f) => isPayload(f.name));
    if (entries.some((f) => !/^sha256-?[A-Za-z0-9+/=_-]+$/.test(f.hash || ''))) throw new Error('固定提交的 CDN 清单缺少 SHA-256 摘要');
    files = entries.map((f) => f.name);
    checksums = new Map(entries.map((f) => [f.name, { type: 'sha256', value: f.hash.replace(/^sha256-/, '') }]));
  } catch {
    const tree = await apiJson(`${API}/git/trees/${revision}?recursive=1`, fetchImpl, deadline);
    files = tree.tree.filter((x) => x.type === 'blob' && isPayload(x.path)).map((x) => x.path);
    checksums = new Map(tree.tree.filter((x) => x.type === 'blob').map((x) => [x.path, { type: 'git', value: x.sha }]));
  }
  if (!files.includes('manifest.json')) throw new Error('固定提交的文件清单缺少 manifest.json');

  const stage = path.join(root, STAGE);
  rmrf(stage);
  try {
    for (const file of files) {
      if (Date.now() >= deadline) throw new Error('本轮下载超过 5 分钟');
      const buf = file === 'manifest.json' ? manifestBytes : await fileAtRevision(revision, file, fetchImpl, deadline);
      const expected = checksums.get(file);
      if (expected) {
        const actual = expected.type === 'sha256'
          ? crypto.createHash('sha256').update(buf).digest('base64')
          : hashForEntry(buf);
        if (actual !== expected.value) throw new Error(file + ' 内容校验不符（下载内容不属于固定提交）');
      }
      const dest = safePath(stage, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
    }
  } catch (e) {
    rmrf(stage);
    return { ok: false, updated: false, current, latest, revision, error: String(e.message || e) };
  }

  const stagedManifest = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
  if (stagedManifest.version !== latest) {
    rmrf(stage);
    return { ok: false, updated: false, current, latest, revision, error: `暂存版本 v${stagedManifest.version} 与固定提交版本 v${latest} 不同` };
  }
  const declared = [
    stagedManifest.background?.service_worker, stagedManifest.options_page,
    ...(stagedManifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
    ...Object.values(stagedManifest.icons || {}),
  ].filter(Boolean);
  const missing = declared.filter((p) => !files.includes(p) || !fs.existsSync(safePath(stage, p)));
  if (missing.length) {
    rmrf(stage);
    return { ok: false, updated: false, current, latest, revision, error: `更新文件不完整，缺少 ${missing.join('、')}` };
  }
  return { ok: true, updated: true, current, latest, revision, files, oldFiles: JSON.parse(fs.existsSync(path.join(root, LIST)) ? fs.readFileSync(path.join(root, LIST), 'utf8') : JSON.stringify(localFilesFromManifest(root))) };
}

export async function syncOnce({
  root = process.cwd(), fetchImpl = fetch, log = (m) => console.log('[autoupdate] ' + m),
  targetRevision, force = false, attempt = 1, beforeApply = null, confirmCandidate = async () => true,
} = {}) {
  const localPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(localPath)) throw new Error('当前目录不是插件根目录（缺 manifest.json）');
  let revision = targetRevision || '';
  let snapshot;
  try {
    if (!revision) revision = await resolveRevision({ fetchImpl });
    snapshot = await fetchSnapshot({ root, fetchImpl, targetRevision: revision, force, log });
  }
  catch (e) {
    const current = JSON.parse(fs.readFileSync(localPath, 'utf8')).version;
    return { ok: false, updated: false, current, latest: current, revision, error: String(e.message || e) };
  }
  if (!snapshot.ok || !snapshot.updated) return snapshot;

  const { current, latest, files, oldFiles } = snapshot;
  const transactional = typeof beforeApply === 'function';
  const stage = path.join(root, STAGE);
  const removed = oldFiles.filter((p) => !files.includes(p) && isPayload(p));
  try {
    await beforeApply?.({ current, latest, revision, files, oldFiles, removed, attempt });
    for (const file of files) {
      if (file === 'manifest.json') continue;
      const dest = safePath(root, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(safePath(stage, file), dest);
    }
    fs.copyFileSync(safePath(stage, 'manifest.json'), localPath);
  } catch (e) {
    rmrf(stage);
    return { ok: false, updated: false, current, latest, revision, error: '写入文件失败（可以重来）：' + String(e.message || e) };
  }

  const candidate = { current, latest, revision, files, removed, attempt };
  let confirmed = false;
  try { confirmed = await confirmCandidate(candidate); }
  catch (e) { log('健康确认失败：' + String(e.message || e)); }
  if (!confirmed) {
    rmrf(stage);
    return { ok: false, updated: false, current, latest, revision, healthFailed: true, error: `v${latest} 未通过运行验证` };
  }

  try {
    for (const file of removed) {
      const dest = safePath(root, file);
      if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
    }
    fs.writeFileSync(path.join(root, LIST), JSON.stringify(files, null, 2));
    if (!transactional) fs.writeFileSync(path.join(root, 'hot-reload.json'), JSON.stringify({ t: Date.now() }));
    rmrf(stage);
    log(`已更新并验证到 v${latest}（提交 ${revision.slice(0, 8)}），请刷新作业页面(F5)`);
    return { ok: true, updated: true, current, latest, revision, files, removed };
  } catch (e) {
    rmrf(stage);
    return { ok: false, updated: false, current, latest, revision, error: '提交更新记录失败：' + String(e.message || e) };
  }
}

function writeJson(root, file, value) {
  const dest = path.join(root, file);
  const temp = dest + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, dest);
}

function readJson(root, file) {
  try { return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); }
  catch { return null; }
}

function transactionPath(root, file) {
  if (file === LIST) return path.join(root, LIST);
  return safePath(root, file);
}

async function waitForHealth(root, transactionId, candidate, extensionId, confirmImpl) {
  if (confirmImpl) return !!(await confirmImpl({ transactionId, ...candidate, extensionId }));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const state = readJson(root, '.update-state.json');
    if (state?.phase === 'confirmed' && state.transactionId === transactionId &&
        state.latest === candidate.latest && state.revision === candidate.revision &&
        state.extensionId === extensionId && state.settingsReady === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

function backupBaseline(root, backup, files) {
  fs.mkdirSync(backup, { recursive: true });
  const indexPath = path.join(backup, 'index.json');
  let index = readJson(backup, 'index.json');
  if (!index) {
    index = { files: [] };
    for (const file of [...new Set(files)]) {
      if (!isPayload(file) && file !== LIST) continue;
      const src = transactionPath(root, file);
      const existed = fs.existsSync(src);
      const dest = path.join(backup, 'files', file);
      if (existed) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
      index.files.push({ path: file, existed });
    }
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  }
  return index;
}

function restoreBaseline(root, backup) {
  const index = readJson(backup, 'index.json');
  if (!index) throw new Error('回滚备份不完整，保留目录供恢复');
  for (const file of index.files) {
    const dest = transactionPath(root, file.path);
    if (!file.existed) {
      fs.rmSync(dest, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(backup, 'files', file.path), dest);
  }
}

async function pulseReload(root) {
  const file = path.join(root, 'hot-reload.json');
  const write = () => fs.writeFileSync(file, JSON.stringify({ t: Date.now() }));
  write();
  await new Promise((resolve) => setTimeout(resolve, 2200));
  write();
}

export async function runUpdateTransaction({
  root, transactionId, extensionId, fetchImpl = fetch, confirmImpl, log = (m) => console.log('[update] ' + m),
} = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(transactionId || '') || !/^[a-p]{32}$/.test(extensionId || '')) {
    return { ok: false, phase: 'failed', error: '更新事务身份无效' };
  }
  const stateFile = '.update-state.json';
  const backupName = `.update-backup-${transactionId}`;
  const backup = path.join(root, backupName);
  let baseVersion = '';
  let state = { ok: true, transactionId, extensionId, attempt: 0, phase: 'checking' };
  const save = () => writeJson(root, stateFile, state);
  const confirmCandidate = async (candidate) => {
    state = { ...state, ...candidate, phase: 'awaiting_health', settingsReady: false };
    save();
    await pulseReload(root);
    return waitForHealth(root, transactionId, candidate, extensionId, confirmImpl);
  };
  const beforeApply = ({ files, oldFiles, removed, ...candidate }) => {
    const index = backupBaseline(root, backup, [...files, ...oldFiles, 'settings.html', 'settings.js', LIST]);
    state = { ...state, ...candidate, removed, backup: backupName, backupFiles: index.files.length, phase: 'replacing' };
    save();
  };
  const previous = readJson(root, stateFile);
  if (previous && ['complete', 'failed', 'rolled_back'].includes(previous.phase) && /^[0-9a-f-]{36}$/i.test(previous.transactionId || '')) {
    rmrf(path.join(root, `.update-backup-${previous.transactionId}`));
  }
  if (previous?.phase === 'recovery_required' &&
      (!/^[0-9a-f-]{36}$/i.test(previous.transactionId || '') ||
       !fs.existsSync(path.join(root, `.update-backup-${previous.transactionId}`, 'index.json')))) {
    state = { ok: false, transactionId, extensionId, attempt: 0, phase: 'recovery_required', error: '上一轮旧版备份缺失，不能安全开始新更新' };
    save();
    return state;
  }
  if (previous && !['complete', 'failed', 'rolled_back'].includes(previous.phase)) {
    const previousBackup = /^[0-9a-f-]{36}$/i.test(previous.transactionId || '')
      ? path.join(root, `.update-backup-${previous.transactionId}`) : '';
    if (previousBackup && fs.existsSync(path.join(previousBackup, 'index.json'))) {
      try { restoreBaseline(root, previousBackup); }
      catch (e) { return { ok: false, transactionId, extensionId, phase: 'recovery_required', error: String(e.message || e) }; }
      rmrf(previousBackup);
      rmrf(path.join(root, STAGE));
      await pulseReload(root);
    } else if (previousBackup) {
      rmrf(previousBackup);
    }
  }
  baseVersion = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;
  state = { ...state, current: baseVersion, latest: baseVersion };
  state.phase = 'downloading';
  save();
  try {
    let result = await syncOnce({ root, fetchImpl, log, beforeApply, confirmCandidate });
    if (result.ok && !result.updated) {
      state = { ...state, ...result, phase: 'complete' };
      save();
      return state;
    }
    if (result.ok && result.updated) {
      state = { ...state, ...result, phase: 'complete', settingsReady: true };
      save();
      rmrf(backup);
      return state;
    }
    const revision = result.revision;
    if (!revision) {
      state = { ...state, ...result, phase: 'failed' };
      save();
      return state;
    }
    state = { ...state, phase: 'retrying', attempt: 2, error: result.error };
    save();
    result = await syncOnce({ root, fetchImpl, log, targetRevision: revision, force: true, attempt: 2, beforeApply, confirmCandidate });
    if (result.ok && result.updated) {
      state = { ...state, ...result, phase: 'complete', settingsReady: true };
      save();
      rmrf(backup);
      return state;
    }

    if (fs.existsSync(path.join(backup, 'index.json'))) restoreBaseline(root, backup);
    rmrf(backup);
    rmrf(path.join(root, STAGE));
    state = { ...state, phase: 'rolled_back', error: result.error || '新版连续两次未通过运行验证', latest: baseVersion };
    save();
    await pulseReload(root);
    return state;
  } catch (e) {
    try { if (fs.existsSync(path.join(backup, 'index.json'))) restoreBaseline(root, backup); }
    catch (restoreError) { state.recoveryError = String(restoreError.message || restoreError); }
    rmrf(path.join(root, STAGE));
    state = { ...state, phase: state.recoveryError ? 'recovery_required' : 'failed', error: String(e.message || e) };
    save();
    return state;
  }
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  console.error('[autoupdate] 请从插件内点击「更新」，以便验证新版本后再清理旧文件。');
  process.exitCode = 1;
}
