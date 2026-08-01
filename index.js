// server.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicDir = path.join(__dirname, 'public');
const publicDirResolved = path.resolve(publicDir);

// Extend this as needed
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
};

const DEFAULT_MIME = 'application/octet-stream';

function getMimeType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || DEFAULT_MIME;
}

function safeResolve(...segments) {
  const resolved = path.resolve(publicDir, ...segments);
  if (resolved !== publicDirResolved && !resolved.startsWith(publicDirResolved + path.sep)) {
    return null;
  }
  return resolved;
}

function fileExists(p) {
  return new Promise((resolve) => {
    fs.access(p, fs.constants.F_OK, (err) => resolve(!err));
  });
}

function serveFile(res, filePath) {
  const stream = fs.createReadStream(filePath);
  res.writeHead(200, { 'Content-Type': getMimeType(filePath) });
  stream.pipe(res);
  stream.on('error', () => {
    res.writeHead(500);
    res.end('Server error');
  });
}

const server = http.createServer(async (req, res) => {
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
    const filePath = safeResolve('.' + pathname);
    if (!filePath) {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }
    if (await fileExists(filePath)) {
      serveFile(res, filePath);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  // No extension: try directory-style index, then flat .html file
  const indexCandidate = safeResolve('.' + pathname, 'index.html');
  const flatCandidate = safeResolve('.' + pathname + '.html');
  const candidates = [indexCandidate, flatCandidate].filter(Boolean);

  if (candidates.length === 0) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  for (const filePath of candidates) {
    if (await fileExists(filePath)) {
      serveFile(res, filePath);
      return;
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});