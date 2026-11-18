import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const sw=fs.readFileSync(new URL('../background/service-worker.js',import.meta.url),'utf8');
const panel=fs.readFileSync(new URL('../content/homework/panel.js',import.meta.url),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
for(const action of ['stop','replace','normal']){
  let queue={tabId:7,index:0,courses:[{key:'a',scUrl:'https://example.test/a'},{key:'b',scUrl:'https://example.test/b'}]};
  const navigations=[];let release;
  const access=new Promise(resolve=>{release=resolve;});
  const ctx=vm.createContext({watchNavigationEpoch:0,loadQueue:async()=>structuredClone(queue),
    ensureWatchHostAccess:()=>access,saveQueue:async q=>{queue=q;},
    chrome:{tabs:{update:async(...args)=>navigations.push(args)}}});
  vm.runInContext(sw.slice(sw.indexOf('async function watchGo(index)'),sw.indexOf('async function detectPage(')),ctx);
  const pending=ctx.watchGo(1);await flush();
  if(action!=='normal'){ctx.watchNavigationEpoch++;queue=action==='stop'?null:{tabId:8,index:0,courses:[]};}
  release(true);await pending;
  assert.equal(navigations.length,action==='normal'?1:0);
  assert.equal(queue?.tabId,action==='stop'?undefined:action==='replace'?8:7);
  console.log('PASS 换课等待期间队列状态：'+action);
}
const marker="      } else if (type === 'HW_WATCH_QUEUE_GET') {";
const at=sw.indexOf(marker)+marker.length;
const body=sw.slice(at,sw.indexOf("      } else if (type === 'HW_WATCH_COURSE_DONE')",at));
const topic='https://groupweb.chaoxing.com/course/topic/expected';
for(const [tabId,url,allowed] of [[7,'https://mooc1.chaoxing.com/study',true],[8,topic,true],[9,topic,false],[8,topic+'-different',false]]){
  let response;
  const ctx=vm.createContext({URL,tabId,sender:{url},loadQueue:async()=>({tabId:7,topic:{tabId:8,url:topic}}),sendResponse:r=>{response=r;}});
  vm.runInContext('async function query(){'+body+'\n}',ctx);await ctx.query();
  assert.equal(!!response.queue,allowed);
  console.log('PASS 队列仅返回属主及登记话题页：'+tabId+' / '+allowed);
}
const start=panel.indexOf('    async function rerun(');
const rerun=panel.slice(start,panel.indexOf('    chrome.runtime.onMessage.addListener((msg) => {',start));
for(const busy of [true,false]){
  const calls=[];const ctx=vm.createContext({detecting:false,autoRun:false,els:{stop:{disabled:!busy}},answerEpoch:1,stopRequested:false,HW:{questions:[{_status:'filled'}]},
    requireCurrentPage:()=>true,setRow(){},log(){},startAnswering:async opts=>calls.push(opts)});
  vm.runInContext(rerun,ctx);await ctx.rerun(0);
  assert.equal(calls.length,busy?0:1);assert.equal(ctx.answerEpoch,1);
  if(!busy){assert.equal(calls[0].fromIndex,0);assert.equal(calls[0].only,true);assert.equal(calls[0].force,true);}
  console.log('PASS 单题重问不干扰整页队列：busy='+busy);
}

/* 面板自动收起的作用域（用户 2026-10-28 两次强调）：只有点顶部「开始」按钮才收起，
   左键单题 / 右键从本题往后 / Shift+Enter 一律不动面板，否则用户会以为卡死。 */
assert.equal((panel.match(/wholePage:\s*true/g)||[]).length,1,'只有开始按钮能传 wholePage');
assert.match(panel,/els\.start\.addEventListener\('click', \(\) => startAnswering\(\{ wholePage: true \}\)\)/);
assert.match(panel,/if \(cfg\.engine === 'bridge' && opts\?\.wholePage\) \{/,'收起分支必须要求 wholePage');
assert.equal(/if \(cfg\.engine === 'bridge'\) \{/.test(panel),false,'不许留只判引擎的收起分支');
assert.equal(/fromIndex: i,[\s\S]{0,80}?wholePage/.test(panel),false,'单题/右键重问不能带 wholePage');
console.log('PASS 面板收起只由「开始」按钮触发，单题与右键重问不动面板');

{
  const at = sw.indexOf("} else if (type === 'CACHE_CLEAR') {") + "} else if (type === 'CACHE_CLEAR') {".length;
  const body = sw.slice(at, sw.indexOf('\n      } else {', at));
  for (const dryRun of [true, false]) {
    let removed = [], response;
    const ctx = vm.createContext({ payload: { dryRun }, sendResponse: r => { response = r; }, chrome: { storage: { local: {
      get: async () => { throw Error('禁止加载所有诊断和配置'); },
      getKeys: async () => ['c:answer', 'c:upd', 'config', 'savedKeys', 'issue:large'],
      remove: async keys => { removed = Array.from(keys); },
    } } } });
    vm.runInContext('async function clear(){' + body + '\n}', ctx); await ctx.clear();
    assert.equal(response.count, 1);
    assert.deepEqual(removed, dryRun ? [] : ['c:answer']);
  }
  console.log('PASS 记忆统计和清理只枚举键，保留配置、诊断和更新缓存');
}
{
  const source = fs.readFileSync(new URL('./make-edge-store-bundle.mjs', import.meta.url), 'utf8');
  const files = new Map();
  const read = file => files.get(file) ?? fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const ctx = vm.createContext({ read, write: (file, text) => files.set(file, text), version: JSON.parse(read('manifest.json')).version });
  const helpers = source.slice(source.indexOf('function removeBetween('), source.indexOf('function copyDir('));
  const transform = source.slice(source.indexOf('  const manifest = JSON.parse'), source.indexOf('  fs.mkdirSync(path.dirname(outPath)'));
  vm.runInContext(helpers + transform, ctx);
  const { spawnSync } = await import('node:child_process');
  for (const [name, text] of files) {
    if (!name.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: text, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, name + ': ' + result.stderr);
  }
  assert.ok(!JSON.parse(files.get('manifest.json')).permissions.includes('nativeMessaging'));
  console.log('PASS 商店源码转换边界和转换后的语法（内存验证，不生成发布包）');
}
{
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const files = [manifest.background.service_worker, manifest.options_page,
    ...Object.values(manifest.icons || {}),
    ...(manifest.content_scripts || []).flatMap(s => [...(s.js || []), ...(s.css || [])])];
  for (const file of files) assert.ok(fs.existsSync(new URL('../' + file, import.meta.url)), 'manifest 资源缺失：' + file);
  console.log('PASS manifest 所有显式资源引用存在');
}
for (const mode of ['idle', 'answer', 'detect', 'analyze', 'course', 'storage-error', 'late-start']) {
  let starts = 0;
  const ctx = vm.createContext({
    run: mode === 'answer' ? { cancelled: false, items: [{ status: 'asking' }] } : null,
    analyzingCount: mode === 'analyze' ? 1 : 0, detectingTabs: new Map(mode === 'detect' ? [[7, {}]] : []),
    getConfig: async () => ({ autoUpdate: true }), checkUpdate: async () => ({ ok: true, hasUpdate: true, latest: '2.0.0' }),
    loadQueue: async () => { if (mode === 'storage-error') throw Error('storage unavailable'); return mode === 'course' ? {} : null; },
    runUpdateViaHost: async () => { starts++; return { started: true }; },
    chrome: { storage: { local: { set: async () => { if (mode === 'late-start') ctx.analyzingCount++; }, remove: async () => {} } } },
  });
  vm.runInContext(sw.slice(sw.indexOf('const AUTO_UPDATE_INTERVAL'), sw.indexOf('setTimeout(autoUpdateTick')), ctx);
  await ctx.autoUpdateTick();
  assert.equal(starts, mode === 'idle' ? 1 : 0, '后台更新空闲保护：' + mode);
}
console.log('PASS 后台更新避开答题、识题、解析、刷课及未知存储状态');
