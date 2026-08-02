// server.js
// Node.js Utils
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// Custom Utils
import safe_resolve from '../path/safe_resolve.js';
import __dirname from '../path/__dirname.js';
import file_serve from '../fs/file_serve.js'
import file_exists from '../fs/file_exists.js';

// Custom Functions
import hello_world from '../../func/hello-world.js';

// Server Routes
const routes = [
  { url: '/', func: hello_world },
  { url: '/other', func: hello_world }
]

// Server Initialization
const server = http.createServer(async (req, res) => {

  routes.forEach(route => {
    if (route.url === req.url) {
      const handler = route.func;
      if (handler) handler(req, res);
      else console.log('invalid url: '+ req.url);
    }
  });

  const parsed = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(parsed.pathname);

  // Redirect *.html -> clean URL (only for HTML; other assets keep their extension)
  if (pathname.endsWith('.html')) {
    let clean = pathname.slice(0, -5);
    if (path.basename(clean) === 'index') {
      clean = path.dirname(clean) + '/';
    }
    res.writeHead(301, { Location: clean + parsed.search });
    res.end();
    return;
  }

  // If the request has a non-html extension (.css, .js, .png, etc), serve it directly
  const ext = path.extname(pathname);
  if (ext && ext !== '.html') {
    const filePath = safe_resolve('.' + pathname);
    if (!filePath) {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }
    if (await file_exists(filePath)) {
      file_serve(res, filePath);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  // No extension: try directory-style index, then flat .html file
  const indexCandidate = safe_resolve('.' + pathname, 'index.html');
  const flatCandidate = safe_resolve('.' + pathname + '.html');
  const candidates = [indexCandidate, flatCandidate].filter(Boolean);

  if (candidates.length === 0) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  
  for (const filePath of candidates) {
    if (await file_exists(filePath)) {
      file_serve(res, filePath);
      return;
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});