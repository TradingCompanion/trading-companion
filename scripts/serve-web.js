// Tiny static server for previewing web/ locally. The VRM is fetched, so file:// will not do.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'web');
const PORT = Number(process.env.PORT || 4173);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.vrm': 'application/octet-stream',
  '.mp3': 'audio/mpeg', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.zip': 'application/zip', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found: ' + url); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
});

// A preview server left running from earlier should not crash this one with a stack trace. If the
// port is taken, say whether it is already serving this site and move to the next free one.
const LAST = PORT + 10;
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  const busy = server.__port || PORT;
  if (busy === PORT) {
    http.get({ port: PORT, path: '/', timeout: 1500 }, (r) => {
      if (r.statusCode === 200) console.log('already serving web/ on http://localhost:' + PORT + ' — open that, or stop it to restart here');
      r.destroy();
      next(busy);
    }).on('error', () => next(busy)).on('timeout', function () { this.destroy(); next(busy); });
  } else next(busy);
});
function next(busy) {
  const p = busy + 1;
  if (p > LAST) { console.error('ports ' + PORT + '-' + LAST + ' are all in use; set PORT=… to choose another'); process.exit(1); }
  console.log('port ' + busy + ' is in use, trying ' + p + '…');
  listen(p);
}
function listen(p) { server.__port = p; server.listen(p); }
server.on('listening', () => console.log('web preview on http://localhost:' + (server.__port || PORT)));
listen(PORT);
