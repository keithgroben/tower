/**
 * Zero-dependency static server. ES modules will not load over file://, so the
 * playable needs a server — but adding a dependency to run a prototype is how
 * prototypes stop getting run. Usage: node harness/serve.js [port]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 5173);

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, url === '/' ? 'index.html' : url);

  // Never serve outside the repo, even if the path tries to climb out.
  if (!file.startsWith(root)) { res.writeHead(403).end('nope'); return; }

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found: ' + url); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}).listen(port, () => {
  console.log('lift  ->  http://localhost:' + port);
});
