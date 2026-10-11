/* 更新检查 mock 测试：桩 chrome + fetch，导入真实 service-worker.js，
   走真实 onMessage 监听器验证 CHECK_UPDATE 全链路（含 1 小时缓存节流、force 强制刷新、
   面板用的 cacheOnly 只读模式、功能更新/修复更新分级、三个更新源按序回退）。用法: node tools/test-update-check.mjs */
const store = {};
const opened = []; // OPEN_SETTINGS 记录：验证后台代开设置页
let updFetches = 0;
globalThis.fetch = async (url) => {
  if (String(url).includes('hot-reload.json')) return { ok: true, json: async () => ({ t: 0 }) };
  updFetches++;
  return { ok: true, json: async () => ({ version: '0.2.0' }) };
};
globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: '0.1.1' }),
    onMessage: { addListener: (fn) => { globalThis.__hwListener = fn; } },
    reload: () => {},
    getURL: (p) => p,
    lastError: undefined,
  },
  storage: {
    local: {
      get: async (k) => (k === null ? { ...store } : { [k]: store[k] }),
      set: async (o) => Object.assign(store, o),
      remove: async (ks) => ks.forEach((k) => delete store[k]),
    },
  },
  tabs: { query: async () => [], update: async () => {}, sendMessage: async () => {}, create: async (o) => { opened.push(o); } },
  notifications: { create: () => {}, onClicked: { addListener: () => {} } },
  windows: { update: async () => {} },
};
// connectNative 不 mock：宿主没装时 Chrome 会直接抛错，正好覆盖「宿主未安装静默失败」分支
delete globalThis.chrome.runtime.connectNative;

await import('file:///E:/vibe work/DSH work/auto-homework-engine-master/background/service-worker.js');
const handler = globalThis.__hwListener;
if (!handler) { console.error('FAIL: 监听器未注册'); process.exit(1); }

const call = () => new Promise((resolve) => handler({ type: 'CHECK_UPDATE' }, { tab: { id: 1 } }, resolve));

let r1 = await call();
let ok1 = r1?.ok === true && r1.hasUpdate === true && r1.latest === '0.2.0' && r1.current === '0.1.1' && r1.url;
console.log((ok1 ? 'PASS' : 'FAIL'), '第一次检查:', JSON.stringify(r1), 'updFetches=', updFetches);

let r2 = await call();
let ok2 = r2?.ok === true && r2.cached === true && r2.hasUpdate === true && updFetches === 1;
console.log((ok2 ? 'PASS' : 'FAIL'), '缓存命中(1h内不重复请求):', JSON.stringify(r2), 'updFetches=', updFetches);

// 无更新场景：本地版本 >= GitHub 版本
store['c:upd'] = { latest: '0.1.1', at: Date.now() };
let r3 = await call();
let ok3 = r3?.hasUpdate === false && r3.latest === '0.1.1' && updFetches === 1;
console.log((ok3 ? 'PASS' : 'FAIL'), '版本相同无更新:', JSON.stringify(r3));

// 拉取失败：静默返回 ok:false，不抛异常
globalThis.fetch = async () => { throw new Error('network down'); };
store['c:upd'] = { latest: '9.9.9', at: 0 }; // 过期缓存强制重新拉取
let r4 = await call();
let ok4 = r4?.ok === false;
console.log((ok4 ? 'PASS' : 'FAIL'), '拉取失败静默:', JSON.stringify(r4));

// force 检查：绕过 1 小时缓存强制重新拉取（设置页「检测更新」用）
globalThis.fetch = async (url) => {
  if (String(url).includes('hot-reload.json')) return { ok: true, json: async () => ({ t: 0 }) };
  updFetches++;
  return { ok: true, json: async () => ({ version: '0.3.0' }) };
};
store['c:upd'] = { latest: '0.2.0', at: Date.now() }; // 新鲜缓存
let r5 = await call(); // 不带 force：命中缓存
let ok5 = r5?.cached === true && r5.latest === '0.2.0';
console.log((ok5 ? 'PASS' : 'FAIL'), '缓存命中(force前):', JSON.stringify(r5), 'updFetches=', updFetches);
const callForce = () => new Promise((resolve) => handler({ type: 'CHECK_UPDATE', payload: { force: true } }, { tab: { id: 1 } }, resolve));
const f1 = updFetches;
let r6 = await callForce(); // 带 force：重新拉取
let ok6 = r6?.cached !== true && r6.latest === '0.3.0' && r6.hasUpdate === true && updFetches === f1 + 1;
console.log((ok6 ? 'PASS' : 'FAIL'), 'force绕过缓存重新拉取:', JSON.stringify(r6), 'updFetches=', updFetches);

// 面板提示行：cacheOnly 只读缓存、不联网；且只有功能更新（次版本号变化）才算 major
const callCache = () => new Promise((resolve) => handler({ type: 'CHECK_UPDATE', payload: { cacheOnly: true } }, { tab: { id: 1 } }, resolve));
delete store['c:upd'];
let f2 = updFetches;
let r8 = await callCache();
let ok8 = r8?.ok === false && updFetches === f2;
console.log((ok8 ? 'PASS' : 'FAIL'), 'cacheOnly无缓存不联网:', JSON.stringify(r8), 'updFetches=', updFetches);

store['c:upd'] = { latest: '0.4.2', at: Date.now() }; // 当前 0.1.1：次版本号变化 = 功能更新
let f3 = updFetches;
let r9 = await callCache();
let ok9 = r9?.ok === true && r9.cached === true && r9.hasUpdate === true && r9.major === true && updFetches === f3;
console.log((ok9 ? 'PASS' : 'FAIL'), 'cacheOnly读缓存+功能更新major:', JSON.stringify(r9), 'updFetches=', updFetches);

store['c:upd'] = { latest: '0.1.2', at: Date.now() }; // 只动末位补丁号 = 修复更新，面板不提示
let r10 = await callCache();
let ok10 = r10?.hasUpdate === true && r10.major === false && updFetches === f3;
console.log((ok10 ? 'PASS' : 'FAIL'), 'cacheOnly修复更新不算major:', JSON.stringify(r10), 'updFetches=', updFetches);

// 更新源：① GitHub API（实时，内容是 base64）② jsDelivr 镜像（大陆可达但可能读到 12h 内的旧号）③ GitHub raw（海外保底）；
// 按序回退，每个源只试一次
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
globalThis.fetch = async (url) => {
  if (String(url).includes('hot-reload.json')) return { ok: true, json: async () => ({ t: 0 }) };
  updFetches++;
  return { ok: true, json: async () => ({ content: b64('{"version":"0.4.4"}'), encoding: 'base64' }) };
};
store['c:upd'] = { latest: '0.1.1', at: 0 }; // 过期缓存，强制走网络
const f4 = updFetches;
let r11 = await call();
let ok11 = r11?.ok === true && r11.latest === '0.4.4' && r11.hasUpdate === true && updFetches === f4 + 1;
console.log((ok11 ? 'PASS' : 'FAIL'), '首选源 GitHub API（base64 内容）:', JSON.stringify(r11), 'updFetches=', updFetches);

globalThis.fetch = async (url) => {
  if (String(url).includes('hot-reload.json')) return { ok: true, json: async () => ({ t: 0 }) };
  updFetches++;
  if (String(url).includes('api.github.com')) throw new Error('HTTP 403');
  return { ok: true, json: async () => ({ version: '0.4.4' }) };
};
store['c:upd'] = { latest: '0.1.1', at: 0 };
const f5 = updFetches;
let r12 = await call();
let ok12 = r12?.ok === true && r12.latest === '0.4.4' && updFetches === f5 + 2;
console.log((ok12 ? 'PASS' : 'FAIL'), '首选源失败回退 jsDelivr:', JSON.stringify(r12), 'updFetches=', updFetches);

globalThis.fetch = async (url) => {
  if (String(url).includes('hot-reload.json')) return { ok: true, json: async () => ({ t: 0 }) };
  updFetches++;
  if (String(url).includes('api.github.com') || String(url).includes('cdn.jsdelivr.net')) throw new Error('unreachable');
  return { ok: true, json: async () => ({ version: '0.4.3' }) };
};
store['c:upd'] = { latest: '0.1.1', at: 0 };
const f6 = updFetches;
let r13 = await call();
let ok13 = r13?.ok === true && r13.latest === '0.4.3' && updFetches === f6 + 3;
console.log((ok13 ? 'PASS' : 'FAIL'), '前两源失败回退 raw:', JSON.stringify(r13), 'updFetches=', updFetches);

// 面板「设置」按钮：content script 没有 chrome.tabs，必须由后台代开设置页
const callOpen = () => new Promise((resolve) => handler({ type: 'OPEN_SETTINGS' }, { tab: { id: 1 } }, resolve));
let r7 = await callOpen();
let ok7 = r7?.ok === true && opened.length === 1 && String(opened[0].url).includes('settings.html');
console.log((ok7 ? 'PASS' : 'FAIL'), '设置页由后台代开:', JSON.stringify(r7), JSON.stringify(opened));

// HW_RUN_UPDATE：宿主未安装时静默失败，不抛异常
const callRun = () => new Promise((resolve) => handler({ type: 'HW_RUN_UPDATE' }, { tab: { id: 1 } }, resolve));
let r14 = await callRun();
let ok14 = r14?.ok === false && typeof r14.error === 'string' && r14.error.length > 0;
console.log((ok14 ? 'PASS' : 'FAIL'), '宿主未安装静默失败:', JSON.stringify(r14));

process.exit(ok1 && ok2 && ok3 && ok4 && ok5 && ok6 && ok7 && ok8 && ok9 && ok10 && ok11 && ok12 && ok13 && ok14 ? 0 : 1);
