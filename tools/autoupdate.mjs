/* GitHub 版自动更新：node tools/autoupdate.mjs <插件根目录> 手动跑一轮；用户点「更新」时由浏览器
   经 tools/native-host.mjs 拉起本脚本，不常驻、不自动定时。
   插件运行在浏览器沙箱里不能改写自身文件，本脚本在插件外对该目录做等效更新：
   检查远端版本 → 有更新把扩展载荷全部下载到 .update-stage/ 暂存（任一失败整轮放弃、旧文件不动）
   → 全部成功后覆盖/新增、删除远端已移除的载荷文件 → 写 hot-reload.json 触发后台自动重载。
   更新源与扩展一致：GitHub API 实时优先、jsDelivr 兜底；tools/、README、LICENSE 等非载荷文件永不改动。 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = '54-39/auto-homework-engine';
const API = `https://api.github.com/repos/${REPO}`;
const CDN = `https://cdn.jsdelivr.net/gh/${REPO}@master/`;
const CDN_LIST = `https://data.jsdelivr.com/v1/packages/gh/${REPO}@master?structure=flat`; // CDN 的文件清单接口
const STAGE = '.update-stage';
const LIST = '.update-files.json';

/* 扩展载荷范围（浏览器实际加载的文件）；README/LICENSE/package.json/tools 等不在其列 */
export const isPayload = (p) =>
  p === 'manifest.json' || p === 'settings.html' || p === 'settings.js' ||
  /^(background|content|options|icons)\//.test(p);

export const cmp = (a, b) => {
  const A = String(a).split('.').map(Number), B = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((A[i] || 0) !== (B[i] || 0)) return Math.sign((A[i] || 0) - (B[i] || 0));
  return 0;
};

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });

export async function syncOnce({ root = process.cwd(), fetchImpl = fetch, log = (m) => console.log('[autoupdate] ' + m) } = {}) {
  const localPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(localPath)) throw new Error('当前目录不是插件根目录（缺 manifest.json）');
  const current = JSON.parse(fs.readFileSync(localPath, 'utf8')).version;

  async function apiJson(url) {
    const r = await fetchImpl(url, { headers: { 'user-agent': 'homework-helper-autoupdate' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  /* 一轮更新只用一个源：版本从哪读到，全部文件就整轮从哪读。逐文件回退会混源——GitHub API 配额
     中途用尽时后半程落到 jsDelivr 的旧缓存（@master 每文件独立缓存，最长滞后 12 小时），
     装出来是半新半旧的版本，还会照报「已更新到 vX」。api.github.com 连不上也只需赔一次超时：
     读版本那步失败就整轮改走 CDN（否则 19 个文件各赔一次 10 秒，会撞穿后台 65 秒等待上限）。 */
  let source = 'cdn';
  const apiFile = async (p) =>
    Buffer.from((await apiJson(`${API}/contents/${p}?ref=master`)).content.replace(/\s/g, ''), 'base64');
  async function cdnFile(p) {
    const r = await fetchImpl(CDN + p);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  }
  const fileOf = (p) => (source === 'api' ? apiFile(p) : cdnFile(p));
  const remoteVersion = async () => {
    try {
      source = 'api';
      return JSON.parse((await apiFile('manifest.json')).toString('utf8')).version;
    } catch {
      source = 'cdn';
      return JSON.parse((await cdnFile('manifest.json')).toString('utf8')).version;
    }
  };
  const remoteFiles = async () => {
    if (source === 'api') {
      try {
        const j = await apiJson(`${API}/git/trees/master?recursive=1`);
        return j.tree.filter((t) => t.type === 'blob' && isPayload(t.path)).map((t) => t.path);
      } catch { /* 换源：api.github.com 在国内常连不上，没有这一步时首次更新必然失败 */ }
    }
    try {
      const j = await apiJson(CDN_LIST);
      return j.files.map((f) => f.name.replace(/^\//, '')).filter(isPayload);
    } catch { /* 换源 */ }
    log('两个文件清单源都不可用，按上次更新的文件清单继续');
    return JSON.parse(fs.readFileSync(path.join(root, LIST), 'utf8'));
  };

  const latest = await remoteVersion();
  if (!latest || cmp(latest, current) <= 0) return { ok: true, updated: false, current, latest: latest || current };

  log('发现新版本 ' + current + ' → ' + latest + '，下载中…');
  const files = await remoteFiles();
  const stage = path.join(root, STAGE);
  rmrf(stage); // 清掉上次异常残留
  try {
    for (const p of files) { // 先全部暂存，任一失败立即放弃（旧文件不动，下一轮重试）
      let buf = null, why = '';
      try { buf = await fileOf(p); } catch (e) { why = String(e.message || e); }
      if (!buf) throw new Error(p + ' 下载失败（' + why + '）');
      const dst = path.join(stage, p);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, buf);
    }
  } catch (e) {
    rmrf(stage);
    return { ok: false, updated: false, current, latest, error: String(e.message || e) };
  }
  /* 装之前先看暂存下来的 manifest 是不是自己要装的那版：CDN（@master）按文件各自缓存、最长滞后
     12 小时，混进旧文件时宁可整轮放弃，也不能装出半新半旧还照报「已更新到 vX」的版本 */
  const stagedManifest = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
  const staged = stagedManifest.version;
  if (staged !== latest) {
    rmrf(stage);
    return { ok: false, updated: false, current, latest, error: `下载到的文件是 v${staged}，不是要更新的 v${latest}（更新源缓存不一致），本轮放弃，请稍后重试` };
  }
  /* 完整性：这一版 manifest 声明的脚本/样式必须都下齐了。文件清单和文件本身可能来自不同快照
     （文件树接口挂了就退回 CDN 清单），少了新增文件（例如某版新增的 dropdown.js）装出来
     插件直接加载失败，比「没更新」严重得多。 */
  const declared = [
    stagedManifest.background?.service_worker,
    ...(stagedManifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
  ].filter(Boolean);
  const missing = declared.filter((p) => !files.includes(p) || !fs.existsSync(path.join(stage, p)));
  if (missing.length) {
    rmrf(stage);
    return { ok: false, updated: false, current, latest, error: `下载到的文件不完整，缺少 ${missing.join('、')}（文件清单与版本不一致），本轮放弃，请稍后重试` };
  }

  const prevList = fs.existsSync(path.join(root, LIST)) ? JSON.parse(fs.readFileSync(path.join(root, LIST), 'utf8')) : [];
  const removed = [];
  for (const p of prevList) if (!files.includes(p)) { // 远端已删除的载荷文件
    const f = path.join(root, p);
    if (fs.existsSync(f)) { fs.unlinkSync(f); removed.push(p); }
  }
  for (const p of files) {
    const dst = path.join(root, p);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(stage, p), dst);
  }
  fs.writeFileSync(path.join(root, LIST), JSON.stringify(files, null, 2));
  rmrf(stage);
  fs.writeFileSync(path.join(root, 'hot-reload.json'), JSON.stringify({ t: Date.now() }));
  log(`已更新到 v${latest}（${files.length} 个文件${removed.length ? '，删除 ' + removed.length + ' 个：' + removed.join(', ') : ''}），后台将自动重载，作业页面请 F5`);
  return { ok: true, updated: true, current, latest, files, removed };
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd(); // 可选：node autoupdate.mjs <插件目录>
  const r = await syncOnce({ root }).catch((e) => ({ ok: false, error: String(e.message || e) }));
  if (!r.ok) console.error('[autoupdate] ' + r.error);
  if (!r.ok) process.exitCode = 1;
}
