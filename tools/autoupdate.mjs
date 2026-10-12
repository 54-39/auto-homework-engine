/* GitHub 版自动更新：node tools/autoupdate.mjs <插件根目录> 手动跑一轮；用户点「更新」时由浏览器
   经 tools/native-host.mjs 拉起本脚本，不常驻、不自动定时。
   插件运行在浏览器沙箱里不能改写自身文件，本脚本在插件外对该目录做等效更新：
   检查远端版本 → 有更新把扩展载荷全部下载到 .update-stage/ 暂存（任一失败整轮放弃、旧文件不动）
   → 全部成功后覆盖/新增、删除远端已移除的载荷文件 → 写 hot-reload.json 触发后台自动重载。
   更新源：先把 master 钉到当前 commit（atom 订阅源，不占 API 配额），整轮都从那个不可变快照读，
   清单里每个文件还带 sha256 可逐字节校验；钉不住才退回 GitHub API / jsDelivr @master。
   tools/ 里的脚本也一起更新——更新器自己就在 tools/，不更新它，更新逻辑一改就得回每台机器手抄一遍；
   README、LICENSE、package.json 等非载荷文件不动。 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = '54-39/auto-homework-engine';
const API = `https://api.github.com/repos/${REPO}`;
const ATOM = `https://github.com/${REPO}/commits/master.atom`; // 不占 GitHub API 配额，能看到 master 当前指着哪个 sha
const CDN = (rev) => `https://cdn.jsdelivr.net/gh/${REPO}@${rev}/`;
const CDN_LIST = (rev) => `https://data.jsdelivr.com/v1/packages/gh/${REPO}@${rev}?structure=flat`; // 钉了 sha 时每项还带 sha256，可逐文件校验
const STAGE = '.update-stage';
const LIST = '.update-files.json';

/* 更新范围：扩展载荷（浏览器实际加载的文件）＋ tools/ 里的更新脚本。tools/ 必须一起更新，否则
   更新逻辑本身永远是装机那天的老版本，改一次就得回每台机器手抄一遍，谈不上全自动。只认远端清单
   列出的文件，所以本机私有的 tools/native-host.exe 与本地测试脚本不会被碰；README、LICENSE、
   package.json 等不在其列。 */
export const isPayload = (p) =>
  p === 'manifest.json' || p === 'settings.html' || p === 'settings.js' ||
  /^(background|content|options|icons|tools)\//.test(p);

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
    const r = await tfetch(url, { headers: { 'user-agent': 'homework-helper-autoupdate' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  /* 一轮更新只用一个源：版本从哪读到，全部文件就整轮从哪读。逐文件回退会混源——GitHub API 配额
     中途用尽时后半程落到 jsDelivr 的旧缓存（@master 每文件独立缓存，最长滞后 12 小时），
     装出来是半新半旧的版本，还会照报「已更新到 vX」。api.github.com 连不上也只需赔一次超时：
     读版本那步失败就整轮改走 CDN（否则 19 个文件各赔一次 10 秒，会撞穿后台 65 秒等待上限）。 */
  let source = 'cdn';
  let rev = 'master'; // 钉住的 commit；'master' 表示没钉住、走分支（可能撞上 CDN 滞后缓存）
  let fileHash = null; // 钉住时清单给的 sha256，用来逐文件校验
  const apiFile = async (p) =>
    Buffer.from((await apiJson(`${API}/contents/${p}?ref=master`)).content.replace(/\s/g, ''), 'base64');
  async function cdnFile(p) {
    const r = await tfetch(CDN(rev) + p);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  }
  /* 单次请求超时：没有它时，某个文件下载 hang 住会一直拖到宿主 60 秒自杀，用户只看到
     「宿主提前退出」，根本不知道卡在哪一步。超时后抛错走整轮放弃（旧文件不动），下次点更新重来。 */
  async function tfetch(url, opts = {}, ms = 25000) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    try {
      return await fetchImpl(url, { ...opts, signal: c.signal });
    } catch (e) {
      if (e?.name === 'AbortError') throw new Error('请求超时（' + ms / 1000 + 's）：' + url);
      throw e;
    } finally {
      clearTimeout(t);
    }
  }
  const fileOf = (p) => (source === 'api' ? apiFile(p) : cdnFile(p));
  /* 先把 master 钉到当前 commit：atom 订阅源是网页、不占 GitHub API 配额。jsDelivr 的 @master 按
     文件各自缓存（最长滞后 12 小时），不钉住就可能拿到「manifest 是新的、某个脚本还是旧的」的
     半新半旧；钉住 sha 后版本、清单、文件字节都出自同一个不可变快照，而且钉住的清单每项还带
     sha256，可以逐字节校验。钉不住就退回 @master，靠下面装前两道校验兜底。 */
  try {
    const r = await tfetch(ATOM);
    const m = r && r.ok ? (await r.text()).match(/Grit::Commit\/([0-9a-f]{40})/) : null;
    if (m) rev = m[1];
  } catch { /* 钉不住 */ }
  const remoteVersion = async () => {
    if (rev !== 'master') { // 钉住了：版本也从那个不可变快照读，不碰 API 配额
      try {
        return JSON.parse((await cdnFile('manifest.json')).toString('utf8')).version;
      } catch { rev = 'master'; } // 这个 sha 在 CDN 上还没就绪 → 退回 @master
    }
    try {
      source = 'api';
      return JSON.parse((await apiFile('manifest.json')).toString('utf8')).version;
    } catch {
      source = 'cdn';
      return JSON.parse((await cdnFile('manifest.json')).toString('utf8')).version;
    }
  };
  const remoteFiles = async () => {
    if (rev !== 'master') {
      try {
        const j = await apiJson(CDN_LIST(rev)); // 钉住 sha 的清单：每项带 sha256（就是我们下载后要比对的字节）
        fileHash = new Map(j.files.map((f) => [f.name.replace(/^\//, ''), f.hash]));
        return j.files.map((f) => f.name.replace(/^\//, '')).filter(isPayload);
      } catch { fileHash = null; }
      /* 清单接口对新合入的 sha 有冷启动（刚推上去那阵子 404，过一会儿才生成），这时**不能**退回
         @master 的文件清单：那是分支的缓存，可能缺这一版新增的文件（例如某版新增的 dropdown.js），
         装前的完整性校验会把整轮拦掉，用户看到的是「文件清单与版本不一致」。改用同一个 sha 的
         GitHub 文件树——快照仍然只有一个，代价只是少了逐文件 sha256（装前那两道校验还在）。 */
      try {
        const j = await apiJson(`${API}/git/trees/${rev}?recursive=1`);
        return j.tree.filter((t) => t.type === 'blob' && isPayload(t.path)).map((t) => t.path);
      } catch { rev = 'master'; } // 这个快照整个取不到，才退回分支
    }
    if (source === 'api') {
      try {
        const j = await apiJson(`${API}/git/trees/master?recursive=1`);
        return j.tree.filter((t) => t.type === 'blob' && isPayload(t.path)).map((t) => t.path);
      } catch { /* 换源：api.github.com 在国内常连不上，没有这一步时首次更新必然失败 */ }
    }
    try {
      const j = await apiJson(CDN_LIST('master'));
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
      if (fileHash?.has(p)) { // 钉住的清单给了这一版该有的字节摘要，对不上说明 CDN 缓存串了版本
        const got = crypto.createHash('sha256').update(buf).digest('base64');
        if (got !== fileHash.get(p)) throw new Error(p + ' 内容校验不符（下载到的不是这一版的文件）');
      }
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
  const put = (p) => {
    const dst = path.join(root, p);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(stage, p), dst);
  };
  /* manifest.json 留到最后写：版本号就是「这一版装完了」的标记。中途失败（文件被别的程序占用等）时
     它还是旧的，下次点更新会整轮重来；先写它则崩在后面的文件上就再也不会补——版本号已经相等了。 */
  try {
    for (const p of files) if (p !== 'manifest.json') put(p);
    if (files.includes('manifest.json')) put('manifest.json');
  } catch (e) {
    rmrf(stage);
    return { ok: false, updated: false, current, latest, error: `写入文件失败（${String(e.message || e)}）；版本号未改，下次点「更新」会重来` };
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
