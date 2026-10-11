/* Chrome 原生消息宿主：浏览器通过 stdin/stdout 与本进程通信（4 字节小端长度前缀 + UTF-8 JSON）。
   职责单一：收到 {type:'run_update'} → 调用 tools/autoupdate.mjs 的 syncOnce 同步一轮 → 回传结果。
   只允许扩展访问（install-native-host.mjs 写入注册表 allowed_origins），不监听端口、不接受其他输入。 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const AUTOUPDATE = path.join(HERE, 'autoupdate.mjs');

function send(obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  process.stdout.write(Buffer.concat([Buffer.from([buf.length & 255, (buf.length >> 8) & 255, (buf.length >> 16) & 255, (buf.length >> 24) & 255]), buf]));
}
const readMessage = () => new Promise((resolve) => {
  let len = null;
  const onData = (chunk) => {
    let rest = len === null ? chunk : Buffer.concat([pending, chunk]);
    while (rest.length >= 4) {
      if (len === null) len = rest.readUInt32LE(0);
      if (rest.length - 4 < len) break;
      const body = rest.subarray(4, 4 + len);
      rest = rest.subarray(4 + len);
      len = null;
      resolve(JSON.parse(body.toString('utf8')));
      process.stdin.removeListener('data', onData);
      return;
    }
    pending = rest;
  };
  let pending = Buffer.alloc(0);
  process.stdin.on('data', onData);
  process.stdin.once('end', () => { if (len !== null || pending.length) { resolve(null); process.stdin.removeListener('data', onData); } });
  setTimeout(() => { resolve(null); process.stdin.removeListener('data', onData); }, 60000); // 60 秒无请求自行退出
});

const msg = await readMessage();
if (!msg || msg.type !== 'run_update') {
  send({ ok: false, error: '无效请求' });
  process.exit(1);
}
/* 插件目录由宿主自己定位（本文件与 exe 都在插件根的 tools/ 下）：不碰请求里的路径，
   换电脑、换目录都不用改代码，插件侧也就不必知道自己在磁盘上的位置 */
if (!fs.existsSync(path.join(ROOT, 'manifest.json'))) {
  send({ ok: false, error: '插件目录不是有效根目录（缺 manifest.json）：' + ROOT });
  process.exit(1);
}
try {
  const mod = await import(url.pathToFileURL(AUTOUPDATE).href);
  const r = await mod.syncOnce({ root: ROOT, log: () => {} }); // 日志走文件，管道只传协议消息
  send({ ok: r.ok, updated: r.updated, current: r.current, latest: r.latest, error: r.error });
} catch (e) {
  send({ ok: false, error: String(e.message || e) });
}
process.exit(0);
