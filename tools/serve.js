/**
 * serve.js — 零依赖静态服务器，用来托管 mock.html
 *
 * 用法： node tools/serve.js [port]
 * 然后浏览器打开 http://127.0.0.1:8899/
 *
 * 为什么需要它：Chrome 扩展的 content_scripts 匹配 http(s) 协议，
 * file:// 需要额外打开「允许访问文件网址」开关，本地 http 更省事。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]) || 8899;
// 服务整个项目根目录，这样 mock 页能 fetch 到 src/stealth/main-world.js 做手动注入诊断
const ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/' || rel === '') rel = '/tools/mock.html';

  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));

  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  知到自动助手 — 本地模拟页已启动');
  console.log('  →  http://127.0.0.1:' + PORT + '/');
  console.log('');
  console.log('  按 Ctrl+C 停止');
  console.log('');
});
