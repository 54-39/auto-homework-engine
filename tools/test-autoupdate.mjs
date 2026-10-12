/* 本地测试（不入库）：node tools/test-autoupdate.mjs
   mock fetch + 临时目录模拟远端仓库，验证自动更新流程：无更新不动 / 下载失败放弃 / 成功替换+删旧+热重载标记 / 文件树接口失败回退清单 / 源全挂。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { syncOnce, cmp, isPayload } from './autoupdate.mjs';

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name); }
};

const CDN_BASE = 'https://cdn.jsdelivr.net/gh/54-39/auto-homework-engine@master/';
const CDN = (rev) => `https://cdn.jsdelivr.net/gh/54-39/auto-homework-engine@${rev}/`;
const DEFAULT_SHA = 'c1d2e3f40516273849abcdef0123456789abcdef';

function mkRoot(version, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-au-'));
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ version }));
  for (const [p, buf] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), buf);
  }
  return root;
}

/* mock fetch：version=远端版本，files=远端文件映射，failPath=强制失败的文件，treeFail=文件树接口失败，
   atomRev=给出提交订阅源里的 sha（设了才会走「钉住 commit」那条路），pinListFail=钉住 sha 的 jsDelivr
   清单接口 404（新 sha 的冷启动，此时应改用同一个 sha 的 GitHub 文件树，而不是退回 @master 清单）。 */
function mockFetch({ version, files, failPath, treeFail, atomRev = DEFAULT_SHA, pinListFail }) {
  const res = (body) => ({
    ok: true, status: 200,
    json: async () => JSON.parse(body),
    text: async () => (typeof body === 'string' ? body : Buffer.from(body).toString('utf8')),
    arrayBuffer: async () => (typeof body === 'string'
      ? new TextEncoder().encode(body).buffer.slice(0)
      : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
  });
  const err = (code) => ({ ok: false, status: code });
  const hash = (p) => crypto.createHash('sha256').update(files[p]).digest('base64'); // 与钉住清单里的 hash 同义
  const gitBlob = (p) => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(files[p])}\0`).update(files[p]).digest('hex');
  return async (url) => {
    const u = String(url);
    if (u.includes('commits/master.atom')) {
      return atomRev ? res(`<id>tag:github.com,2008:Grit::Commit/${atomRev}</id>`) : err(404);
    }
    if (atomRev && u.includes('data.jsdelivr.com') && u.includes('@' + atomRev)) {
      if (pinListFail) return err(404);
      return res(JSON.stringify({ files: Object.keys(files).map((p) => ({ name: '/' + p, hash: 'sha256-' + hash(p) })) }));
    }
    if (atomRev && u.includes('/git/trees/' + atomRev)) {
      return treeFail ? err(500) : res(JSON.stringify({ tree: [...Object.keys(files).map((p) => ({ type: 'blob', path: p, sha: gitBlob(p) })), { type: 'blob', path: 'README.md', sha: '0'.repeat(40) }, { type: 'blob', path: 'PRIVACY.md', sha: '1'.repeat(40) }] }));
    }
    if (atomRev && u.startsWith(CDN(atomRev))) {
      const p = u.slice(CDN(atomRev).length);
      return p === failPath || !(p in files) ? err(404) : res(files[p]);
    }
    if (u.includes('/contents/manifest.json')) {
      const mf = JSON.stringify({ version });
      return u.includes('api.github.com') ? res(JSON.stringify({ content: Buffer.from(mf).toString('base64') })) : res(mf);
    }
    if (u.includes('/git/trees/master')) {
      return treeFail ? err(500) : res(JSON.stringify({ tree: [...Object.keys(files).map((p) => ({ type: 'blob', path: p, sha: gitBlob(p) }))] }));
    }
    const m = u.match(/\/contents\/(.+)\?ref=master$/);
    if (m) {
      const p = decodeURIComponent(m[1]);
      if (p === failPath) return err(500);
      if (!(p in files)) return err(404);
      return res(JSON.stringify({ content: Buffer.from(files[p]).toString('base64') }));
    }
    if (u.startsWith(CDN_BASE)) {
      const p = u.slice(CDN_BASE.length);
      if (p === failPath || !(p in files)) return err(404);
      return res(files[p]);
    }
    return err(404);
  };
}

const read = (root, p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (root, p) => fs.existsSync(path.join(root, p));
const noop = () => {};

/* 1. 版本比较 */
t('cmp 0.4.8 < 0.5.0', cmp('0.4.8', '0.5.0') < 0);
t('cmp 0.10.0 > 0.9.0', cmp('0.10.0', '0.9.0') > 0);
t('cmp 0.4.8 < 0.4.11', cmp('0.4.8', '0.4.11') < 0);
t('cmp 相等', cmp('0.5.0', '0.5.0') === 0);

/* 2. 载荷过滤 */
for (const p of ['manifest.json', 'settings.html', 'settings.js', 'background/service-worker.js', 'content/homework/panel.js', 'options/options.js', 'icons/icon16.png', 'tools/autoupdate.mjs', 'tools/native-host.mjs', 'tools/install-native-host.mjs']) {
  t('载荷包含 ' + p, isPayload(p));
}
for (const p of ['README.md', 'LICENSE', 'package.json', '.update-files.json', 'hot-reload.json', 'PRIVACY.md']) {
  t('非载荷排除 ' + p, !isPayload(p));
}

/* 3. 无更新：远端版本 <= 本地 → 不动任何文件 */
{
  const root = mkRoot('0.5.0');
  const r = await syncOnce({ root, fetchImpl: mockFetch({ version: '0.5.0', files: {} }), log: noop });
  t('无更新返回 updated:false', r.ok && r.updated === false);
  t('无更新不写清单', !exists(root, '.update-files.json'));
  t('无更新不写热重载', !exists(root, 'hot-reload.json'));
}

/* 4. 更新成功：覆盖/新增/删旧 + 热重载标记 + 清单回写 */
{
  const root = mkRoot('0.4.8', {
    'background/engines/api-engine.js': 'OLD',
    'background/engines/old-engine.js': 'OLD',
    'README.md': 'keep me',
    '.update-files.json': JSON.stringify(['manifest.json', 'background/engines/old-engine.js']),
  });
  const remote = {
    'manifest.json': JSON.stringify({ version: '0.5.0' }),
    'background/engines/api-engine.js': 'NEW-API',
    'content/homework/new.js': 'NEW-FILE',
    'icons/icon16.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
  };
  const r = await syncOnce({ root, fetchImpl: mockFetch({ version: '0.5.0', files: remote }), log: noop });
  t('成功返回 updated:true', r.ok && r.updated === true && r.latest === '0.5.0');
  t('manifest 已覆盖', JSON.parse(read(root, 'manifest.json')).version === '0.5.0');
  t('已有文件内容被替换', read(root, 'background/engines/api-engine.js') === 'NEW-API');
  t('新增文件已写入', read(root, 'content/homework/new.js') === 'NEW-FILE');
  t('远端已删除的载荷文件被删', !exists(root, 'background/engines/old-engine.js'));
  t('非载荷文件不动', read(root, 'README.md') === 'keep me');
  t('二进制文件字节一致', fs.readFileSync(path.join(root, 'icons/icon16.png')).equals(remote['icons/icon16.png']));
  t('清单回写为新列表', JSON.parse(read(root, '.update-files.json')).join() === Object.keys(remote).join());
  t('写热重载标记', exists(root, 'hot-reload.json') && JSON.parse(read(root, 'hot-reload.json')).t > 0);
  t('暂存目录已清理', !exists(root, '.update-stage'));
}

/* 5. 下载失败：整轮放弃、旧文件原封不动、暂存清理 */
{
  const root = mkRoot('0.4.8', {
    'background/engines/api-engine.js': 'OLD',
    '.update-files.json': JSON.stringify(['manifest.json', 'background/engines/api-engine.js']),
  });
  const remote = { 'manifest.json': JSON.stringify({ version: '0.5.0' }), 'background/engines/api-engine.js': 'NEW', 'content/homework/new.js': 'NEW-FILE' };
  const r = await syncOnce({ root, fetchImpl: mockFetch({ version: '0.5.0', files: remote, failPath: 'content/homework/new.js' }), log: noop });
  t('失败返回 ok:false', r.ok === false && r.updated === false);
  t('旧 manifest 未被覆盖', JSON.parse(read(root, 'manifest.json')).version === '0.4.8');
  t('旧文件内容不变', read(root, 'background/engines/api-engine.js') === 'OLD');
  t('失败不写热重载', !exists(root, 'hot-reload.json'));
  t('暂存目录已清理', !exists(root, '.update-stage'));
}

/* 6. 文件树接口失败：回退上次清单继续更新 */
{
  const root = mkRoot('0.4.8', {
    'background/engines/api-engine.js': 'OLD',
    '.update-files.json': JSON.stringify(['manifest.json', 'background/engines/api-engine.js']),
  });
  const remote = { 'manifest.json': JSON.stringify({ version: '0.5.0' }), 'background/engines/api-engine.js': 'NEW' };
  const r = await syncOnce({ root, fetchImpl: mockFetch({ version: '0.5.0', files: remote, treeFail: true }), log: noop });
  t('回退清单仍更新成功', r.ok && r.updated === true);
  t('清单内文件被刷新', read(root, 'background/engines/api-engine.js') === 'NEW');
}

/* 7. 两个源都取不到 manifest：返回 ok:false 不崩溃 */
{
  const root = mkRoot('0.4.8');
  const r = await syncOnce({ root, fetchImpl: async () => ({ ok: false, status: 403 }), log: noop }).catch((e) => ({ ok: false, error: String(e.message || e) }));
  t('源全挂返回 ok:false', r.ok === false);
}

/* 8. 无更新路径不触碰网络文件树（ 远端同版本 → updated:false，不请求 trees） */
{
  let treeHits = 0;
  const f = mockFetch({ version: '0.5.0', files: {} });
  const root = mkRoot('0.5.0');
  const r = await syncOnce({ root, fetchImpl: async (u) => { if (String(u).includes('/git/trees/')) treeHits++; return f(u); }, log: noop });
  t('无更新不拉文件树', r.ok && r.updated === false && treeHits === 0);
}

/* 9. CLI 直跑：指定一个非插件目录应报错退出（exitCode 1） */
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-au-empty-'));
  const { spawnSync } = await import('node:child_process');
  const self = url.fileURLToPath(import.meta.url); // 同目录的 autoupdate.mjs
  const p = spawnSync(process.execPath, [path.join(path.dirname(self), 'autoupdate.mjs'), empty], { encoding: 'utf8' });
  t('CLI 禁止绕过事务', p.status === 1 && /点击/.test(p.stderr));
}

/* 10. 新机器首次更新 + api.github.com 连不上：走 jsDelivr 文件清单，不依赖本地清单 */
{
  const root = mkRoot('0.4.8'); // 注意：没有 .update-files.json
  const remote = { 'manifest.json': JSON.stringify({ version: '0.5.0' }), 'background/engines/api-engine.js': 'NEW' };
  const base = mockFetch({ version: '0.5.0', files: remote });
  let apiHits = 0;
  const r = await syncOnce({
    root,
    fetchImpl: async (u) => {
      const s = String(u);
      if (s.includes('api.github.com')) { apiHits++; throw new Error('fetch failed'); } // 模拟大陆网络连不上 API
      if (s.includes('data.jsdelivr.com')) {
        return { ok: true, status: 200, json: async () => ({ files: Object.keys(remote).map((p) => ({ name: '/' + p, hash: 'sha256-' + crypto.createHash('sha256').update(remote[p]).digest('base64') })) }) };
      }
      return base(u);
    },
    log: noop,
  });
  t('固定提交的 CDN 清单可更新', r.ok && r.updated === true);
  t('CDN 清单内的文件已刷新', read(root, 'background/engines/api-engine.js') === 'NEW');
  t('固定提交更新不依赖 GitHub API', apiHits === 0);
}

/* 11. API 配额状态不影响固定提交，也不会混入 @master 文件 */
{
  const root = mkRoot('0.4.8', { 'background/engines/api-engine.js': 'OLD' });
  const remote = { 'manifest.json': JSON.stringify({ version: '0.5.0' }), 'background/engines/api-engine.js': 'NEW' };
  const base = mockFetch({ version: '0.5.0', files: remote });
  let cdnHits = 0;
  const r = await syncOnce({
    root,
    fetchImpl: async (u) => {
      const s = String(u);
      if (s.startsWith(CDN_BASE)) cdnHits++;
      if (s.includes('api.github.com') && s.includes('/contents/background/')) return { ok: false, status: 403 }; // 配额中途用尽
      return base(u);
    },
    log: noop,
  });
  t('API 配额状态下仍按固定提交完成更新', r.ok && r.updated === true);
  t('不访问浮动 @master 文件', cdnHits === 0);
  t('文件来自被锁定的提交', read(root, 'background/engines/api-engine.js') === 'NEW');
  t('固定提交成功写热重载', exists(root, 'hot-reload.json'));
  t('暂存目录成功后已清理', !exists(root, '.update-stage'));
}

/* 12. 固定提交里的下载字节与摘要不符：整轮拒绝 */
{
  const root = mkRoot('0.4.8');
  const remote = { 'manifest.json': JSON.stringify({ version: '0.5.0' }), 'background/engines/api-engine.js': 'NEW' };
  const base = mockFetch({ version: '0.5.0', files: remote });
  const r = await syncOnce({
    root,
    fetchImpl: async (u) => {
      const s = String(u);
      if (s === CDN(DEFAULT_SHA) + 'background/engines/api-engine.js') {
        const bytes = new TextEncoder().encode('STALE');
        return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
      }
      return base(u);
    },
    log: noop,
  });
  t('摘要不符 → 放弃安装', r.ok === false && r.updated === false && /内容校验不符/.test(r.error));
  t('摘要不符不写热重载', !exists(root, 'hot-reload.json'));
  t('摘要不符不写清单', !exists(root, '.update-files.json'));
  t('摘要不符后暂存目录已清理', !exists(root, '.update-stage'));
}

/* 13. 固定提交清单缺少 manifest 声明脚本：拒绝不完整扩展 */
{
  const mf = JSON.stringify({ version: '0.5.3', content_scripts: [{ js: ['content/homework/extractor.js', 'content/homework/dropdown.js'] }] });
  const root = mkRoot('0.5.2');
  const remote = { 'manifest.json': mf, 'content/homework/extractor.js': 'EX' };
  const r = await syncOnce({ root, fetchImpl: mockFetch({ version: '0.5.3', files: remote }), log: noop });
  t('缺新增脚本 → 放弃安装', r.ok === false && r.updated === false && /不完整/.test(r.error));
  t('缺脚本不写热重载', !exists(root, 'hot-reload.json'));
  t('缺脚本不写清单', !exists(root, '.update-files.json'));
  t('缺脚本后暂存目录已清理', !exists(root, '.update-stage'));
}

/* 14. 钉住 master 的 commit：版本、清单、文件出自同一个不可变快照，不碰 API 配额 */
{
  const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const root = mkRoot('0.4.8', { 'background/engines/api-engine.js': 'OLD' });
  const remote = {
    'manifest.json': JSON.stringify({ version: '0.5.0', background: { service_worker: 'background/service-worker.js' }, content_scripts: [{ js: ['content/homework/panel.js'] }] }),
    'background/service-worker.js': 'SW',
    'content/homework/panel.js': 'PANEL',
    'background/engines/api-engine.js': 'NEW',
  };
  const base = mockFetch({ version: '0.5.0', files: remote, atomRev: sha });
  let apiHits = 0, masterHits = 0;
  const r = await syncOnce({
    root,
    fetchImpl: async (u) => {
      const s = String(u);
      if (s.includes('api.github.com')) apiHits++;
      if (s.startsWith(CDN_BASE)) masterHits++;
      return base(u);
    },
    log: noop,
  });
  t('钉住 commit 后能正常更新', r.ok && r.updated === true && r.latest === '0.5.0');
  t('钉住后文件来自那个快照', read(root, 'background/engines/api-engine.js') === 'NEW' && read(root, 'background/service-worker.js') === 'SW');
  t('钉住后完全不碰 GitHub API 配额', apiHits === 0);
  t('钉住后不回落到 @master', masterHits === 0);
  t('钉住后写清单', exists(root, '.update-files.json'));
}

/* 15. 钉住快照里某个文件字节对不上清单摘要（CDN 串了版本）→ 整轮放弃 */
{
  const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const root = mkRoot('0.4.8', { 'background/engines/api-engine.js': 'OLD' });
  const remote = {
    'manifest.json': JSON.stringify({ version: '0.5.0' }),
    'background/engines/api-engine.js': 'NEW',
  };
  const base = mockFetch({ version: '0.5.0', files: remote, atomRev: sha });
  const r = await syncOnce({
    root,
    fetchImpl: async (u) => {
      const s = String(u);
      if (s === CDN(sha) + 'background/engines/api-engine.js') {
        const e = new TextEncoder().encode('STALE-BYTE');
        return { ok: true, status: 200, arrayBuffer: async () => e.buffer.slice(e.byteOffset, e.byteOffset + e.byteLength) };
      }
      return base(u);
    },
    log: noop,
  });
  t('内容与清单摘要不符 → 整轮放弃', r.ok === false && r.updated === false && /内容校验不符/.test(r.error));
  t('校验不符时旧文件不动', read(root, 'background/engines/api-engine.js') === 'OLD');
  t('校验不符不写热重载', !exists(root, 'hot-reload.json'));
  t('校验不符不写清单', !exists(root, '.update-files.json'));
  t('校验不符后暂存目录已清理', !exists(root, '.update-stage'));
}

/* 16. tools/ 随更新一起更新：更新脚本自己也换新，本机私有文件与本机测试脚本不受影响 */
{
  const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const root = mkRoot('0.4.8', {
    'tools/autoupdate.mjs': 'OLD-UPDATER',
    'tools/native-host.exe': 'LOCAL-EXE',
    'tools/test-autoupdate.mjs': 'LOCAL-TEST',
  });
  const remote = {
    'manifest.json': JSON.stringify({ version: '0.5.0' }),
    'tools/autoupdate.mjs': 'NEW-UPDATER',
    'tools/native-host.mjs': 'NEW-HOST',
  };
  const r = await syncOnce({ root, fetchImpl: mockFetch({ version: '0.5.0', files: remote, atomRev: sha }), log: noop });
  t('tools 脚本随更新一起换新', r.ok && r.updated === true && read(root, 'tools/autoupdate.mjs') === 'NEW-UPDATER');
  t('远端新增的 tools 脚本已写入', read(root, 'tools/native-host.mjs') === 'NEW-HOST');
  t('本机私有 exe 不动', read(root, 'tools/native-host.exe') === 'LOCAL-EXE');
  t('未被清单列出的本机测试脚本不动', read(root, 'tools/test-autoupdate.mjs') === 'LOCAL-TEST');
  t('清单记录含 tools 路径', JSON.parse(read(root, '.update-files.json')).includes('tools/autoupdate.mjs'));
}

/* 17. 更新器自覆盖后本轮仍跑完（自身换新不影响这次执行，热重载与清单照写） */
{
  const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const root = mkRoot('0.4.8', { 'tools/autoupdate.mjs': 'OLD-UPDATER' });
  const remote = { 'manifest.json': JSON.stringify({ version: '0.5.0' }), 'tools/autoupdate.mjs': 'NEW-UPDATER' };
  const r = await syncOnce({ root, fetchImpl: mockFetch({ version: '0.5.0', files: remote, atomRev: sha }), log: noop });
  t('自覆盖后本轮仍返回成功', r.ok && r.updated === true);
  t('自覆盖后仍写热重载', exists(root, 'hot-reload.json'));
  t('自覆盖后仍写清单与暂存清理', exists(root, '.update-files.json') && !exists(root, '.update-stage'));
}

/* 18. manifest.json 最后写：写到一半失败时版本号仍是旧的，下次点更新会重来 */
{
  const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const root = mkRoot('0.4.8');
  fs.mkdirSync(path.join(root, 'content/homework/panel.js'), { recursive: true }); // 目标位置被目录占住，复制必失败
  const remote = {
    'manifest.json': JSON.stringify({ version: '0.5.0' }),
    'background/service-worker.js': 'NEW-SW',
    'content/homework/panel.js': 'NEW-PANEL',
  };
  const r = await syncOnce({ root, fetchImpl: mockFetch({ version: '0.5.0', files: remote, atomRev: sha }), log: noop });
  t('写入失败返回 ok:false 并说明可重试', r.ok === false && /写入文件失败/.test(r.error) && /重来/.test(r.error));
  t('写入失败时版本号仍是旧的', JSON.parse(read(root, 'manifest.json')).version === '0.4.8');
  t('写入失败时前面的文件已落盘（下轮整轮重来补齐）', read(root, 'background/service-worker.js') === 'NEW-SW');
  t('写入失败不写热重载', !exists(root, 'hot-reload.json'));
  t('写入失败后暂存目录已清理', !exists(root, '.update-stage'));
}

/* 19. 钉住 sha 的清单接口 404（新合入的提交冷启动）→ 改用同一个 sha 的 GitHub 文件树；
   不能退回 @master 的文件清单：那是分支缓存，可能缺这一版新增的文件，完整性校验会整轮拦掉 */
{
  const sha = 'b2c3d4e5f60718293a4b5c6d7e8f901234567890';
  const root = mkRoot('0.4.8', { 'content/homework/dropdown.js': 'OLD-DD' });
  const remote = {
    'manifest.json': JSON.stringify({ version: '0.5.0', content_scripts: [{ js: ['content/homework/dropdown.js'] }] }),
    'content/homework/dropdown.js': 'NEW-DD',
  };
  const base = mockFetch({ version: '0.5.0', files: remote, atomRev: sha, pinListFail: true });
  let masterHits = 0;
  const r = await syncOnce({
    root,
    fetchImpl: async (u) => {
      if (String(u).startsWith(CDN_BASE)) masterHits++;
      return base(u);
    },
    log: noop,
  });
  t('钉住清单 404 时改用同一 sha 的文件树仍能更新', r.ok === true && r.updated === true);
  t('清单 404 时新增文件按那个快照补齐', read(root, 'content/homework/dropdown.js') === 'NEW-DD');
  t('清单 404 时不回落 @master 清单', masterHits === 0);
  t('清单 404 走文件树后仍写清单与热重载', exists(root, '.update-files.json') && exists(root, 'hot-reload.json'));
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
