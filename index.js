// server.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import __dirname from './lib/__dirname.js';
import serve_file from './lib/serve_file.js'
import file_exists from './lib/file_exists.js';
import safe_resolve from './lib/safe_resolve.js';

const server = http.createServer(async (req, res) => {

  // SERVER FUNCTIONS
  // ------------------------------------------------------------------------------------------------- //
  switch(req.url) {
    case '/':
      console.log('came home');
      break;
    case '/other':
      console.log('other');
      break;
    default:
      console.log('invalid api route');
  }
  // ------------------------------------------------------------------------------------------------- //
  // END SERVER FUNCTIONS

  // STATIC ASSETS
  // ------------------------------------------------------------------------------------------------- //
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
      serve_file(res, filePath);
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
      serve_file(res, filePath);
      return;
    }
  }
  // ------------------------------------------------------------------------------------------------- //
  // END STATIC ASSETS

  res.writeHead(404);
  res.end('Not found');
});

server.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});