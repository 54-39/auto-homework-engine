import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../background/service-worker.js', import.meta.url), 'utf8');
const injection = source.slice(source.indexOf('/* 新装／更新时'), source.indexOf('/* 保存当前版本供其他诊断'));
function fixture({ loading = false, access = true, denied = false } = {}) {
  const tab = { id: 9, status: loading ? 'loading' : 'complete', url: 'https://mooc2-ans.chaoxing.com/mooc2-ans-vue/taskChain/student/answer' };
  const events = [], calls = [], issues = [];
  const context = vm.createContext({
    Set, Map, URL, WATCH_HOST_ACCESS_ERROR: '缺少超星持续站点访问权限，请允许访问后刷新页面',
    recordIssue: async issue => issues.push(issue),
    chrome: {
      permissions: { contains: async () => access },
      runtime: { getManifest: () => ({ content_scripts: [{ matches: ['*://*.chaoxing.com/*'], js: ['content/homework/content.js'] }] }),
        onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
      tabs: { query: async () => [tab], onUpdated: { addListener: fn => events.push(fn) } },
      scripting: { executeScript: async value => {
        calls.push(value);
        if (loading || denied) throw Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');
        return [{ result: false }];
      } },
    },
  });
  vm.runInContext(injection, context);
  return { context, tab, events, calls, issues, loaded: () => { loading = false; tab.status = 'complete'; } };
}
{
  const f = fixture({ loading: true });
  await f.context.injectOpenHomeworkTabs();
  assert.equal(f.calls.length, 0, '页面切换中不应尝试注入并误报权限异常');
  assert.equal(f.issues.length, 0);
  f.loaded();
  for (const fn of f.events) await fn(f.tab.id, { status: 'complete' }, f.tab);
  assert.equal(f.calls.length, 2, '加载完成后没有补上面板');
  console.log('PASS 等页面加载完成再注入，无过程性权限误报');
}
{
  const f = fixture();
  await Promise.all([f.context.injectOpenHomeworkTabs(), f.context.injectOpenHomeworkTabs()]);
  assert.equal(f.calls.length, 2, '安装和启动并发重复注入');
  console.log('PASS 并发启动共用同一次注入');
}
{
  const f = fixture({ access: false });
  await f.context.injectOpenHomeworkTabs();
  assert.equal(f.calls.length, 0);
  assert.equal(f.issues.length, 1);
  assert.match(f.issues[0].message, /权限.*刷新|允许.*刷新/);
  console.log('PASS 真正缺少站点权限时记录明确的授权和刷新指引');
}
{
  const f = fixture({ denied: true });
  await f.context.injectOpenHomeworkTabs();
  assert.equal(f.issues.length, 1);
  assert.match(f.issues[0].message, /权限|站点访问/);
  assert.match(f.issues[0].details, /Cannot access/);
  console.log('PASS 浏览器拒绝访问时保留原始错误并提供中文处理指引');
}
{
  const f = fixture({ loading: true });
  await f.context.injectOpenHomeworkTabs();
  f.loaded();
  f.tab.url = 'edge://extensions';
  for (const fn of f.events) await fn(f.tab.id, { status: 'complete' }, f.tab);
  assert.equal(f.calls.length, 0);
  assert.equal(f.issues.length, 0);
  console.log('PASS 导航离开超星后不再注入');
}
