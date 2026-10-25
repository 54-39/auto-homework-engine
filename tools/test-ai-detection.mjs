import assert from 'node:assert/strict';
import { buildDetectionMessages, parseDetection, detectQuestions } from '../background/engines/detection-engine.js';
import { requestWithAPI, answerWithAPI } from '../background/engines/api-engine.js';
import { requestWithBridge, answerWithBridge } from '../background/engines/bridge-engine.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log('PASS', name);
  passed++;
}
const item = { type: 'blank', stem: '请填写数值', containerId: 'e1', inputIds: ['e2'], options: [] };
const raw = JSON.stringify({ questions: [item] });
const messages = buildDetectionMessages('<main ref="e1"><input ref="e2" kind="text"></main>');
const originalFetch = globalThis.fetch;
const originalTimeout = globalThis.setTimeout;
const cfg = { iface: 'openai', baseURL: 'https://example.invalid/v1', model: 'test', apiKey: 'test-key' };
globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } }, permissions: { contains: async () => true, request: async () => true }, runtime: { onMessage: { addListener() {} }, getManifest: () => ({ version: '0.9.14' }) }, tabs: { onUpdated: { addListener() {} } } };
try {
  await test('识题提示将网页内容当资料，禁止作答、脚本和虚构编号', () => {
    assert.match(messages[0].content, /不可信/);
    assert.match(messages[0].content, /不作答/);
    assert.match(messages[0].content, /虚构编号/);
    assert.match(messages[1].content, /ref="e2"/);
    assert.match(messages[0].content, /共享材料/);
    assert.match(messages[0].content, /contextIds/);
    assert.match(messages[0].content, /kind=select/);
    assert.match(messages[0].content, /inputIds 严格按页面先后顺序/);
    assert.match(messages[0].content, /拖拽、排序、连线、必须上传/);
  });
  await test('支持纯 JSON 和完整 JSON 代码围栏，丢弃额外字段', () => {
    assert.equal(parseDetection(raw)[0].type, 'blank');
    assert.equal(parseDetection('```json\n' + raw + '\n```')[0].inputIds[0], 'e2');
    assert.equal(parseDetection(JSON.stringify({ questions: [{ ...item, script: 'alert(1)' }] }))[0].script, undefined);
  });
  await test('拒绝无效 JSON、缺少题干和错误容器格式', () => {
    for (const value of ['解释：' + raw, '{', '{}', '{"questions":[{"type":"choice"}]}']) {
      assert.throws(() => parseDetection(value), /JSON|格式|不完整/);
    }
  });
  await test('长页按批串行调用，识别失败不重试、不返回半份结果', async () => {
    const progress = [];
    const seen = [];
    const result = await detectQuestions(['第一页', '第二页'], async (m) => { seen.push(m[1].content); return { raw }; }, (...p) => progress.push(p));
    assert.equal(result.length, 2);
    assert.deepEqual(progress, [[1, 2], [2, 2]]);
    assert.match(seen[1], /第二页/);
    let calls = 0;
    await assert.rejects(() => detectQuestions(['一', '二', '三'], async () => { calls++; return { raw: calls === 2 ? '错误' : raw }; }), /JSON/);
    assert.equal(calls, 2);
    await assert.rejects(() => detectQuestions(['x'.repeat(20001)], async () => ({ raw })), /过大/);
  });
  await test('OpenAI 通道保留原始识题 JSON 和鉴权，答案流程仍解析答案', async () => {
    let sent;
    globalThis.fetch = async (url, opts) => {
      sent = { url, ...opts, body: JSON.parse(opts.body) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: raw } }] }) };
    };
    assert.equal((await requestWithAPI(messages, cfg)).raw, raw);
    assert.equal(sent.body.messages[0].role, 'system');
    assert.equal(sent.headers.Authorization, 'Bearer test-key');
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'B' } }] }) });
    assert.equal((await answerWithAPI({ type: 'choice', stem: '选一项' }, cfg)).answer, 'B');
  });
  await test('API返回完整同步通信时优先精确命中B，不与半同步通信冲突', async () => {
    const q = { type: 'choice', stem: '发送方和接收方严格按照时钟节拍传输的是哪种通信方式？', options: [
      { key: 'A', text: 'A 异步通信' }, { key: 'B', text: 'B 同步通信' },
      { key: 'C', text: 'C 突发传送' }, { key: 'D', text: 'D 半同步通信' },
    ] };
    const content = '{"answers":["同步通信"]}';
    for (const iface of ['openai', 'anthropic']) {
      let count = 0;
      globalThis.fetch = async () => {
        count++;
        return { ok: true, json: async () => iface === 'openai'
          ? { choices: [{ message: { content } }] } : { content: [{ type: 'text', text: content }] } };
      };
      const result = await answerWithAPI(q, { ...cfg, iface });
      assert.equal(result.answer, 'B');
      assert.equal(result.raw, content);
      assert.equal(count, 1, '匹配修复不能增加请求');
    }
  });
  await test('Anthropic 通道保留 system 和原始 JSON', async () => {
    let sent;
    globalThis.fetch = async (_, opts) => {
      sent = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: raw }] }) };
    };
    assert.equal((await requestWithAPI(messages, { ...cfg, iface: 'anthropic' })).raw, raw);
    assert.equal(sent.system, messages[0].content);
    assert.equal(sent.messages[0].role, 'user');
  });
  await test('API 未配置、网络错误、鉴权失败和超时明确失败', async () => {
    await assert.rejects(() => requestWithAPI(messages, {}), /Key/);
    globalThis.fetch = async () => { throw new Error('network offline'); };
    await assert.rejects(() => requestWithAPI(messages, cfg), /offline/);
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
    await assert.rejects(() => requestWithAPI(messages, cfg), /401/);
    globalThis.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 120000 ? 1 : ms, ...args);
    globalThis.fetch = (_, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError'))));
    await assert.rejects(() => requestWithAPI(messages, cfg), /超时/);
    globalThis.setTimeout = originalTimeout;
  });
  let bridgeHandler = async () => ({ ok: true, text: raw });
  let lastPrompt;
  chrome.tabs = {
    query: async () => [{ id: 7 }],
    onUpdated: { addListener() {} },
    sendMessage: async (_, msg) => {
      if (msg.type === 'BRIDGE_PING') return { ok: true, ready: true };
      lastPrompt = msg.payload.prompt;
      return bridgeHandler();
    },
  };
  await test('豆包桥接识题原文不经过答案解析，并保留原答题流程', async () => {
    assert.equal((await requestWithBridge(messages, {})).raw, raw);
    assert.match(lastPrompt, /网页题目识别器/);
    bridgeHandler = async () => ({ ok: true, text: 'A' });
    assert.equal((await answerWithBridge({ type: 'choice', stem: '选择' }, {})).answer, 'A');
  });
  await test('豆包并发检测被拒绝，结束后释放；超时和验证错误可恢复', async () => {
    let release;
    bridgeHandler = () => new Promise((resolve) => { release = resolve; });
    const first = requestWithBridge(messages, {});
    await new Promise((r) => originalTimeout(r, 0));
    await assert.rejects(() => requestWithBridge(messages, {}), /上一条/);
    release({ ok: true, text: raw });
    await first;
    globalThis.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 150000 ? 1 : ms, ...args);
    bridgeHandler = () => new Promise(() => {});
    await assert.rejects(() => requestWithBridge(messages, {}), /超时/);
    globalThis.setTimeout = originalTimeout;
    bridgeHandler = async () => ({ ok: false, error: '需要验证' });
    await assert.rejects(() => requestWithBridge(messages, {}), /验证/);
    bridgeHandler = async () => ({ ok: true, text: raw });
    assert.equal((await requestWithBridge(messages, {})).raw, raw);
  });
  let handler;
  const sentMessages = [];
  const store = { config: { engine: 'api', api: cfg } };
  let installed, startup;
  chrome.runtime = { getManifest: () => ({ version: '0.6.15' }), getURL: (p) => p, reload: () => {},
    onInstalled: { addListener: fn => { installed = fn; } }, onStartup: { addListener: fn => { startup = fn; } },
    onMessage: { addListener: (fn) => { handler = fn; } } };
  chrome.storage.local = { get: async (k) => k === null ? { ...store } : Array.isArray(k) ? Object.fromEntries(k.map(key => [key, store[key]])) : { [k]: store[k] }, getKeys: async () => Object.keys(store), set: async (v) => Object.assign(store, v), remove: async k => { for (const key of Array.isArray(k) ? k : [k]) delete store[key]; } };
  chrome.notifications = { create: () => {}, onClicked: { addListener: () => {} } };
  chrome.tabs.sendMessage = async (_, msg) => {
    if (msg.type === 'BRIDGE_PING') return { ok: true, ready: true };
    if (msg.type === 'BRIDGE_ASK') return { ok: true, text: raw };
    sentMessages.push(msg);
    return {};
  };
  const realInterval = globalThis.setInterval;
  const importTimeout = globalThis.setTimeout;
  globalThis.setInterval = () => 0;
  globalThis.setTimeout = (fn, ms, ...args) => ms === 45000 ? 0 : importTimeout(fn, ms, ...args);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ t: 0 }) });
  try { await import('../background/service-worker.js'); } finally { globalThis.setInterval = realInterval; globalThis.setTimeout = importTimeout; }
  const call = (type, payload = {}, url = 'https://mooc1.chaoxing.com/work') => new Promise((resolve) =>
    handler({ type, payload }, { url, tab: { id: 31, url } }, resolve));
  const success = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
  await test('安装与浏览器启动为已打开的超星页面补加载，已有面板不重复注入', async () => {
    const originalManifest=chrome.runtime.getManifest, originalQuery=chrome.tabs.query, originalScripting=chrome.scripting;
    const script={matches:['*://*.chaoxing.com/*'],js:['content/homework/panel.js','content/homework/content.js']};
    const injected=[];
    chrome.runtime.getManifest=()=>({version:'0.9.4',content_scripts:[script]});
    chrome.tabs.query=async spec=>{assert.deepEqual(spec.url,script.matches);return [{id:10,url:'https://mooc1.chaoxing.com/work',status:'complete'},{id:11,url:'https://mooc1.chaoxing.com/work',status:'complete'}];};
    chrome.scripting={executeScript:async spec=>{
      if(spec.func)return [{result:spec.target.tabId===11}];
      assert.deepEqual(spec.files,script.js);assert.equal(spec.target.allFrames,true);injected.push(spec.target.tabId);return [];
    }};
    try { await installed();await startup();assert.deepEqual(injected,[10,10]); }
    finally {chrome.runtime.getManifest=originalManifest;chrome.tabs.query=originalQuery;chrome.scripting=originalScripting;}
  });
  await test('豆包分屏只接受超星来源，旧浏览器返回可操作的手动分屏提示', async () => {
    const unsupported = await call('HW_BRIDGE_SPLIT', {}, 'https://mooc1.chaoxing.com/work');
    assert.equal(unsupported.ok, false); assert.match(unsupported.error, /不支持一键分屏/);
    const outside = await call('HW_BRIDGE_SPLIT', {}, 'https://example.invalid/');
    assert.equal(outside.ok, false); assert.match(outside.error, /超星作业页面/);
  });
  await test('个人中心跨域课程清单逐框读取并去重，不接受非超星页面', async () => {
    const original = chrome.scripting;
    let calls = 0;
    chrome.scripting = { executeScript: async spec => {
      calls++;
      assert.equal(spec.target.tabId, 31); assert.equal(spec.target.allFrames, true);
      return [{ result: [{ key: '1|2', total: null }] }, { result: [{ key: '1|2', done: 3, total: 5 }, { key: '4|5', done: 0, total: 10 }] }];
    } };
    try {
      const result = await call('HW_WATCH_COURSES', {}, 'https://i.mooc.chaoxing.com/space/index');
      assert.equal(result.ok, true); assert.equal(result.courses.length, 2);
      assert.equal(result.courses[0].total, 5);
      assert.equal((await call('HW_WATCH_COURSES', {}, 'https://i.chaoxing.com/base?ws=1')).courses.length, 2);
      assert.equal((await call('HW_WATCH_COURSES', {}, 'https://example.invalid/')).ok, false);
      assert.equal(calls, 2);
      const { readFile } = await import('node:fs/promises');
      const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
      assert.equal(manifest.content_scripts[0].all_frames, true);
      assert.match(await readFile(new URL('../content/homework/content.js', import.meta.url), 'utf8'), /window.top !== window.self/);
    } finally { chrome.scripting = original; }
  });
  await test('手动刷新空清单会补加载内层读取脚本再读取，正常清单不重复注入', async () => {
    const original = chrome.scripting;let loaded=false;const calls=[];
    chrome.scripting={executeScript:async spec=>{
      assert.equal(spec.target.tabId,31);assert.equal(spec.target.allFrames,true);
      if(spec.files){calls.push('inject');assert.deepEqual(spec.files,['content/course/watch.js']);loaded=true;return[];}
      calls.push('read');return[{frameId:1,result:loaded?[{key:'1|2',name:'课程一'}]:[]}];
    }};
    try{
      assert.equal((await call('HW_WATCH_COURSES',{},'https://i.chaoxing.com/base?ws=1&t=1792814483878')).courses.length,0);
      assert.equal((await call('HW_WATCH_COURSES',{refresh:true},'https://i.chaoxing.com/base?ws=1&t=1792814489999')).courses.length,1);
      assert.deepEqual(calls,['read','read','inject','read']);
      await call('HW_WATCH_COURSES',{refresh:true},'https://i.chaoxing.com/base');assert.equal(calls.filter(x=>x==='inject').length,1);
    }finally{chrome.scripting=original;}
  });
  await test('课程访问缺权限时不扫描，授权只申请超星，拒绝和异常均可见，自动扫描不弹窗', async () => {
    const permissions=chrome.permissions,scripting=chrome.scripting;let granted=false,requests=0,scans=0;
    chrome.permissions={contains:async()=>granted,request:async spec=>{requests++;assert.deepEqual(spec,{origins:['https://*.chaoxing.com/*']});return granted;}};
    chrome.scripting={executeScript:async()=>{scans++;return[{result:[]}];}};
    try{
      assert.equal((await call('HW_WATCH_COURSES',{},'https://i.chaoxing.com/base')).needsPermission,true);assert.equal(scans,0);assert.equal(requests,0);
      const denied=await call('HW_WATCH_ACCESS_REQUEST',{},'https://i.chaoxing.com/base');assert.equal(denied.ok,false);assert.equal(denied.needsPermission,true);
      granted=true;assert.equal((await call('HW_WATCH_ACCESS_REQUEST',{},'https://i.chaoxing.com/base')).ok,true);
      assert.equal((await call('HW_WATCH_COURSES',{},'https://i.chaoxing.com/base')).ok,true);assert.equal(scans,1);
      assert.equal((await call('HW_WATCH_ACCESS_REQUEST',{},'https://example.invalid')).ok,false);assert.equal(requests,2);
      chrome.permissions.request=()=>{throw Error('user gesture unavailable');};
      assert.match((await call('HW_WATCH_ACCESS_REQUEST',{},'https://i.chaoxing.com/base')).error,/站点访问设置/);
    }finally{chrome.permissions=permissions;chrome.scripting=scripting;}
  });
  await test('异常独立保存，超过旧上限后保留全部历史，并完整导出', async () => {
    assert.deepEqual((await call('HW_ISSUE_LIST')).issues, []);
    store.config.api.apiKey = 'fixture-secret-key';
    const issue = { stage: '识题失败', message: '失败 fixture-secret-key https://example.invalid/a?token=SECRET', chapter: '17.1', question: '测试题' };
    await Promise.all([call('HW_ISSUE_ADD', issue), call('HW_ISSUE_ADD', issue)]);
    const rows = (await call('HW_ISSUE_LIST')).issues;
    assert.equal(rows.length, 2);
    assert.ok(!JSON.stringify(rows).includes('fixture-secret-key'));
    assert.ok(!JSON.stringify(rows).includes('token=SECRET'));
    assert.ok(!rows[0].url.includes('?'));
    await Promise.all(Array.from({ length: 1500 }, (_, i) => call('HW_ISSUE_ADD', { stage: '测试异常', message: '问题' + i })));
    const first = await call('HW_ISSUE_LIST');
    assert.equal(first.total, 1502); assert.equal(first.issues.length, 50);
    const last = await call('HW_ISSUE_LIST', { offset: 1500, limit: 50 });
    assert.equal(last.total, 1502); assert.equal(last.issues.length, 2);
    assert.ok(last.issues.every(row => !first.issues.some(other => other.id === row.id)));
    const { exportIssueHistory } = await import('../background/issue-history.js');
    const exported = JSON.parse(await (await exportIssueHistory('test')).blob.text());
    assert.equal(exported.issues.length, 1502);
    assert.ok(rows.every(old => exported.issues.some(row => row.id === old.id)));
    await call('HW_ISSUE_CLEAR');
    assert.deepEqual((await call('HW_ISSUE_LIST')).issues, []);
    store.config.api.apiKey = 'test-key';
  });
  await test('旧数组迁移可重复执行，历史记录和原始计数保留', async () => {
    store.issueLog = [{ at: '2026-10-20T00:00:00.000Z', stage: '旧问题', message: '历史不能丢', count: 3 }];
    const a = await import('../background/issue-history.js?migration-a');
    const b = await import('../background/issue-history.js?migration-b');
    await Promise.all([a.migrateIssueHistory(), b.migrateIssueHistory()]);
    const result = await call('HW_ISSUE_LIST');
    assert.equal(result.total, 1); assert.equal(result.issues[0].count, 3);
    assert.ok(store.issueLog.length === 1, '迁移擅自删除了旧备份');
    await call('HW_ISSUE_CLEAR');
  });
  await test('写入失败明确报告，已有历史不被删除或覆盖', async () => {
    await call('HW_ISSUE_ADD', { stage: '异常', message: '已保存的历史' });
    const before = Object.keys(store).filter(k => k.startsWith('issue:'));
    const originalSet = chrome.storage.local.set;
    chrome.storage.local.set = async value => {
      if (Object.keys(value).some(k => k.startsWith('issue:'))) throw new Error('模拟磁盘写入失败');
      return originalSet(value);
    };
    try {
      const result = await call('HW_ISSUE_ADD', { stage: '异常', message: '应明确失败' });
      assert.equal(result.ok, false); assert.match(result.error, /写入失败/);
      assert.deepEqual(Object.keys(store).filter(k => k.startsWith('issue:')), before);
    } finally { chrome.storage.local.set = originalSet; }
    await call('HW_ISSUE_CLEAR');
  });
  await test('在当前学习页启动课程不退出重进，其他课程仍正常导航', async () => {
    const originalUpdate = chrome.tabs.update;
    const updates = [];
    chrome.tabs.update = async (id, options) => { updates.push({ id, options }); };
    const courses = [{ key: '1|2', scUrl: 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse?courseid=1&clazzid=2' }];
    try {
      const url = 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=1&clazzid=2&chapterId=3';
      assert.equal((await call('HW_WATCH_START', { courses }, url)).inPlace, true);
      assert.equal(updates.length, 0);
      assert.equal((await call('HW_WATCH_QUEUE_GET', {}, url)).queue.courses[0].key, '1|2');
      assert.equal((await call('HW_WATCH_START', { courses }, url.replace('courseId=1', 'courseId=9'))).inPlace, false);
      assert.equal(updates[0].options.url, courses[0].scUrl);
      await call('HW_WATCH_STOP');
    } finally { chrome.tabs.update = originalUpdate; }
  });
  await test('测验重做次数串行持久化，重复与并发登记只允许一次，刷新后仍保留', async () => {
    const originalGet = chrome.storage.local.get, originalSet = chrome.storage.local.set;
    chrome.storage.local.get = async key => structuredClone(await originalGet(key));
    try {
    const url = 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=1&clazzid=2&chapterId=3';
    const courses = [{ key: '1|2', scUrl: url }];
    await call('HW_WATCH_START', { courses }, url);
    const payload = { key: '1|2', chapterId: '3' };
    const claims = await Promise.all([call('HW_WATCH_QUIZ_RETRY', payload, url), call('HW_WATCH_QUIZ_RETRY', payload, url)]);
    assert.equal(claims.filter(r => r.first).length, 1);
    assert.equal((await call('HW_WATCH_QUIZ_RETRY', payload, url)).first, false);
    assert.equal((await call('HW_WATCH_QUIZ_RETRY', { ...payload, quizId: 'new-work-id' }, url)).first, false, '旧版已登记的章节重做不能因新版任务ID重新触发');
    assert.deepEqual((await call('HW_WATCH_QUEUE_GET', {}, url)).queue.courses[0].quizRetries, ['3']);
    assert.equal((await call('HW_WATCH_QUIZ_RETRY', { ...payload, key: 'wrong' }, url)).ok, false);
    const outsider = await new Promise(resolve => handler({ type: 'HW_WATCH_QUIZ_RETRY', payload }, { url, tab: { id: 32, url } }, resolve));
    assert.equal(outsider.ok, false);
    chrome.storage.local.set = async value => { if (value.watchQueue) throw Error('重做次数写入失败'); return originalSet(value); };
    assert.equal((await call('HW_WATCH_QUIZ_RETRY', { ...payload, chapterId: '4' }, url)).ok, false);
    chrome.storage.local.set = originalSet;
    assert.deepEqual((await call('HW_WATCH_QUEUE_GET', {}, url)).queue.courses[0].quizRetries, ['3']);
    await call('HW_WATCH_STOP');
    assert.equal((await call('HW_WATCH_QUIZ_RETRY', { ...payload, chapterId: '4' }, url)).ok, false);
    } finally { chrome.storage.local.get = originalGet; chrome.storage.local.set = originalSet; }
  });
  await test('同章多份测验各有一次重做机会，重复登记仍被拒绝', async () => {
    const url = 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=1&clazzid=2';
    await call('HW_WATCH_START', { courses: [{ key: '1|2', scUrl: url }] }, url);
    try {
      const payload = { key: '1|2', chapterId: '3' };
      for (const quizId of ['work-one', 'work-two']) {
        assert.equal((await call('HW_WATCH_QUIZ_RETRY', { ...payload, quizId }, url)).first, true);
        assert.equal((await call('HW_WATCH_QUIZ_RETRY', { ...payload, quizId }, url)).first, false);
      }
      assert.equal((await call('HW_WATCH_QUIZ_RETRY', { ...payload, quizId: '../invalid' }, url)).ok, false);
      assert.deepEqual((await call('HW_WATCH_QUEUE_GET', {}, url)).queue.courses[0].quizRetries, ['3:work-one', '3:work-two']);
    } finally { await call('HW_WATCH_STOP'); }
  });
  await test('原生章节地址保留stuenc，仅当前队列属主可打开同一课程目录', async () => {
    const original = chrome.tabs.update, updates = [];
    chrome.tabs.update = async (id, options) => { updates.push({ id, ...options }); };
    try {
      await call('HW_WATCH_START', { courses: [{ key: '1|2', scUrl: 'https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=1&clazzid=2' }] }, 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=1&clazzid=2');
      const url = 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse?courseid=1&clazzid=2&stuenc=fixture-session';
      assert.equal((await call('HW_WATCH_OPEN_CATALOG', { url })).ok, true);
      assert.equal(updates[0].url, url);
      for (const invalid of [url.replace('courseid=1', 'courseid=9'), url.replace('mooc2-ans.chaoxing.com', 'example.invalid')]) assert.equal((await call('HW_WATCH_OPEN_CATALOG', { url: invalid })).ok, false);
      const foreign = await new Promise(resolve => handler({ type: 'HW_WATCH_OPEN_CATALOG', payload: { url } }, { url: 'https://mooc1.chaoxing.com/', tab: { id: 32 } }, resolve));
      assert.equal(foreign.ok, false); assert.equal(updates.length, 1);
    } finally { await call('HW_WATCH_STOP'); chrome.tabs.update = original; }
  });
  await test('断开的课程切换只重开队列当前课程，不改索引或清除暂停', async () => {
    const original=chrome.tabs.update,updates=[];
    const url='https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=1&clazzid=2&cpi=3';
    chrome.tabs.update=async(id,options)=>updates.push({id,...options});
    try{
      await call('HW_WATCH_START',{courses:[{key:'1|2',scUrl:url}]});updates.length=0;
      assert.equal((await call('HW_WATCH_REOPEN',{key:'1|2'})).ok,true);
      assert.equal(updates[0].url,url);
      assert.equal((await call('HW_WATCH_QUEUE_GET')).queue.index,0);
      assert.equal((await call('HW_WATCH_REOPEN',{key:'wrong'})).ok,false);
      const foreign=await new Promise(resolve=>handler({type:'HW_WATCH_REOPEN',payload:{key:'1|2'}},{url,tab:{id:32,url}},resolve));
      assert.equal(foreign.ok,false);
      store.watchQueue.courses[0].scUrl='https://example.invalid/?courseid=1&clazzid=2';
      assert.equal((await call('HW_WATCH_REOPEN',{key:'1|2'})).ok,false);
      store.watchQueue.courses[0].scUrl=url;
      await call('HW_WATCH_PAUSE',{reason:'需要人脸验证'});
      assert.equal((await call('HW_WATCH_REOPEN',{key:'1|2'})).ok,false);
      assert.equal((await call('HW_WATCH_QUEUE_GET')).queue.paused,'需要人脸验证');
      assert.equal(updates.length,1);
      await call('HW_WATCH_RESUME');
      const originalContains=chrome.permissions.contains;
      try{
        chrome.permissions.contains=async()=>{store.watchQueue.paused='授权检查期间人工停止';return true;};
        assert.equal((await call('HW_WATCH_REOPEN',{key:'1|2'})).ok,false);
        assert.equal(updates.length,1);
      }finally{chrome.permissions.contains=originalContains;}
    }finally{await call('HW_WATCH_STOP');chrome.tabs.update=original;}
  });
  await test('静音选项保存配置，并只切换发起操作的标签页声音', async () => {
    const updates = [];
    const originalUpdate = chrome.tabs.update;
    chrome.tabs.update = async (tabId, options) => { updates.push({ tabId, options }); };
    try {
      assert.equal((await call('SET_CONFIG', { watchMuted: true })).ok, true);
      assert.equal(store.config.watchMuted, true);
      assert.equal((await call('SET_CONFIG', { watchMuted: false })).ok, true);
      assert.equal(store.config.watchMuted, false);
      assert.deepEqual(updates, [{ tabId: 31, options: { muted: true } }, { tabId: 31, options: { muted: false } }]);
    } finally { chrome.tabs.update = originalUpdate; }
  });
  await test('后台识题消息只接受超星页面，按当前引擎路由并发送批次进度', async () => {
    assert.equal((await call('HW_DETECT_QUESTIONS', { batches: ['资料'] }, 'https://example.invalid')).ok, false);
    globalThis.fetch = async () => success(raw);
    const api = await call('HW_DETECT_QUESTIONS', { requestId: 1, batches: ['一', '二'] });
    assert.equal(api.questions.length, 2);
    assert.equal(sentMessages.filter((m) => m.type === 'HW_DETECT_PROGRESS' && m.payload.requestId === 1).length, 2);
    store.config = { engine: 'bridge', bridge: {} };
    assert.equal((await call('HW_DETECT_QUESTIONS', { batches: ['资料'] })).questions.length, 1);
    store.config = { engine: 'api', api: cfg };
  });
  await test('豆包识题遇到验证同样发送处理通知，不要求用户一直盯网页', async () => {
    const originalSend = chrome.tabs.sendMessage, originalNotify = chrome.notifications.create;
    const notices = [];
    store.config = { engine: 'bridge', bridge: {} };
    chrome.notifications.create = (...args) => notices.push(args);
    chrome.tabs.sendMessage = async (_, message) => message.type === 'BRIDGE_PING'
      ? { ok: true, ready: true } : message.type === 'BRIDGE_ASK' ? { ok: false, error: '需要验证' } : {};
    try {
      const result = await call('HW_DETECT_QUESTIONS', { batches: ['题目资料'] });
      assert.equal(result.ok, false);
      assert.ok(notices.some(args => args[0] === 'hw-doubao-attention'));
    } finally { chrome.tabs.sendMessage = originalSend; chrome.notifications.create = originalNotify; store.config = { engine: 'api', api: cfg }; }
  });
  await test('后台重复检测被拒绝，取消后不继续下一批且释放检测状态', async () => {
    let release;
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Promise((resolve) => { release = resolve; }); };
    const first = call('HW_DETECT_QUESTIONS', { batches: ['一', '二'] });
    await new Promise((r) => originalTimeout(r, 0));
    assert.equal((await call('HW_DETECT_QUESTIONS', { batches: ['重复'] })).ok, false);
    await call('HW_STOP');
    release(success(raw));
    assert.match((await first).error, /取消/);
    assert.equal(calls, 1);
    globalThis.fetch = async () => success(raw);
    assert.equal((await call('HW_DETECT_QUESTIONS', { batches: ['重新检测'] })).ok, true);
  });
  await test('停止旧答题后迟到的答案不会写回新检测的题目', async () => {
    let release;
    globalThis.fetch = async () => new Promise((resolve) => { release = resolve; });
    await call('HW_START', { questions: [{ type: 'choice', stem: '旧题' }] });
    for (let i = 0; i < 20 && !release; i++) await new Promise((r) => originalTimeout(r, 0));
    assert.ok(release);
    await call('HW_STOP');
    const count = sentMessages.filter((m) => m.type === 'HW_ANSWER').length;
    release(success('A'));
    await new Promise((r) => originalTimeout(r, 10));
    assert.equal(sentMessages.filter((m) => m.type === 'HW_ANSWER').length, count);
  });
  await test('刷课无法确定的题猜选兜底，等待回执后继续后续题', async () => {
    const before = sentMessages.length;
    let calls = 0;
    globalThis.fetch = async () => success(++calls === 1 ? '{"answers":[]}' : '{"answers":["乙"]}');
    await call('HW_START', { auto: true, questions: ['无法确定答案时的回归题', '后续可解题'].map(stem => ({ type: 'choice', stem, options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }] })) });
    for (let i = 0; i < 200 && !sentMessages.slice(before).some(m => m.type === 'HW_ANSWER'); i++) await new Promise(r => originalTimeout(r, 5));
    const answer = sentMessages.slice(before).find(m => m.type === 'HW_ANSWER');
    assert.ok(answer && !sentMessages.slice(before).some(m => m.type === 'HW_DONE'), '必须等页面填写回执');
    assert.equal(answer.payload.index,0);
    assert.ok(['A','B'].includes(answer.payload.answer));
    assert.equal(answer.payload.fallback,true);
    await call('HW_FILLED', { index: answer.payload.index, fillToken: answer.payload.fillToken, ok: true });
    for (let i = 0; i < 200 && sentMessages.slice(before).filter(m => m.type === 'HW_ANSWER').length<2; i++) await new Promise(r => originalTimeout(r, 5));
    const next=sentMessages.slice(before).filter(m=>m.type==='HW_ANSWER')[1];
    assert.equal(next.payload.index,1);
    assert.equal(next.payload.answer,'B');
    await call('HW_FILLED',{index:next.payload.index,fillToken:next.payload.fillToken,ok:true});
    for (let i = 0; i < 200 && !sentMessages.slice(before).some(m => m.type === 'HW_DONE'); i++) await new Promise(r => originalTimeout(r, 5));
    assert.equal(sentMessages.slice(before).filter(m => m.type === 'HW_ANSWER').length, 2);
    assert.ok(sentMessages.slice(before).some(m => m.type === 'HW_DONE' && !m.payload.paused));
    const done = sentMessages.slice(before).find(m => m.type === 'HW_DONE');
    assert.equal(done.payload.failed, 0); assert.equal(done.payload.filled, 2);
  });
  console.log(`\n${passed} groups passed (mock transports, no external requests).`);
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalTimeout;
}
