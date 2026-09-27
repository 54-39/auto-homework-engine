/* 用法: node tools/cdp-eval.mjs "表达式" | --file 文件；TAB_URL=子串 选页签，DW_TAB=n 第几个 */
import fs from 'node:fs';

const argFile = process.argv[2] === '--file' ? process.argv[3] : null;
const expr = argFile ? fs.readFileSync(argFile, 'utf8') : process.argv[2];
const pages = await (await fetch('http://127.0.0.1:9222/json')).json();
const sub = process.env.TAB_URL || 'dowork';
const cands = pages.filter((t) => t.type === 'page' && t.url.includes(sub));
const tab = cands[Number(process.env.DW_TAB || 0)];
if (!tab) {
  console.error('未找到页签', sub, '现有:', pages.filter((t) => t.type === 'page').map((t) => t.url.slice(0, 60)));
  process.exit(1);
}
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id = 0;
const send = (method, params) => new Promise((res, rej) => {
  const mid = ++id;
  const onMsg = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === mid) {
      ws.removeEventListener('message', onMsg);
      m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 200))) : res(m.result);
    }
  };
  ws.addEventListener('message', onMsg);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
await new Promise((res) => (ws.onopen = res));
await send('Runtime.enable');
await send('Page.enable');
const tree = await send('Page.getFrameTree');
const world = await send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'hw-debug' });
const result = await send('Runtime.evaluate', {
  expression: expr, contextId: world.executionContextId, returnByValue: true, awaitPromise: true, userGesture: true,
});
if (result.exceptionDetails) {
  console.log(JSON.stringify({ EXCEPTION: result.exceptionDetails.exception?.description || result.exceptionDetails.text }, null, 1));
} else {
  console.log(JSON.stringify(result.result.value, null, 1));
}
ws.close();
