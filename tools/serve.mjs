/* 零依赖静态服务器：node tools/serve.mjs [端口]，默认 8000。
   用于本地打开 test/mock-homework.html 测试插件。 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.argv[2]) || 8000;
const root = process.cwd();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

http
  .createServer((req, res) => {
    let p;
    try {
      p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      p = '/';
    }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end('403');
      return;
    }
    fs.readFile(file, (e, d) => {
      if (e) {
        res.writeHead(404);
        res.end('404 ' + p);
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(d);
    });
  })
  .listen(port, () => console.log(`[serve] ${root} → http://localhost:${port}/test/mock-homework.html`));
